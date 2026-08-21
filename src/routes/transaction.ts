import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { createTransactionSchema, updateTransactionSchema } from "../validators";
import { clearUserAiCache } from "../lib/redis";
import { checkAndTriggerBudgetAlerts } from "../services/budgetAlert";

const transactions = new Hono();
transactions.use("*", authMiddleware);

const balanceEffect = (type: string, amount: number) =>
  type === "INCOME" || type === "DEBT_PAYMENT" ? amount : type === "EXPENSE" ? -amount : 0;
const debtEffect = (type: string, amount: number) =>
  type === "DEBT" ? amount : type === "DEBT_PAYMENT" ? -amount : 0;

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

  const [account, category, customer] = await Promise.all([
    accountId ? prisma.account.findFirst({ where: { id: accountId, userId } }) : Promise.resolve(null),
    categoryId ? prisma.category.findFirst({ where: { id: categoryId, userId } }) : Promise.resolve(null),
    customerId ? prisma.customer.findFirst({ where: { id: customerId, userId } }) : Promise.resolve(null),
  ]);
  if (accountId && !account) return c.json({ error: "Akun tidak ditemukan" }, 404);
  if (categoryId && !category) return c.json({ error: "Kategori tidak ditemukan" }, 404);
  if (customerId && !customer) return c.json({ error: "Pelanggan tidak ditemukan" }, 404);
  if ((type === "DEBT" || type === "DEBT_PAYMENT") && !customer) {
    return c.json({ error: "Pelanggan wajib dipilih untuk transaksi piutang" }, 400);
  }
  if (type === "DEBT_PAYMENT" && customer && Number(customer.debt) < amount) {
    return c.json({ error: "Pembayaran melebihi sisa piutang pelanggan" }, 400);
  }

  const transaction = await prisma.$transaction(async (tx) => {
    const created = await tx.transaction.create({
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
    const balanceDelta = balanceEffect(type, amount);
    if (accountId && balanceDelta !== 0) {
      const changed = await tx.account.updateMany({
        where: { id: accountId, userId, ...(balanceDelta < 0 ? { balance: { gte: Math.abs(balanceDelta) } } : {}) },
        data: { balance: { increment: balanceDelta } },
      });
      if (changed.count !== 1) throw new Error("Saldo akun tidak mencukupi");
    }
    const debtDelta = debtEffect(type, amount);
    if (customerId && debtDelta !== 0) {
      const changed = await tx.customer.updateMany({
        where: { id: customerId, userId, ...(debtDelta < 0 ? { debt: { gte: Math.abs(debtDelta) } } : {}) },
        data: { debt: { increment: debtDelta } },
      });
      if (changed.count !== 1) throw new Error("Piutang pelanggan tidak mencukupi");
    }
    return created;
  });

  // Trigger alert budget real-time jika tipe transaksi EXPENSE
  if (type === "EXPENSE") {
    checkAndTriggerBudgetAlerts(userId, amount, description || "Pengeluaran", categoryId).catch((err) => {
      console.error("[BudgetAlert] Error in async alert trigger:", err.message);
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
// ─── UPDATE TRANSACTION ───────────────────────────────────────
transactions.put("/:id", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = updateTransactionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const update = parsed.data;

  const existing = await prisma.transaction.findFirst({
    where: { id, userId },
  });
  if (!existing) return c.json({ error: "Transaksi tidak ditemukan" }, 404);

  // Cari linked transaction jika ini bagian dari transfer
  let peerTx = null;
  const wherePeer: any[] = [{ linkedTransactionId: existing.id }];
  if (existing.linkedTransactionId) {
    wherePeer.push({ id: existing.linkedTransactionId });
  }

  if (wherePeer.length > 0) {
    peerTx = await prisma.transaction.findFirst({
      where: { userId, OR: wherePeer }
    });
  }

  const oldDelta = balanceEffect(existing.type, existing.amount);
  const newType = update.type ?? existing.type;
  const newAmount = update.amount ?? existing.amount;
  const newAccountId = update.accountId !== undefined ? update.accountId : existing.accountId;
  const newCustomerId = update.customerId !== undefined ? update.customerId : existing.customerId;
  const newCategoryId = update.categoryId !== undefined ? update.categoryId : existing.categoryId;
  const newDelta = balanceEffect(newType, newAmount);

  const [targetAccount, targetCustomer, targetCategory] = await Promise.all([
    newAccountId ? prisma.account.findFirst({ where: { id: newAccountId, userId } }) : Promise.resolve(null),
    newCustomerId ? prisma.customer.findFirst({ where: { id: newCustomerId, userId } }) : Promise.resolve(null),
    newCategoryId ? prisma.category.findFirst({ where: { id: newCategoryId, userId } }) : Promise.resolve(null),
  ]);
  if (newAccountId && !targetAccount) return c.json({ error: "Akun tidak ditemukan" }, 404);
  if (newCustomerId && !targetCustomer) return c.json({ error: "Pelanggan tidak ditemukan" }, 404);
  if (newCategoryId && !targetCategory) return c.json({ error: "Kategori tidak ditemukan" }, 404);
  if ((newType === "DEBT" || newType === "DEBT_PAYMENT") && !targetCustomer) {
    return c.json({ error: "Pelanggan wajib dipilih untuk transaksi piutang" }, 400);
  }

  let transaction;
  await prisma.$transaction(async (tx) => {
    // 1. Revert Old Balances
    if (existing.accountId && oldDelta !== 0) {
      await tx.account.update({
        where: { id: existing.accountId },
        data: { balance: { decrement: oldDelta } }
      });
    }
    const oldDebtDelta = debtEffect(existing.type, existing.amount);
    if (existing.customerId && oldDebtDelta !== 0) {
      await tx.customer.update({
        where: { id: existing.customerId },
        data: { debt: { decrement: oldDebtDelta } }
      });
    }

    if (peerTx) {
      const peerOldDelta = balanceEffect(peerTx.type, peerTx.amount);
      if (peerTx.accountId) {
        await tx.account.update({
          where: { id: peerTx.accountId },
          data: { balance: { decrement: peerOldDelta } }
        });
      }
    }

    // 2. Apply New Balances
    if (newAccountId && newDelta !== 0) {
      const changed = await tx.account.updateMany({
        where: { id: newAccountId, userId, ...(newDelta < 0 ? { balance: { gte: Math.abs(newDelta) } } : {}) },
        data: { balance: { increment: newDelta } },
      });
      if (changed.count !== 1) throw new Error("Saldo akun tidak mencukupi");
    }
    const newDebtDelta = debtEffect(newType, newAmount);
    if (newCustomerId && newDebtDelta !== 0) {
      const changed = await tx.customer.updateMany({
        where: {
          id: newCustomerId,
          userId,
          ...(newDebtDelta < 0 ? { debt: { gte: Math.abs(newDebtDelta) } } : {}),
        },
        data: { debt: { increment: newDebtDelta } },
      });
      if (changed.count !== 1) {
        throw new Error("Pembayaran melebihi sisa piutang pelanggan");
      }
    }

    if (peerTx) {
      const peerNewDelta = balanceEffect(peerTx.type, newAmount);
      if (peerTx.accountId) {
        await tx.account.update({
          where: { id: peerTx.accountId },
          data: { balance: { increment: peerNewDelta } }
        });
      }
    }

    // 3. Update Transaction Records
    transaction = await tx.transaction.update({
      where: { id },
      data: {
        type: newType,
        amount: newAmount,
        description: update.description !== undefined ? update.description : existing.description,
        note: update.note !== undefined ? update.note : existing.note,
        method: update.method !== undefined ? update.method : existing.method,
        source: update.source !== undefined ? update.source : existing.source,
        date: update.date ? new Date(update.date) : existing.date,
        accountId: newAccountId,
        categoryId: newCategoryId,
        customerId: newCustomerId,
      },
    });

    if (peerTx) {
      await tx.transaction.update({
        where: { id: peerTx.id },
        data: {
          amount: newAmount,
          description: update.description !== undefined ? update.description : peerTx.description,
          date: update.date ? new Date(update.date) : peerTx.date,
        }
      });
    }
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

  // Cari semua transaksi terkait (linkedTransactionId, splitGroupId, atau linkedFrom)
  const whereConditions: any[] = [
    { id },
    { linkedTransactionId: id }
  ];
  if (tx.linkedTransactionId) {
    whereConditions.push({ id: tx.linkedTransactionId });
  }
  if (tx.splitGroupId) {
    whereConditions.push({ splitGroupId: tx.splitGroupId });
  }

  const relatedTxs = await prisma.transaction.findMany({
    where: {
      userId,
      OR: whereConditions
    }
  });

  await prisma.$transaction(async (prismaTx) => {
    for (const item of relatedTxs) {
      // Revert account balance
      if (item.accountId) {
        const delta = -balanceEffect(item.type, item.amount);
        if (delta !== 0) {
          const changed = await prismaTx.account.updateMany({
            where: { id: item.accountId, userId, ...(delta < 0 ? { balance: { gte: Math.abs(delta) } } : {}) },
            data: { balance: { increment: delta } },
          });
          if (changed.count !== 1) throw new Error("Transaksi tidak dapat dihapus karena saldo tidak mencukupi");
        }
      }
      const customerDelta = -debtEffect(item.type, item.amount);
      if (item.customerId && customerDelta !== 0) {
        const changed = await prismaTx.customer.updateMany({
          where: { id: item.customerId, userId, ...(customerDelta < 0 ? { debt: { gte: Math.abs(customerDelta) } } : {}) },
          data: { debt: { increment: customerDelta } },
        });
        if (changed.count !== 1) throw new Error("Transaksi tidak dapat dihapus karena piutang tidak konsisten");
      }
      await prismaTx.transaction.delete({ where: { id: item.id } });
    }
  });

  try {
    await clearUserAiCache(userId);
  } catch (err) {
    console.error("[Cache] Failed to clear user AI cache on transaction deletion:", err);
  }

  return c.json({ message: "Transaksi berhasil dihapus" });
});

export default transactions;
