import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfYear, endOfYear, startOfDay, endOfDay } from "date-fns";

import { getFinancialMonthlyRange } from "../lib/financialCycle";

const budgets = new Hono();
budgets.use("*", authMiddleware);

// Validation schema for creating a budget
const budgetSchema = z.object({
  categoryId: z.string().optional(),
  amount: z.number().positive(),
  period: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).default("MONTHLY"),
});

// GET /api/budgets - Get active budgets and their progress (spending)
budgets.get("/", async (c) => {
  const user = c.get("user");
  const userId = user.userId;

  try {
    const userDb = await prisma.user.findUnique({
      where: { id: userId },
      select: { financialCycleStartDay: true },
    });
    const cycleStartDay = userDb?.financialCycleStartDay ?? 1;

    const activeBudgets = await prisma.budget.findMany({
      where: { userId },
      include: { category: true }
    });

    const now = new Date();

    // Calculate progress for each budget
    const budgetsWithProgress = await Promise.all(activeBudgets.map(async (budget) => {
      let startDate: Date;
      let endDate: Date;

      switch (budget.period) {
        case "DAILY":
          startDate = startOfDay(now);
          endDate = endOfDay(now);
          break;
        case "WEEKLY":
          startDate = startOfWeek(now, { weekStartsOn: 1 }); // Monday
          endDate = endOfWeek(now, { weekStartsOn: 1 });
          break;
        case "YEARLY":
          startDate = startOfYear(now);
          endDate = endOfYear(now);
          break;
        case "MONTHLY":
        default: {
          const monthlyRange = getFinancialMonthlyRange(now, cycleStartDay);
          startDate = monthlyRange.start;
          endDate = monthlyRange.end;
          break;
        }
      }

      const aggregate = await prisma.transaction.aggregate({
        where: {
          userId,
          type: "EXPENSE",
          isTransfer: false,
          ...(budget.categoryId ? { categoryId: budget.categoryId } : {}),
          date: {
            gte: startDate,
            lte: endDate
          }
        },
        _sum: {
          amount: true
        }
      });

      const spent = aggregate._sum.amount || 0;
      const remaining = budget.amount - spent;

      return {
        ...budget,
        spent,
        remaining,
        progressPercentage: Math.min((spent / budget.amount) * 100, 100)
      };
    }));

    return c.json({ data: budgetsWithProgress });
  } catch (error) {
    console.error("[Budget] Error fetching budgets:", error);
    return c.json({ error: "Gagal mengambil data budget" }, 500);
  }
});

// POST /api/budgets - Create or update budget
budgets.post("/", zValidator("json", budgetSchema), async (c) => {
  const user = c.get("user");
  const userId = user.userId;
  const { categoryId, amount, period } = c.req.valid("json" as any);

  try {
     const newBudget = await prisma.budget.create({
        data: {
          userId,
          categoryId: categoryId || null,
          amount,
          period
        },
        include: {
          category: true
        }
     });

     return c.json({ data: newBudget, message: "Budget berhasil dibuat" }, 201);
  } catch (error) {
    console.error("[Budget] Error creating budget:", error);
    return c.json({ error: "Gagal membuat budget" }, 500);
  }
});

// DELETE /api/budgets/:id - Delete a budget
budgets.delete("/:id", async (c) => {
  const user = c.get("user");
  const userId = user.userId;
  const id = c.req.param("id");

  try {
    const budget = await prisma.budget.findUnique({ where: { id } });
    if (!budget || budget.userId !== userId) {
      return c.json({ error: "Budget tidak ditemukan" }, 404);
    }

    await prisma.budget.delete({ where: { id } });

    return c.json({ message: "Budget berhasil dihapus" });
  } catch (error) {
    console.error("[Budget] Error deleting budget:", error);
    return c.json({ error: "Gagal menghapus budget" }, 500);
  }
});

export default budgets;
