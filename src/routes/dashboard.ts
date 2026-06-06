import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";

const dashboard = new Hono();
dashboard.use("*", authMiddleware);

// ─── GET /api/dashboard/summary ──────────────────────────────────
dashboard.get("/summary", async (c) => {
  const { userId } = c.get("user");

  // Rentang bulan ini
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23,
    59,
    59,
  );

  // ─── Total saldo dari semua akun ─────────────────────────────
  const accounts = await prisma.account.findMany({
    where: { userId },
    select: { balance: true },
  });
  const totalBalance = accounts.reduce((sum, a) => sum + a.balance, 0);

  // ─── Total pemasukan & pengeluaran bulan ini ─────────────────
  const monthlyAgg = await prisma.transaction.aggregate({
    where: {
      userId,
      date: { gte: startOfMonth, lte: endOfMonth },
    },
    _sum: { amount: true },
  });

  const [incomeTx, expenseTx] = await Promise.all([
    prisma.transaction.aggregate({
      where: {
        userId,
        type: "INCOME",
        date: { gte: startOfMonth, lte: endOfMonth },
      },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: {
        userId,
        type: "EXPENSE",
        date: { gte: startOfMonth, lte: endOfMonth },
      },
      _sum: { amount: true },
    }),
  ]);

  const totalIncome = incomeTx._sum.amount || 0;
  const totalExpense = expenseTx._sum.amount || 0;

  // ─── Budget health percentage ────────────────────────────────
  // Asumsikan budget = total pemasukan bulan ini, health = (income - expense) / income
  const budgetHealth =
    totalIncome > 0
      ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100)
      : 100;
  const healthLabel =
    budgetHealth >= 70
      ? "Sangat Baik"
      : budgetHealth >= 50
        ? "Baik"
        : budgetHealth >= 30
          ? "Perlu Perhatian"
          : "Kritis";

  // ─── 5 Transaksi terbaru ────────────────────────────────────
  const recentTransactions = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { date: "desc" },
    take: 5,
    include: {
      category: { select: { name: true, icon: true, color: true } },
    },
  });

  // ─── Top kategori pengeluaran bulan ini ──────────────────────
  const topCategoriesRaw = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: {
      userId,
      type: "EXPENSE",
      date: { gte: startOfMonth, lte: endOfMonth },
    },
    _sum: { amount: true },
    orderBy: { _sum: { amount: "desc" } },
    take: 4,
  });

  // Ambil nama kategori
  const categoryIds = topCategoriesRaw
    .map((c) => c.categoryId)
    .filter(Boolean) as string[];
  const categoriesMap = new Map<
    string,
    { name: string; icon: string | null; color: string | null }
  >();

  if (categoryIds.length > 0) {
    const cats = await prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true, icon: true, color: true },
    });
    for (const cat of cats) {
      categoriesMap.set(cat.id, cat);
    }
  }

  const topCategories = topCategoriesRaw.map((c) => {
    const cat = c.categoryId ? categoriesMap.get(c.categoryId) : null;
    return {
      name: cat?.name || "Tanpa Kategori",
      icon: cat?.icon || "category",
      color: cat?.color || "var(--secondary)",
      amount: c._sum.amount || 0,
      percentage:
        totalExpense > 0
          ? Math.round(((c._sum.amount || 0) / totalExpense) * 100)
          : 0,
    };
  });

  return c.json({
    balance: totalBalance,
    incomeThisMonth: totalIncome,
    expenseThisMonth: totalExpense,
    budgetHealth,
    healthLabel,
    recentTransactions: recentTransactions.map((tx) => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      description: tx.description || "Tanpa deskripsi",
      category: tx.category?.name || "Umum",
      categoryIcon: tx.category?.icon || "receipt_long",
      categoryColor: tx.category?.color || "var(--secondary)",
      date: tx.date,
      isExpense: tx.type === "EXPENSE",
    })),
    topCategories,
  });
});

export default dashboard;
