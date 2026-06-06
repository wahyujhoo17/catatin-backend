import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";

const wallet = new Hono();
wallet.use("*", authMiddleware);

// ─── LIST ACCOUNTS ────────────────────────────────────────────
wallet.get("/", async (c) => {
  const { userId } = c.get("user");

  const accounts = await prisma.account.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  const total = accounts.reduce((sum, a) => sum + Number(a.balance), 0);

  return c.json({ accounts, total });
});

// ─── CREATE ACCOUNT ───────────────────────────────────────────
wallet.post("/", async (c) => {
  const { userId } = c.get("user");
  const body = await c.req.json();
  const { name, type, icon, color, initialBalance } = body;

  if (!name) return c.json({ error: "Nama akun harus diisi" }, 400);

  const account = await prisma.account.create({
    data: {
      userId,
      name,
      type: type ?? "CASH",
      balance: initialBalance ?? 0,
      icon: icon ?? null,
      color: color ?? null,
    },
  });

  return c.json({ message: "Akun berhasil ditambahkan", account }, 201);
});

// ─── TOP UP / UPDATE BALANCE ──────────────────────────────────
wallet.post("/:id/topup", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json();
  const { amount } = body;

  if (!amount || amount <= 0) {
    return c.json({ error: "Jumlah topup harus lebih dari 0" }, 400);
  }

  const existing = await prisma.account.findFirst({
    where: { id, userId },
  });
  if (!existing) return c.json({ error: "Akun tidak ditemukan" }, 404);

  const updated = await prisma.account.update({
    where: { id },
    data: { balance: { increment: amount } },
  });

  return c.json({ message: "Topup berhasil", account: updated });
});

// ─── UPDATE ACCOUNT ───────────────────────────────────────────
wallet.put("/:id", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await prisma.account.findFirst({
    where: { id, userId },
  });
  if (!existing) return c.json({ error: "Akun tidak ditemukan" }, 404);

  const account = await prisma.account.update({
    where: { id },
    data: {
      name: body.name ?? existing.name,
      type: body.type ?? existing.type,
      balance: body.balance ?? existing.balance,
      icon: body.icon !== undefined ? body.icon : existing.icon,
      color: body.color !== undefined ? body.color : existing.color,
    },
  });

  return c.json({ message: "Akun berhasil diperbarui", account });
});

// ─── DELETE ACCOUNT ───────────────────────────────────────────
wallet.delete("/:id", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.account.findFirst({
    where: { id, userId },
  });
  if (!existing) return c.json({ error: "Akun tidak ditemukan" }, 404);

  const txCount = await prisma.transaction.count({
    where: { accountId: id },
  });
  if (txCount > 0) {
    return c.json(
      { error: `Akun masih digunakan oleh ${txCount} transaksi` },
      400,
    );
  }

  await prisma.account.delete({ where: { id } });
  return c.json({ message: "Akun berhasil dihapus" });
});

export default wallet;
