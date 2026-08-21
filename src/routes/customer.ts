import { Hono } from "hono";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { createCustomerSchema, updateCustomerSchema } from "../validators";
import { allocateDebtPayment } from "../lib/posMath";
import { sendPushNotificationDirect } from "../services/notification";

const customers = new Hono();
customers.use("*", authMiddleware);

const paymentSchema = z.object({
  amount: z.number().finite().positive("Nominal pembayaran harus lebih dari 0"),
  method: z.enum(["CASH", "BANK_TRANSFER", "E_WALLET", "CARD"]),
  note: z.string().trim().max(500).optional(),
});

const adjustmentSchema = z.object({
  amount: z.number().finite().refine((value) => value !== 0, "Penyesuaian tidak boleh 0"),
  note: z.string().trim().min(3).max(500),
});

function serializeCustomer<T extends Record<string, unknown>>(customer: T) {
  return {
    ...customer,
    debt: Number(customer.debt),
    maxDebt: customer.maxDebt == null ? null : Number(customer.maxDebt),
  };
}

customers.get("/", async (c) => {
  const { userId } = c.get("user");
  const search = c.req.query("search")?.trim() || "";
  const debtOnly = c.req.query("debtOnly") === "true";
  const includeArchived = c.req.query("includeArchived") === "true";
  const where = {
    userId,
    ...(includeArchived ? {} : { isActive: true }),
    ...(debtOnly ? { debt: { gt: 0 } } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { phone: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const list = await prisma.customer.findMany({ where, orderBy: [{ debt: "desc" }, { name: "asc" }] });
  return c.json({ customers: list.map(serializeCustomer) });
});

customers.get("/:id", async (c) => {
  const { userId } = c.get("user");
  const customer = await prisma.customer.findFirst({
    where: { id: c.req.param("id"), userId },
    include: {
      receivables: { orderBy: { createdAt: "desc" }, take: 100 },
      sales: {
        where: { status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, invoiceNumber: true, total: true, outstandingAmount: true, createdAt: true },
      },
    },
  });
  if (!customer) return c.json({ error: "Pelanggan tidak ditemukan" }, 404);
  return c.json({
    customer: {
      ...serializeCustomer(customer),
      receivables: customer.receivables.map((entry) => ({ ...entry, amount: Number(entry.amount) })),
      sales: customer.sales.map((sale) => ({
        ...sale,
        total: Number(sale.total),
        outstandingAmount: Number(sale.outstandingAmount),
      })),
    },
  });
});

customers.post("/", async (c) => {
  const { userId } = c.get("user");
  const parsed = createCustomerSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const customer = await prisma.customer.create({
    data: {
      userId,
      name: parsed.data.name.trim(),
      phone: parsed.data.phone || null,
      maxDebt: parsed.data.maxDebt ?? null,
      notes: parsed.data.notes || null,
    },
  });
  return c.json({ message: "Pelanggan berhasil ditambahkan", customer: serializeCustomer(customer) }, 201);
});

customers.put("/:id", async (c) => {
  const { userId } = c.get("user");
  const parsed = updateCustomerSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const existing = await prisma.customer.findFirst({ where: { id: c.req.param("id"), userId } });
  if (!existing) return c.json({ error: "Pelanggan tidak ditemukan" }, 404);
  const data = parsed.data;
  const customer = await prisma.customer.update({
    where: { id: existing.id },
    data: {
      name: data.name?.trim(),
      phone: data.phone === undefined ? undefined : data.phone || null,
      maxDebt: data.maxDebt,
      notes: data.notes === undefined ? undefined : data.notes || null,
      isActive: data.isActive,
    },
  });
  return c.json({ message: "Pelanggan berhasil diperbarui", customer: serializeCustomer(customer) });
});

customers.post("/:id/payments", async (c) => {
  const { userId } = c.get("user");
  const parsed = paymentSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);

  const [customer, session] = await Promise.all([
    prisma.customer.findFirst({ where: { id: c.req.param("id"), userId, isActive: true } }),
    prisma.registerSession.findFirst({ where: { userId, status: "OPEN" }, orderBy: { openedAt: "desc" } }),
  ]);
  if (!customer) return c.json({ error: "Pelanggan tidak ditemukan" }, 404);
  if (!session) return c.json({ error: "Buka shift kasir sebelum menerima pembayaran" }, 409);
  const currentDebt = Number(customer.debt);
  if (parsed.data.amount > currentDebt) {
    return c.json({ error: `Pembayaran melebihi kasbon aktif Rp${currentDebt.toLocaleString("id-ID")}` }, 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const openSales = await tx.sale.findMany({
      where: { userId, customerId: customer.id, status: "COMPLETED", outstandingAmount: { gt: 0 } },
      orderBy: { createdAt: "asc" },
    });
    const allocation = allocateDebtPayment(
      parsed.data.amount,
      openSales.map((sale) => ({ id: sale.id, outstanding: Number(sale.outstandingAmount) })),
    );
    for (const item of allocation.allocations) {
      const sale = openSales.find((candidate) => candidate.id === item.saleId)!;
      const allocated = item.amount;
      await tx.sale.update({
        where: { id: sale.id },
        data: {
          outstandingAmount: { decrement: allocated },
          paidAmount: { increment: allocated },
        },
      });
      await tx.salePayment.create({
        data: {
          saleId: sale.id,
          registerSessionId: session.id,
          method: parsed.data.method,
          amount: allocated,
          reference: parsed.data.note,
        },
      });
      await tx.receivableEntry.create({
        data: {
          userId,
          customerId: customer.id,
          saleId: sale.id,
          type: "PAYMENT",
          amount: -allocated,
          method: parsed.data.method,
          note: parsed.data.note || "Pembayaran kasbon",
        },
      });
    }
    if (allocation.remaining > 0.001) throw new Error("Alokasi pembayaran kasbon tidak konsisten");
    const updated = await tx.customer.update({
      where: { id: customer.id },
      data: { debt: { decrement: parsed.data.amount } },
    });
    await tx.notification.create({
      data: {
        userId,
        type: "POS_DEBT_PAYMENT",
        title: "Pembayaran kasbon diterima",
        body: `${customer.name} membayar Rp${parsed.data.amount.toLocaleString("id-ID")}. Sisa kasbon Rp${(currentDebt - parsed.data.amount).toLocaleString("id-ID")}.`,
        clickAction: "/dashboard/pos?tab=customers",
      },
    });
    return updated;
  });

  void sendPushNotificationDirect({
    userIds: [userId],
    type: "POS_DEBT_PAYMENT",
    title: "Pembayaran kasbon diterima",
    body: `${customer.name} membayar Rp${parsed.data.amount.toLocaleString("id-ID")}. Sisa kasbon Rp${Number(result.debt).toLocaleString("id-ID")}.`,
    clickAction: "/dashboard/pos?tab=customers",
  });

  return c.json({ message: "Pembayaran kasbon berhasil dicatat", customer: serializeCustomer(result) });
});

customers.post("/:id/adjustments", async (c) => {
  const { userId } = c.get("user");
  const parsed = adjustmentSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const existing = await prisma.customer.findFirst({ where: { id: c.req.param("id"), userId } });
  if (!existing) return c.json({ error: "Pelanggan tidak ditemukan" }, 404);
  const nextDebt = Number(existing.debt) + parsed.data.amount;
  if (nextDebt < 0) return c.json({ error: "Penyesuaian membuat kasbon menjadi negatif" }, 400);
  const customer = await prisma.$transaction(async (tx) => {
    const updated = await tx.customer.update({ where: { id: existing.id }, data: { debt: nextDebt } });
    await tx.receivableEntry.create({
      data: {
        userId,
        customerId: existing.id,
        type: "ADJUSTMENT",
        amount: parsed.data.amount,
        note: parsed.data.note,
      },
    });
    return updated;
  });
  return c.json({ message: "Kasbon berhasil disesuaikan", customer: serializeCustomer(customer) });
});

customers.delete("/:id", async (c) => {
  const { userId } = c.get("user");
  const existing = await prisma.customer.findFirst({ where: { id: c.req.param("id"), userId } });
  if (!existing) return c.json({ error: "Pelanggan tidak ditemukan" }, 404);
  if (Number(existing.debt) > 0) return c.json({ error: "Pelanggan dengan kasbon aktif tidak dapat diarsipkan" }, 409);
  await prisma.customer.update({ where: { id: existing.id }, data: { isActive: false } });
  return c.json({ message: "Pelanggan diarsipkan" });
});

export default customers;
