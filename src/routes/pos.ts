import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { createDateInTimeZone, getDateParts } from "../lib/timezone";
import { calculatePaymentSummary } from "../lib/posMath";
import { sendPushNotificationDirect } from "../services/notification";

const pos = new Hono();
pos.use("*", authMiddleware);

const paymentMethod = z.enum(["CASH", "BANK_TRANSFER", "E_WALLET", "CARD", "CREDIT"]);
const checkoutSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(160),
  customerId: z.string().trim().optional().nullable(),
  items: z.array(z.object({ productId: z.string().trim().min(1), quantity: z.number().finite().positive().max(1_000_000) })).min(1).max(100),
  payments: z.array(z.object({ method: paymentMethod, amount: z.number().finite().positive(), reference: z.string().trim().max(160).optional() })).min(1).max(5),
  discount: z.number().finite().nonnegative().default(0),
  taxPercent: z.number().finite().min(0).max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
});

const profileSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  address: z.string().trim().max(500).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  receiptFooter: z.string().trim().max(300).optional().nullable(),
  taxPercent: z.number().finite().min(0).max(100).default(0),
});

const openSessionSchema = z.object({ openingCash: z.number().finite().nonnegative().default(0), notes: z.string().trim().max(500).optional() });
const closeSessionSchema = z.object({ closingCash: z.number().finite().nonnegative(), notes: z.string().trim().max(500).optional() });
const voidSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const assistantSchema = z.object({ message: z.string().trim().min(2).max(500) });

const decimal = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);
const number = (value: Prisma.Decimal | number | null | undefined) => value == null ? 0 : Number(value);
const money = (value: number) => `Rp${Math.round(value).toLocaleString("id-ID")}`;

function serializeSale(sale: any) {
  return {
    ...sale,
    subtotal: number(sale.subtotal),
    discount: number(sale.discount),
    tax: number(sale.tax),
    total: number(sale.total),
    paidAmount: number(sale.paidAmount),
    creditAmount: number(sale.creditAmount),
    outstandingAmount: number(sale.outstandingAmount),
    changeAmount: number(sale.changeAmount),
    items: sale.items?.map((item: any) => ({
      ...item,
      quantity: number(item.quantity),
      unitPrice: number(item.unitPrice),
      unitCost: number(item.unitCost),
      subtotal: number(item.subtotal),
    })),
    payments: sale.payments?.map((payment: any) => ({ ...payment, amount: number(payment.amount) })),
  };
}

function localDayRange(tz: string, offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = getDateParts(now, tz);
  return {
    start: createDateInTimeZone(parts.year, parts.month, parts.day, 0, 0, 0, 0, tz),
    end: createDateInTimeZone(parts.year, parts.month, parts.day, 23, 59, 59, 999, tz),
  };
}

function invoiceNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `POS-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function parseCompactAmount(value: string) {
  const normalized = value.toLowerCase().replace(/\s/g, "");
  const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*(jt|juta|rb|ribu|k)?/);
  if (!match) return 0;
  const base = Number(match[1].replace(",", "."));
  const multiplier = match[2] === "jt" || match[2] === "juta" ? 1_000_000 : match[2] === "rb" || match[2] === "ribu" || match[2] === "k" ? 1_000 : 1;
  return Math.round(base * multiplier);
}

async function dashboardData(userId: string, tz: string) {
  const today = localDayRange(tz);
  const weekStart = localDayRange(tz, -6).start;
  const [todaySales, weekSales, lowStockRaw, totalDebt, recentSales, topItems, profile, session] = await Promise.all([
    prisma.sale.findMany({ where: { userId, status: "COMPLETED", createdAt: { gte: today.start, lte: today.end } }, include: { items: true } }),
    prisma.sale.findMany({ where: { userId, status: "COMPLETED", createdAt: { gte: weekStart, lte: today.end } }, select: { total: true, createdAt: true } }),
    prisma.product.findMany({ where: { userId, isActive: true }, orderBy: { stock: "asc" } }),
    prisma.customer.aggregate({ where: { userId, isActive: true }, _sum: { debt: true } }),
    prisma.sale.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 8, include: { customer: { select: { id: true, name: true } }, items: true, payments: true } }),
    prisma.saleItem.groupBy({
      by: ["productId", "productName"],
      where: { sale: { userId, status: "COMPLETED", createdAt: { gte: weekStart, lte: today.end } } },
      _sum: { quantity: true, subtotal: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 5,
    }),
    prisma.posProfile.findUnique({ where: { userId } }),
    prisma.registerSession.findFirst({ where: { userId, status: "OPEN" }, orderBy: { openedAt: "desc" } }),
  ]);

  let salesTotal = 0;
  let cashIn = 0;
  let grossProfit = 0;
  for (const sale of todaySales) {
    salesTotal += number(sale.total);
    cashIn += number(sale.paidAmount);
    for (const item of sale.items) grossProfit += (number(item.unitPrice) - number(item.unitCost)) * number(item.quantity);
    grossProfit -= number(sale.discount);
  }

  const salesByDay = new Map<string, number>();
  for (let offset = -6; offset <= 0; offset += 1) {
    const range = localDayRange(tz, offset);
    const parts = getDateParts(range.start, tz);
    salesByDay.set(`${parts.year}-${parts.month + 1}-${parts.day}`, 0);
  }
  for (const sale of weekSales) {
    const parts = getDateParts(sale.createdAt, tz);
    const key = `${parts.year}-${parts.month + 1}-${parts.day}`;
    salesByDay.set(key, (salesByDay.get(key) || 0) + number(sale.total));
  }

  return {
    profile: profile ? { ...profile, taxPercent: number(profile.taxPercent) } : null,
    session: session ? { ...session, openingCash: number(session.openingCash), expectedCash: number(session.expectedCash), closingCash: number(session.closingCash) } : null,
    metrics: { salesTotal, cashIn, transactionCount: todaySales.length, totalDebt: number(totalDebt._sum.debt), grossProfit },
    salesChart: [...salesByDay.entries()].map(([date, total]) => ({ date, total })),
    lowStock: lowStockRaw.filter((product) => number(product.stock) <= number(product.minStock)).slice(0, 8).map((product) => ({ id: product.id, name: product.name, stock: number(product.stock), minStock: number(product.minStock), unit: product.unit })),
    recentSales: recentSales.map(serializeSale),
    topItems: topItems.map((item) => ({ productId: item.productId, name: item.productName, quantity: number(item._sum.quantity), revenue: number(item._sum.subtotal) })),
  };
}

pos.get("/dashboard", async (c) => {
  const { userId } = c.get("user");
  return c.json(await dashboardData(userId, c.req.header("x-timezone") || "Asia/Jakarta"));
});

pos.get("/report", async (c) => {
  const { userId } = c.get("user");
  const period = z.enum(["day", "week", "month"]).catch("day").parse(c.req.query("period"));
  const tz = c.req.header("x-timezone") || "Asia/Jakarta";
  const today = localDayRange(tz);
  const currentParts = getDateParts(today.start, tz);
  const start = period === "day"
    ? today.start
    : period === "week"
      ? localDayRange(tz, -6).start
      : createDateInTimeZone(currentParts.year, currentParts.month, 1, 0, 0, 0, 0, tz);

  const [sales, cashPayments, totalDebt] = await Promise.all([
    prisma.sale.findMany({
      where: { userId, status: "COMPLETED", createdAt: { gte: start, lte: today.end } },
      orderBy: { createdAt: "desc" },
      include: { customer: { select: { id: true, name: true } }, items: true, payments: true },
    }),
    prisma.salePayment.aggregate({
      where: { sale: { userId }, method: { not: "CREDIT" }, createdAt: { gte: start, lte: today.end } },
      _sum: { amount: true },
    }),
    prisma.customer.aggregate({ where: { userId, isActive: true }, _sum: { debt: true } }),
  ]);

  let revenue = 0;
  let cost = 0;
  let discount = 0;
  let tax = 0;
  let credit = 0;
  const itemTotals = new Map<string, { productId: string | null; name: string; quantity: number; revenue: number }>();
  for (const sale of sales) {
    revenue += number(sale.total);
    discount += number(sale.discount);
    tax += number(sale.tax);
    credit += number(sale.creditAmount);
    for (const item of sale.items) {
      const quantity = number(item.quantity);
      cost += number(item.unitCost) * quantity;
      const key = item.productId || item.productName;
      const aggregate = itemTotals.get(key) || { productId: item.productId, name: item.productName, quantity: 0, revenue: 0 };
      aggregate.quantity += quantity;
      aggregate.revenue += number(item.subtotal);
      itemTotals.set(key, aggregate);
    }
  }

  return c.json({
    period,
    range: { start: start.toISOString(), end: today.end.toISOString() },
    metrics: {
      revenue,
      cashIn: number(cashPayments._sum.amount),
      transactionCount: sales.length,
      cost,
      grossProfit: revenue - tax - cost,
      discount,
      tax,
      credit,
      totalDebt: number(totalDebt._sum.debt),
    },
    topItems: [...itemTotals.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10),
    sales: sales.map(serializeSale),
  });
});

pos.post("/assistant", async (c) => {
  const { userId } = c.get("user");
  const parsed = assistantSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const message = parsed.data.message;
  const text = message.toLocaleLowerCase("id-ID");
  const [products, customers] = await Promise.all([
    prisma.product.findMany({ where: { userId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.customer.findMany({ where: { userId, isActive: true }, orderBy: { name: "asc" } }),
  ]);

  if (text.includes("laporan") || text.includes("penjualan hari ini")) {
    const dashboard = await dashboardData(userId, c.req.header("x-timezone") || "Asia/Jakarta");
    return c.json({
      reply: `Penjualan hari ini ${money(dashboard.metrics.salesTotal)} dari ${dashboard.metrics.transactionCount} transaksi. Uang masuk ${money(dashboard.metrics.cashIn)} dan kasbon aktif ${money(dashboard.metrics.totalDebt)}.`,
      intent: "REPORT",
    });
  }

  if (text.includes("stok") && (text.includes("hampir") || text.includes("menipis") || text.includes("habis"))) {
    const matches = products.filter((product) => text.includes("habis") ? number(product.stock) <= 0 : number(product.stock) <= number(product.minStock));
    return c.json({
      reply: matches.length ? matches.map((product) => `${product.name}: ${number(product.stock)} ${product.unit}`).join("\n") : "Tidak ada produk yang sesuai.",
      intent: "STOCK_QUERY",
      products: matches.map((product) => ({ id: product.id, name: product.name, stock: number(product.stock), unit: product.unit })),
    });
  }

  if (text.includes("stok")) {
    const matches = products.filter((product) => text.includes(product.name.toLocaleLowerCase("id-ID")) || (product.sku && text.includes(product.sku.toLocaleLowerCase("id-ID"))));
    return c.json({
      reply: matches.length ? matches.map((product) => `${product.name}: ${number(product.stock)} ${product.unit}`).join("\n") : "Produk tidak ditemukan. Coba tulis nama produk lebih lengkap.",
      intent: "STOCK_QUERY",
      products: matches.map((product) => ({ id: product.id, name: product.name, stock: number(product.stock), unit: product.unit })),
    });
  }

  if ((text.includes("siapa") || text.includes("daftar")) && (text.includes("kasbon") || text.includes("hutang"))) {
    const debtors = customers.filter((customer) => number(customer.debt) > 0);
    return c.json({
      reply: debtors.length ? debtors.map((customer) => `${customer.name}: ${money(number(customer.debt))}`).join("\n") : "Tidak ada kasbon aktif.",
      intent: "DEBT_QUERY",
    });
  }

  const matchedCustomer = customers.find((customer) => text.includes(customer.name.toLocaleLowerCase("id-ID")));
  if (matchedCustomer && (text.includes("bayar") || text.includes("lunas"))) {
    const amount = parseCompactAmount(text);
    if (amount <= 0) return c.json({ reply: "Sebutkan nominal pembayaran kasbon.", intent: "NEEDS_AMOUNT" });
    return c.json({
      reply: `Konfirmasi pembayaran kasbon ${matchedCustomer.name} sebesar ${money(amount)}.`,
      intent: "DEBT_PAYMENT",
      draft: { customerId: matchedCustomer.id, customerName: matchedCustomer.name, amount },
    });
  }

  const matchedProducts = products.filter((product) => text.includes(product.name.toLocaleLowerCase("id-ID")) || (product.sku && text.includes(product.sku.toLocaleLowerCase("id-ID"))));
  if (matchedProducts.length > 0 && (text.includes("tambah stok") || text.includes("restok") || text.includes("restock"))) {
    const product = matchedProducts[0];
    const productIndex = text.indexOf(product.name.toLocaleLowerCase("id-ID"));
    const afterName = productIndex >= 0 ? text.slice(productIndex + product.name.length) : text;
    const quantity = parseCompactAmount(afterName) || 1;
    return c.json({
      reply: `Konfirmasi penambahan stok ${product.name} sebanyak ${quantity} ${product.unit}.`,
      intent: "STOCK_ADJUST",
      draft: { productId: product.id, productName: product.name, quantity },
    });
  }

  if (matchedProducts.length > 0) {
    const items = matchedProducts.map((product) => {
      const name = product.name.toLocaleLowerCase("id-ID");
      const index = text.indexOf(name);
      const nearby = index >= 0 ? text.slice(index + name.length, index + name.length + 16) : text;
      const quantity = Math.max(1, Math.floor(parseCompactAmount(nearby) || 1));
      return { productId: product.id, productName: product.name, quantity, price: number(product.price) };
    });
    const isCredit = text.includes("kasbon") || text.includes("hutang");
    if (isCredit && !matchedCustomer) return c.json({ reply: "Pilih atau sebutkan nama pelanggan untuk transaksi kasbon.", intent: "NEEDS_CUSTOMER" });
    return c.json({
      reply: `Draft penjualan siap. ${items.map((item) => `${item.productName} x${item.quantity}`).join(", ")}, pembayaran ${isCredit ? "kasbon" : "tunai"}.`,
      intent: "SALE",
      draft: { items, customerId: matchedCustomer?.id || null, customerName: matchedCustomer?.name || null, paymentMethod: isCredit ? "CREDIT" : "CASH" },
    });
  }

  return c.json({ reply: "Saya belum menemukan produk atau perintah yang dimaksud. Coba tulis nama produk, jumlah, dan metode pembayaran.", intent: "UNKNOWN" });
});

pos.get("/profile", async (c) => {
  const { userId } = c.get("user");
  const profile = await prisma.posProfile.upsert({ where: { userId }, update: {}, create: { userId } });
  return c.json({ profile: { ...profile, taxPercent: number(profile.taxPercent) } });
});

pos.put("/profile", async (c) => {
  const { userId } = c.get("user");
  const parsed = profileSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const data = parsed.data;
  const profile = await prisma.posProfile.upsert({
    where: { userId },
    update: { ...data, address: data.address || null, phone: data.phone || null, receiptFooter: data.receiptFooter || null },
    create: { userId, ...data, address: data.address || null, phone: data.phone || null, receiptFooter: data.receiptFooter || null },
  });
  return c.json({ message: "Profil usaha berhasil disimpan", profile: { ...profile, taxPercent: number(profile.taxPercent) } });
});

pos.get("/session", async (c) => {
  const { userId } = c.get("user");
  const session = await prisma.registerSession.findFirst({ where: { userId, status: "OPEN" }, orderBy: { openedAt: "desc" } });
  return c.json({ session: session ? { ...session, openingCash: number(session.openingCash) } : null });
});

pos.post("/session/open", async (c) => {
  const { userId } = c.get("user");
  const parsed = openSessionSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const existing = await prisma.registerSession.findFirst({ where: { userId, status: "OPEN" } });
  if (existing) return c.json({ error: "Masih ada shift kasir yang terbuka" }, 409);
  const session = await prisma.registerSession.create({ data: { userId, openingCash: parsed.data.openingCash, notes: parsed.data.notes } });
  return c.json({ message: "Shift kasir dibuka", session: { ...session, openingCash: number(session.openingCash) } }, 201);
});

pos.post("/session/close", async (c) => {
  const { userId } = c.get("user");
  const parsed = closeSessionSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const session = await prisma.registerSession.findFirst({ where: { userId, status: "OPEN" }, orderBy: { openedAt: "desc" } });
  if (!session) return c.json({ error: "Tidak ada shift kasir yang terbuka" }, 404);
  const cash = await prisma.salePayment.aggregate({
    where: { registerSessionId: session.id, method: "CASH", sale: { status: "COMPLETED" } },
    _sum: { amount: true },
  });
  const expectedCash = number(session.openingCash) + number(cash._sum.amount);
  const updated = await prisma.registerSession.update({
    where: { id: session.id },
    data: { status: "CLOSED", expectedCash, closingCash: parsed.data.closingCash, notes: parsed.data.notes || session.notes, closedAt: new Date() },
  });
  return c.json({
    message: "Shift kasir ditutup",
    session: { ...updated, openingCash: number(updated.openingCash), expectedCash, closingCash: number(updated.closingCash), difference: parsed.data.closingCash - expectedCash },
  });
});

pos.post("/checkout", async (c) => {
  const { userId } = c.get("user");
  const parsed = checkoutSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const input = parsed.data;

  const duplicate = await prisma.sale.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } }, include: { items: true, payments: true, customer: true } });
  if (duplicate) return c.json({ message: "Transaksi sudah tersimpan", sale: serializeSale(duplicate), duplicate: true });

  const quantities = new Map<string, number>();
  for (const item of input.items) quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
  const productIds = [...quantities.keys()];

  const [products, profile, session, customer] = await Promise.all([
    prisma.product.findMany({ where: { userId, id: { in: productIds }, isActive: true } }),
    prisma.posProfile.findUnique({ where: { userId } }),
    prisma.registerSession.findFirst({ where: { userId, status: "OPEN" }, orderBy: { openedAt: "desc" } }),
    input.customerId ? prisma.customer.findFirst({ where: { id: input.customerId, userId, isActive: true } }) : Promise.resolve(null),
  ]);
  if (!session) return c.json({ error: "Buka shift kasir sebelum melakukan penjualan" }, 409);
  if (products.length !== productIds.length) return c.json({ error: "Satu atau lebih produk tidak ditemukan atau sudah diarsipkan" }, 400);
  if (input.customerId && !customer) return c.json({ error: "Pelanggan tidak ditemukan" }, 404);

  const computedItems = products.map((product) => {
    const quantity = quantities.get(product.id)!;
    if (number(product.stock) < quantity) throw new Error(`Stok ${product.name} tidak cukup. Tersedia ${number(product.stock)} ${product.unit}.`);
    const itemSubtotal = decimal(product.price).mul(quantity).toDecimalPlaces(2);
    return { product, quantity, subtotal: itemSubtotal };
  });
  const subtotal = computedItems.reduce((sum, item) => sum.add(item.subtotal), decimal(0));
  const discount = decimal(input.discount);
  if (discount.gt(subtotal)) return c.json({ error: "Diskon tidak boleh melebihi subtotal" }, 400);
  const taxPercent = decimal(input.taxPercent ?? number(profile?.taxPercent));
  const taxable = subtotal.sub(discount);
  const tax = taxable.mul(taxPercent).div(100).toDecimalPlaces(2);
  const total = taxable.add(tax);
  const { credit, tendered, requiredPaid, change } = calculatePaymentSummary(number(total), input.payments);
  if (credit > number(total)) return c.json({ error: "Nilai kasbon melebihi total transaksi" }, 400);
  if (credit > 0 && !customer) return c.json({ error: "Pilih pelanggan untuk transaksi kasbon" }, 400);
  if (tendered + 0.001 < requiredPaid) return c.json({ error: `Pembayaran kurang ${money(requiredPaid - tendered)}` }, 400);
  const hasCash = input.payments.some((item) => item.method === "CASH");
  if (!hasCash && Math.abs(tendered - requiredPaid) > 0.001) return c.json({ error: "Pembayaran non-tunai harus sama dengan tagihan" }, 400);
  if (customer && credit > 0 && customer.maxDebt != null && number(customer.debt) + credit > number(customer.maxDebt)) {
    return c.json({ error: `Batas kasbon ${customer.name} adalah ${money(number(customer.maxDebt))}` }, 409);
  }

  try {
    const sale = await prisma.$transaction(async (tx) => {
      const created = await tx.sale.create({
        data: {
          userId,
          customerId: customer?.id,
          registerSessionId: session.id,
          invoiceNumber: invoiceNumber(),
          idempotencyKey: input.idempotencyKey,
          subtotal,
          discount,
          tax,
          total,
          paidAmount: requiredPaid,
          creditAmount: credit,
          outstandingAmount: credit,
          changeAmount: change,
          notes: input.notes,
          items: {
            create: computedItems.map(({ product, quantity, subtotal: lineSubtotal }) => ({
              productId: product.id,
              productName: product.name,
              sku: product.sku,
              quantity,
              unit: product.unit,
              unitPrice: product.price,
              unitCost: product.costPrice || 0,
              subtotal: lineSubtotal,
            })),
          },
        },
      });

      let remainingChange = change;
      for (const payment of input.payments) {
        let applied = payment.amount;
        if (payment.method === "CASH" && remainingChange > 0) {
          const reduction = Math.min(applied, remainingChange);
          applied -= reduction;
          remainingChange -= reduction;
        }
        if (applied <= 0) continue;
        await tx.salePayment.create({
          data: { saleId: created.id, registerSessionId: session.id, method: payment.method, amount: applied, reference: payment.reference },
        });
      }

      for (const { product, quantity } of computedItems) {
        const before = number(product.stock);
        const after = before - quantity;
        const changed = await tx.product.updateMany({ where: { id: product.id, userId, stock: { gte: quantity } }, data: { stock: { decrement: quantity } } });
        if (changed.count !== 1) throw new Error(`Stok ${product.name} berubah atau tidak mencukupi`);
        await tx.stockMovement.create({
          data: { userId, productId: product.id, saleId: created.id, type: "SALE", quantity: -quantity, stockBefore: before, stockAfter: after, note: created.invoiceNumber },
        });
        if (after <= number(product.minStock)) {
          await tx.notification.create({
            data: { userId, type: "POS_LOW_STOCK", title: after <= 0 ? "Stok produk habis" : "Stok produk menipis", body: `${product.name} tersisa ${after} ${product.unit}.`, clickAction: "/dashboard/pos?tab=products" },
          });
        }
      }

      if (customer && credit > 0) {
        await tx.customer.update({ where: { id: customer.id }, data: { debt: { increment: credit } } });
        await tx.receivableEntry.create({ data: { userId, customerId: customer.id, saleId: created.id, type: "CHARGE", amount: credit, method: "CREDIT", note: created.invoiceNumber } });
        await tx.notification.create({
          data: { userId, type: "POS_DEBT", title: "Kasbon baru", body: `${customer.name} kasbon ${money(credit)}. Total kasbon ${money(number(customer.debt) + credit)}.`, clickAction: "/dashboard/pos?tab=customers" },
        });
      }

      return tx.sale.findUniqueOrThrow({ where: { id: created.id }, include: { items: true, payments: true, customer: { select: { id: true, name: true, debt: true } } } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const lowStockProducts = await prisma.product.findMany({
      where: { userId, id: { in: input.items.map((item) => item.productId) } },
      select: { id: true, name: true, stock: true, minStock: true, unit: true },
    });
    const pushJobs = lowStockProducts
      .filter((product) => number(product.stock) <= number(product.minStock))
      .map((product) => sendPushNotificationDirect({
        userIds: [userId],
        type: "POS_LOW_STOCK",
        title: number(product.stock) <= 0 ? "Stok produk habis" : "Stok produk menipis",
        body: `${product.name} tersisa ${number(product.stock)} ${product.unit}.`,
        clickAction: "/dashboard/pos?tab=products",
      }));
    if (number(sale.creditAmount) > 0 && sale.customer) {
      pushJobs.push(sendPushNotificationDirect({
        userIds: [userId],
        type: "POS_DEBT",
        title: "Kasbon baru",
        body: `${sale.customer.name} kasbon ${money(number(sale.creditAmount))}. Total kasbon ${money(number(sale.customer.debt))}.`,
        clickAction: "/dashboard/pos?tab=customers",
      }));
    }
    void Promise.allSettled(pushJobs);

    return c.json({ message: "Penjualan berhasil disimpan", sale: serializeSale(sale) }, 201);
  } catch (error) {
    const existing = await prisma.sale.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } }, include: { items: true, payments: true, customer: true } });
    if (existing) return c.json({ message: "Transaksi sudah tersimpan", sale: serializeSale(existing), duplicate: true });
    const message = error instanceof Error ? error.message : "Checkout gagal";
    return c.json({ error: message }, 409);
  }
});

pos.get("/sales", async (c) => {
  const { userId } = c.get("user");
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || 30)));
  const status = c.req.query("status");
  const search = c.req.query("search")?.trim();
  const where: any = { userId };
  if (status === "COMPLETED" || status === "VOIDED") where.status = status;
  if (search) where.OR = [{ invoiceNumber: { contains: search, mode: "insensitive" } }, { customer: { name: { contains: search, mode: "insensitive" } } }];
  const [sales, total] = await Promise.all([
    prisma.sale.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit, include: { customer: { select: { id: true, name: true } }, items: true, payments: true } }),
    prisma.sale.count({ where }),
  ]);
  return c.json({ sales: sales.map(serializeSale), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

pos.get("/sales/:id", async (c) => {
  const { userId } = c.get("user");
  const sale = await prisma.sale.findFirst({ where: { id: c.req.param("id"), userId }, include: { customer: true, items: true, payments: true } });
  if (!sale) return c.json({ error: "Penjualan tidak ditemukan" }, 404);
  return c.json({ sale: serializeSale(sale) });
});

pos.post("/sales/:id/void", async (c) => {
  const { userId } = c.get("user");
  const parsed = voidSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const sale = await prisma.sale.findFirst({ where: { id: c.req.param("id"), userId }, include: { items: true, customer: true } });
  if (!sale) return c.json({ error: "Penjualan tidak ditemukan" }, 404);
  if (sale.status === "VOIDED") return c.json({ error: "Penjualan sudah dibatalkan" }, 409);
  if (number(sale.outstandingAmount) !== number(sale.creditAmount)) return c.json({ error: "Penjualan tidak dapat dibatalkan karena kasbon sudah dicicil" }, 409);

  const result = await prisma.$transaction(async (tx) => {
    for (const item of sale.items) {
      if (!item.productId) continue;
      const product = await tx.product.findFirst({ where: { id: item.productId, userId } });
      if (!product) continue;
      const before = number(product.stock);
      const qty = number(item.quantity);
      await tx.product.update({ where: { id: product.id }, data: { stock: { increment: qty } } });
      await tx.stockMovement.create({ data: { userId, productId: product.id, saleId: sale.id, type: "VOID", quantity: qty, stockBefore: before, stockAfter: before + qty, note: parsed.data.reason } });
    }
    if (sale.customerId && number(sale.creditAmount) > 0) {
      await tx.customer.update({ where: { id: sale.customerId }, data: { debt: { decrement: sale.creditAmount } } });
      await tx.receivableEntry.create({ data: { userId, customerId: sale.customerId, saleId: sale.id, type: "VOID", amount: decimal(sale.creditAmount).neg(), note: parsed.data.reason } });
    }
    return tx.sale.update({ where: { id: sale.id }, data: { status: "VOIDED", outstandingAmount: 0, voidReason: parsed.data.reason, voidedAt: new Date() }, include: { items: true, payments: true, customer: true } });
  });
  return c.json({ message: "Penjualan dibatalkan dan stok dikembalikan", sale: serializeSale(result) });
});

export default pos;
