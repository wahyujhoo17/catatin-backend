import { Hono } from "hono";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { createProductSchema, updateProductSchema } from "../validators";

const products = new Hono();
products.use("*", authMiddleware);

const adjustmentSchema = z.object({
  quantity: z.number().finite().refine((value) => value !== 0, "Perubahan stok tidak boleh 0"),
  type: z.enum(["PURCHASE", "ADJUSTMENT", "RETURN"]).default("ADJUSTMENT"),
  note: z.string().trim().max(500).optional(),
});

function serializeProduct<T extends Record<string, unknown>>(product: T) {
  return {
    ...product,
    price: Number(product.price),
    costPrice: product.costPrice == null ? null : Number(product.costPrice),
    stock: Number(product.stock),
    minStock: Number(product.minStock),
  };
}

products.get("/", async (c) => {
  const { userId } = c.get("user");
  const search = c.req.query("search")?.trim() || "";
  const status = c.req.query("status") || "active";
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") || 100)));

  const where: Record<string, unknown> = { userId };
  if (status === "active") where.isActive = true;
  if (status === "archived") where.isActive = false;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { sku: { contains: search, mode: "insensitive" } },
      { barcode: { contains: search, mode: "insensitive" } },
      { category: { contains: search, mode: "insensitive" } },
    ];
  }

  const [list, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.product.count({ where }),
  ]);

  const serialized = list.map((item) => {
    const product = serializeProduct(item);
    return { ...product, isLowStock: product.stock <= product.minStock };
  });
  const filtered = status === "low" ? serialized.filter((item) => item.isLowStock && item.stock > 0) :
    status === "out" ? serialized.filter((item) => item.stock <= 0) : serialized;

  return c.json({ products: filtered, pagination: { page, limit, total } });
});

products.get("/:id", async (c) => {
  const { userId } = c.get("user");
  const product = await prisma.product.findFirst({
    where: { id: c.req.param("id"), userId },
    include: { stockMovements: { orderBy: { createdAt: "desc" }, take: 50 } },
  });
  if (!product) return c.json({ error: "Produk tidak ditemukan" }, 404);
  return c.json({
    product: {
      ...serializeProduct(product),
      stockMovements: product.stockMovements.map((movement) => ({
        ...movement,
        quantity: Number(movement.quantity),
        stockBefore: Number(movement.stockBefore),
        stockAfter: Number(movement.stockAfter),
      })),
    },
  });
});

products.post("/", async (c) => {
  const { userId } = c.get("user");
  const parsed = createProductSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);

  const data = parsed.data;
  try {
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          userId,
          name: data.name.trim(),
          sku: data.sku || null,
          barcode: data.barcode || null,
          price: data.price,
          costPrice: data.costPrice ?? null,
          category: data.category || null,
          unit: data.unit,
          stock: data.stock,
          minStock: data.minStock,
          image: data.image ?? null,
        },
      });
      if (data.stock > 0) {
        await tx.stockMovement.create({
          data: {
            userId,
            productId: created.id,
            type: "INITIAL",
            quantity: data.stock,
            stockBefore: 0,
            stockAfter: data.stock,
            note: "Stok awal produk",
          },
        });
      }
      return created;
    });
    return c.json({ message: "Produk berhasil ditambahkan", product: serializeProduct(product) }, 201);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return c.json({ error: "SKU atau barcode sudah digunakan" }, 409);
    }
    throw error;
  }
});

products.put("/:id", async (c) => {
  const { userId } = c.get("user");
  const parsed = updateProductSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);

  const existing = await prisma.product.findFirst({ where: { id: c.req.param("id"), userId } });
  if (!existing) return c.json({ error: "Produk tidak ditemukan" }, 404);
  const data = parsed.data;

  try {
    const product = await prisma.$transaction(async (tx) => {
      const oldStock = Number(existing.stock);
      const newStock = data.stock ?? oldStock;
      const updated = await tx.product.update({
        where: { id: existing.id },
        data: {
          name: data.name?.trim(),
          sku: data.sku === undefined ? undefined : data.sku || null,
          barcode: data.barcode === undefined ? undefined : data.barcode || null,
          price: data.price,
          costPrice: data.costPrice,
          category: data.category === undefined ? undefined : data.category || null,
          unit: data.unit,
          stock: data.stock,
          minStock: data.minStock,
          image: data.image,
          isActive: data.isActive,
        },
      });
      if (newStock !== oldStock) {
        await tx.stockMovement.create({
          data: {
            userId,
            productId: existing.id,
            type: "ADJUSTMENT",
            quantity: newStock - oldStock,
            stockBefore: oldStock,
            stockAfter: newStock,
            note: "Koreksi stok dari data produk",
          },
        });
      }
      return updated;
    });
    return c.json({ message: "Produk berhasil diperbarui", product: serializeProduct(product) });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return c.json({ error: "SKU atau barcode sudah digunakan" }, 409);
    }
    throw error;
  }
});

products.post("/:id/stock", async (c) => {
  const { userId } = c.get("user");
  const parsed = adjustmentSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);

  const product = await prisma.product.findFirst({ where: { id: c.req.param("id"), userId } });
  if (!product) return c.json({ error: "Produk tidak ditemukan" }, 404);
  const before = Number(product.stock);
  const after = before + parsed.data.quantity;
  if (after < 0) return c.json({ error: "Stok tidak boleh menjadi negatif" }, 400);

  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.product.updateMany({
      where: { id: product.id, userId, stock: product.stock },
      data: { stock: after },
    });
    if (changed.count !== 1) throw new Error("Stok berubah. Muat ulang dan coba lagi.");
    await tx.stockMovement.create({
      data: {
        userId,
        productId: product.id,
        type: parsed.data.type,
        quantity: parsed.data.quantity,
        stockBefore: before,
        stockAfter: after,
        note: parsed.data.note,
      },
    });
    return tx.product.findUniqueOrThrow({ where: { id: product.id } });
  });

  return c.json({ message: "Stok berhasil diperbarui", product: serializeProduct(updated) });
});

products.delete("/:id", async (c) => {
  const { userId } = c.get("user");
  const existing = await prisma.product.findFirst({ where: { id: c.req.param("id"), userId } });
  if (!existing) return c.json({ error: "Produk tidak ditemukan" }, 404);
  await prisma.product.update({ where: { id: existing.id }, data: { isActive: false } });
  return c.json({ message: "Produk diarsipkan. Riwayat penjualan tetap tersimpan." });
});

export default products;
