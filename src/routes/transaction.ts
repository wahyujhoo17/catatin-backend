import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { createTransactionSchema } from "../validators";
import { clearUserAiCache } from "../lib/redis";

const transactions = new Hono();
transactions.use("*", authMiddleware);

// ─── LIST TRANSACTIONS ────────────────────────────────────────
transactions.get("/", async (c) => {
  const { userId } = c.get("user");
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "20");
  const skip = (page - 1) * limit;
  const type = c.req.query("type");
  const categoryId = c.req.query("categoryId");
  const accountId = c.req.query("accountId");
  const search = c.req.query("search");
  const startDate = c.req.query("startDate");
  const endDate = c.req.query("endDate");

  const where: Record<string, any> = { userId };
  if (type && ["INCOME", "EXPENSE", "DEBT", "DEBT_PAYMENT"].includes(type)) {
    where.type = type;
  }
  if (categoryId) where.categoryId = categoryId;
  if (accountId) where.accountId = accountId;
  if (search) {
    where.description = { contains: search, mode: "insensitive" };
  }
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      where.date.lte = end;
    }
  }

  const [list, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { date: "desc" },
      skip,
      take: limit,
      include: {
        category: { select: { name: true, icon: true, color: true } },
        account: { select: { name: true } },
      },
    }),
    prisma.transaction.count({ where }),
  ]);

  return c.json({
    transactions: list,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// ─── GET SINGLE TRANSACTION ───────────────────────────────────
transactions.get("/:id", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");

  const tx = await prisma.transaction.findFirst({
    where: { id, userId },
    include: {
      category: { select: { name: true, icon: true, color: true } },
      account: { select: { name: true } },
      customer: { select: { name: true } }
    }
  });

  if (!tx) return c.json({ error: "Transaksi tidak ditemukan" }, 404);
  return c.json({ transaction: tx });
});

// ─── CREATE TRANSACTION ───────────────────────────────────────
transactions.post("/", async (c) => {
  const { userId } = c.get("user");
  const body = await c.req.json();
  const parsed = createTransactionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  const {
    type,
    amount,
    description,
    note,
    method,
    source,
    date,
    accountId,
    categoryId,
    customerId,
  } = parsed.data;

  const transaction = await prisma.transaction.create({
    data: {
      userId,
      type,
      amount,
      description: description ?? null,
      note: note ?? null,
      method: method ?? null,
      source: source ?? null,
      date: date ? new Date(date) : new Date(),
      accountId: accountId ?? null,
      categoryId: categoryId ?? null,
      customerId: customerId ?? null,
    },
  });

  // Update saldo akun jika accountId diberikan
  if (accountId) {
    const delta = type === "INCOME" || type === "DEBT" ? amount : -amount;
    await prisma.account.update({
      where: { id: accountId },
      data: { balance: { increment: delta } },
    });
  }

  try {
    await clearUserAiCache(userId);
  } catch (err) {
    console.error("[Cache] Failed to clear user AI cache on transaction creation:", err);
  }

  return c.json({ message: "Transaksi berhasil", transaction }, 201);
});

// ─── UPDATE TRANSACTION ───────────────────────────────────────
transactions.put("/:id", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await prisma.transaction.findFirst({
    where: { id, userId },
  });
  if (!existing) return c.json({ error: "Transaksi tidak ditemukan" }, 404);

  const oldDelta = existing.type === "INCOME" || existing.type === "DEBT" ? existing.amount : -existing.amount;
  const newType = body.type ?? existing.type;
  const newAmount = body.amount ?? existing.amount;
  const newAccountId = body.accountId !== undefined ? body.accountId : existing.accountId;
  const newDelta = newType === "INCOME" || newType === "DEBT" ? newAmount : -newAmount;

  let transaction;
  await prisma.$transaction(async (tx) => {
    if (existing.accountId) {
      await tx.account.update({
        where: { id: existing.accountId },
        data: { balance: { decrement: oldDelta } }
      });
    }

    if (newAccountId) {
      await tx.account.update({
        where: { id: newAccountId },
        data: { balance: { increment: newDelta } }
      });
    }

    transaction = await tx.transaction.update({
      where: { id },
      data: {
        type: newType,
        amount: newAmount,
        description:
          body.description !== undefined
            ? body.description
            : existing.description,
        note: body.note !== undefined ? body.note : existing.note,
        method: body.method !== undefined ? body.method : existing.method,
        source: body.source !== undefined ? body.source : existing.source,
        date: body.date ? new Date(body.date) : existing.date,
        accountId: newAccountId,
        categoryId:
          body.categoryId !== undefined ? body.categoryId : existing.categoryId,
        customerId:
          body.customerId !== undefined ? body.customerId : existing.customerId,
      },
    });
  });

  try {
    await clearUserAiCache(userId);
  } catch (err) {
    console.error("[Cache] Failed to clear user AI cache on transaction update:", err);
  }

  return c.json({ message: "Transaksi berhasil diperbarui", transaction });
});

// ─── DELETE TRANSACTION ───────────────────────────────────────
transactions.delete("/:id", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");

  const tx = await prisma.transaction.findFirst({
    where: { id, userId },
  });
  if (!tx) return c.json({ error: "Transaksi tidak ditemukan" }, 404);

  const oldDelta = tx.type === "INCOME" || tx.type === "DEBT" ? tx.amount : -tx.amount;
  await prisma.$transaction(async (prismaTx) => {
    if (tx.accountId) {
      await prismaTx.account.update({
        where: { id: tx.accountId },
        data: { balance: { decrement: oldDelta } }
      });
    }
    await prismaTx.transaction.delete({ where: { id } });
  });

  try {
    await clearUserAiCache(userId);
  } catch (err) {
    console.error("[Cache] Failed to clear user AI cache on transaction deletion:", err);
  }

  return c.json({ message: "Transaksi berhasil dihapus" });
});

export default transactions;
