import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

const goals = new Hono();
goals.use("*", authMiddleware);

const createGoalSchema = z.object({
  name: z.string().min(1, "Nama target wajib diisi"),
  targetAmount: z.number().positive("Nominal target harus lebih dari 0"),
  currentAmount: z.number().nonnegative().optional().default(0),
  targetDate: z.string().optional().nullable(),
  icon: z.string().optional().default("target"),
  color: z.string().optional().default("#4f378a"),
});

const updateGoalSchema = z.object({
  name: z.string().optional(),
  targetAmount: z.number().positive().optional(),
  currentAmount: z.number().nonnegative().optional(),
  amountToAdd: z.number().optional(), // For deposit/allocating money
  targetDate: z.string().optional().nullable(),
  icon: z.string().optional(),
  color: z.string().optional(),
  isCompleted: z.boolean().optional(),
});

// GET /api/goals - Get all saving goals for current user
goals.get("/", async (c) => {
  const user = c.get("user");
  const userId = user.userId;

  try {
    const list = await prisma.savingGoal.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    const formatted = list.map((g) => {
      const progress = g.targetAmount > 0
        ? Math.min((g.currentAmount / g.targetAmount) * 100, 100)
        : 0;
      const remaining = Math.max(g.targetAmount - g.currentAmount, 0);

      return {
        ...g,
        progressPercentage: Number(progress.toFixed(1)),
        remainingAmount: remaining,
      };
    });

    return c.json({ data: formatted });
  } catch (error) {
    console.error("[Goal] Error fetching goals:", error);
    return c.json({ error: "Gagal mengambil data target tabungan" }, 500);
  }
});

// POST /api/goals - Create new saving goal
goals.post("/", zValidator("json", createGoalSchema), async (c) => {
  const user = c.get("user");
  const userId = user.userId;
  const { name, targetAmount, currentAmount, targetDate, icon, color } =
    c.req.valid("json" as any);

  try {
    const newGoal = await prisma.savingGoal.create({
      data: {
        userId,
        name,
        targetAmount,
        currentAmount: currentAmount || 0,
        targetDate: targetDate ? new Date(targetDate) : null,
        icon: icon || "target",
        color: color || "#4f378a",
        isCompleted: (currentAmount || 0) >= targetAmount,
      },
    });

    const progress = newGoal.targetAmount > 0
      ? Math.min((newGoal.currentAmount / newGoal.targetAmount) * 100, 100)
      : 0;
    const remaining = Math.max(newGoal.targetAmount - newGoal.currentAmount, 0);

    return c.json(
      {
        data: {
          ...newGoal,
          progressPercentage: Number(progress.toFixed(1)),
          remainingAmount: remaining,
        },
        message: "Target tabungan berhasil dibuat",
      },
      201,
    );
  } catch (error) {
    console.error("[Goal] Error creating goal:", error);
    return c.json({ error: "Gagal membuat target tabungan" }, 500);
  }
});

// PATCH /api/goals/:id - Update or deposit to a goal
goals.patch("/:id", zValidator("json", updateGoalSchema), async (c) => {
  const user = c.get("user");
  const userId = user.userId;
  const id = c.req.param("id");
  const body = c.req.valid("json" as any);

  try {
    const existing = await prisma.savingGoal.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return c.json({ error: "Target tabungan tidak ditemukan" }, 404);
    }

    let newCurrentAmount = existing.currentAmount;
    if (typeof body.amountToAdd === "number") {
      newCurrentAmount += body.amountToAdd;
    } else if (typeof body.currentAmount === "number") {
      newCurrentAmount = body.currentAmount;
    }

    const newTargetAmount = body.targetAmount || existing.targetAmount;
    const isCompleted =
      typeof body.isCompleted === "boolean"
        ? body.isCompleted
        : newCurrentAmount >= newTargetAmount;

    const updated = await prisma.savingGoal.update({
      where: { id },
      data: {
        name: body.name || existing.name,
        targetAmount: newTargetAmount,
        currentAmount: newCurrentAmount,
        targetDate:
          body.targetDate !== undefined
            ? body.targetDate
              ? new Date(body.targetDate)
              : null
            : existing.targetDate,
        icon: body.icon || existing.icon,
        color: body.color || existing.color,
        isCompleted,
      },
    });

    const progress = updated.targetAmount > 0
      ? Math.min((updated.currentAmount / updated.targetAmount) * 100, 100)
      : 0;
    const remaining = Math.max(updated.targetAmount - updated.currentAmount, 0);

    return c.json({
      data: {
        ...updated,
        progressPercentage: Number(progress.toFixed(1)),
        remainingAmount: remaining,
      },
      message: "Target tabungan diperbarui",
    });
  } catch (error) {
    console.error("[Goal] Error updating goal:", error);
    return c.json({ error: "Gagal memperbarui target tabungan" }, 500);
  }
});

// DELETE /api/goals/:id - Delete a goal
goals.delete("/:id", async (c) => {
  const user = c.get("user");
  const userId = user.userId;
  const id = c.req.param("id");

  try {
    const existing = await prisma.savingGoal.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return c.json({ error: "Target tabungan tidak ditemukan" }, 404);
    }

    await prisma.savingGoal.delete({ where: { id } });
    return c.json({ message: "Target tabungan berhasil dihapus" });
  } catch (error) {
    console.error("[Goal] Error deleting goal:", error);
    return c.json({ error: "Gagal menghapus target tabungan" }, 500);
  }
});

export default goals;
