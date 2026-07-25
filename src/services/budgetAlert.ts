import prisma from "../lib/prisma";
import { cronQueue } from "../lib/queue";
import {
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
} from "date-fns";

/**
 * Memeriksa apakah transaksi pengeluaran melampaui alertThreshold per-transaksi
 * atau melebihi Target Budget Kumulatif (DAILY, WEEKLY, MONTHLY, YEARLY).
 */
export async function checkAndTriggerBudgetAlerts(
  userId: string,
  amount: number,
  description: string = "Pengeluaran",
  categoryId?: string | null
) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, customAiConfig: true },
    });

    if (!user) return;

    // 1. Single transaction large alert
    const config = user.customAiConfig as any;
    const threshold = config?.alertThreshold ?? 500000;

    if (amount >= threshold) {
      await cronQueue.add("realtime-ai-alert", {
        userId,
        userName: user.name || "User",
        amount,
        description,
      });
    }

    // 2. Cumulative Budget Alerts (DAILY, WEEKLY, MONTHLY, YEARLY)
    const activeBudgets = await prisma.budget.findMany({
      where: {
        userId,
        OR: [
          ...(categoryId ? [{ categoryId }] : []),
          { categoryId: null },
        ],
      },
      include: { category: true },
    });

    if (activeBudgets.length === 0) return;

    const now = new Date();

    for (const budget of activeBudgets) {
      let startDate: Date;
      let endDate: Date;

      switch (budget.period) {
        case "DAILY":
          startDate = startOfDay(now);
          endDate = endOfDay(now);
          break;
        case "WEEKLY":
          startDate = startOfWeek(now, { weekStartsOn: 1 });
          endDate = endOfWeek(now, { weekStartsOn: 1 });
          break;
        case "YEARLY":
          startDate = startOfYear(now);
          endDate = endOfYear(now);
          break;
        case "MONTHLY":
        default:
          startDate = startOfMonth(now);
          endDate = endOfMonth(now);
          break;
      }

      // Hitung akumulasi pengeluaran pada rentang waktu budget ini
      const aggregate = await prisma.transaction.aggregate({
        where: {
          userId,
          type: "EXPENSE",
          ...(budget.categoryId ? { categoryId: budget.categoryId } : {}),
          date: {
            gte: startDate,
            lte: endDate,
          },
        },
        _sum: { amount: true },
      });

      const currentSpent = aggregate._sum.amount || 0;

      // Jika akumulasi pengeluaran melampaui target budget, picu push notification AI
      if (currentSpent >= budget.amount) {
        await cronQueue.add("budget-limit-exceeded-alert", {
          userId,
          userName: user.name || "User",
          period: budget.period,
          categoryName: budget.category?.name || "Keseluruhan",
          budgetAmount: budget.amount,
          currentSpent,
          latestTxAmount: amount,
          latestDescription: description,
        });
      }
    }
  } catch (err: any) {
    console.error("[BudgetAlert] Error checking budget alerts:", err.message);
  }
}
