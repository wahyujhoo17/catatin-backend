import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { createProductSchema, updateProductSchema } from "../validators";

const products = new Hono();
products.use("*", authMiddleware);

// ─── LIST PRODUCTS ────────────────────────────────────────────
products.get("/", async (c) => {
  const { userId } = c.get("user");
  const search = c.req.query("search") || "";
  const isActive = c.req.query("isActive");

  const where: Record<string, unknown> = { userId };
  if (search) {
    where.name = { contains: search, mode: "insensitive" };
  }
  if (isActive !== undefined) {
    where.isActive = isActive === "true";
  }

  const list = await prisma.product.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  return c.json({ products: list });
});

// ─── GET SINGLE PRODUCT ───────────────────────────────────────
products.get("/:id", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");

  const product = await prisma.product.findFirst({
    where: { id, userId },
  });

  if (!product) return c.json({ error: "Produk tidak ditemukan" }, 404);
  return c.json({ product });
});

// ─── CREATE PRODUCT ───────────────────────────────────────────
products.post("/", async (c) => {
  const { userId } = c.get("user");
  const body = await c.req.json();
  const parsed = createProductSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  const { name, price, costPrice, category, unit, stock, minStock } =
    parsed.data;

  const product = await prisma.product.create({
    data: {
      userId,
      name,
      price,
      costPrice: costPrice ?? null,
      category: category ?? null,
      unit: unit ?? "pcs",
      stock: stock ?? 0,
      minStock: minStock ?? 5,
    },
  });

  return c.json({ message: "Produk berhasil ditambahkan", product }, 201);
});

// ─── UPDATE PRODUCT ───────────────────────────────────────────
products.put("/:id", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = updateProductSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  const existing = await prisma.product.findFirst({
    where: { id, userId },
  });
  if (!existing) return c.json({ error: "Produk tidak ditemukan" }, 404);

  const { name, price, costPrice, category, unit, stock, minStock, isActive } =
    parsed.data;

  const product = await prisma.product.update({
    where: { id },
    data: {
      name: name ?? existing.name,
      price: price ?? existing.price,
      costPrice: costPrice !== undefined ? costPrice : existing.costPrice,
      category: category !== undefined ? category : existing.category,
      unit: unit ?? existing.unit,
      stock: stock ?? existing.stock,
      minStock: minStock ?? existing.minStock,
      isActive: isActive !== undefined ? isActive : existing.isActive,
    },
  });

  return c.json({ message: "Produk berhasil diperbarui", product });
});

// ─── DELETE PRODUCT ───────────────────────────────────────────
products.delete("/:id", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.product.findFirst({
    where: { id, userId },
  });
  if (!existing) return c.json({ error: "Produk tidak ditemukan" }, 404);

  await prisma.product.delete({ where: { id } });
  return c.json({ message: "Produk berhasil dihapus" });
});

export default products;
