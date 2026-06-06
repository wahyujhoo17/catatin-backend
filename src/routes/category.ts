import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";

const categories = new Hono();
categories.use("*", authMiddleware);

// ─── LIST CATEGORIES ──────────────────────────────────────────
categories.get("/", async (c) => {
  const { userId } = c.get("user");
  const type = c.req.query("type");

  const where: Record<string, unknown> = { userId };
  if (type && ["INCOME", "EXPENSE", "DEBT", "DEBT_PAYMENT"].includes(type)) {
    where.type = type;
  }

  const list = await prisma.category.findMany({
    where,
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });
  return c.json({ categories: list });
});

// ─── CREATE CATEGORY ──────────────────────────────────────────
categories.post("/", async (c) => {
  const { userId } = c.get("user");
  const body = await c.req.json();
  const { name, icon, color, type } = body;

  if (!name) return c.json({ error: "Nama kategori harus diisi" }, 400);

  const category = await prisma.category.create({
    data: {
      userId,
      name,
      icon: icon ?? null,
      color: color ?? null,
      type: type ?? "EXPENSE",
    },
  });

  return c.json({ message: "Kategori berhasil ditambahkan", category }, 201);
});

// ─── UPDATE CATEGORY ──────────────────────────────────────────
categories.put("/:id", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await prisma.category.findFirst({
    where: { id, userId },
  });
  if (!existing) return c.json({ error: "Kategori tidak ditemukan" }, 404);

  const category = await prisma.category.update({
    where: { id },
    data: {
      name: body.name ?? existing.name,
      icon: body.icon !== undefined ? body.icon : existing.icon,
      color: body.color !== undefined ? body.color : existing.color,
      type: body.type ?? existing.type,
    },
  });

  return c.json({ message: "Kategori berhasil diperbarui", category });
});

// ─── DELETE CATEGORY ──────────────────────────────────────────
categories.delete("/:id", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.category.findFirst({
    where: { id, userId },
  });
  if (!existing) return c.json({ error: "Kategori tidak ditemukan" }, 404);

  const txCount = await prisma.transaction.count({
    where: { categoryId: id },
  });
  if (txCount > 0) {
    return c.json(
      { error: `Kategori masih digunakan oleh ${txCount} transaksi` },
      400,
    );
  }

  await prisma.category.delete({ where: { id } });
  return c.json({ message: "Kategori berhasil dihapus" });
});

export default categories;
