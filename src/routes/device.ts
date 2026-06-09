import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import prisma from "../lib/prisma";

const device = new Hono();

// ─── POST /api/auth/device-token — Save/update device token ────
device.post("/", authMiddleware, async (c) => {
  try {
    const user = c.get("user");
    const { token } = await c.req.json();

    if (!token || typeof token !== "string") {
      return c.json({ error: "Token tidak valid" }, 400);
    }

    // Upsert: update jika token sudah ada, create jika belum
    await prisma.deviceToken.upsert({
      where: { token },
      update: {
        userId: user.userId,
        updatedAt: new Date(),
      },
      create: {
        userId: user.userId,
        token,
        platform: "web",
      },
    });

    return c.json({ status: "ok" });
  } catch (err: any) {
    console.error("[DeviceToken] Gagal menyimpan:", err);
    return c.json(
      { error: err.message || "Gagal menyimpan device token" },
      500,
    );
  }
});

// ─── DELETE /api/auth/device-token — Remove device token ───────
device.delete("/", authMiddleware, async (c) => {
  try {
    const user = c.get("user");
    const { token } = await c.req.json();

    if (!token) {
      return c.json({ error: "Token tidak valid" }, 400);
    }

    await prisma.deviceToken.deleteMany({
      where: { token, userId: user.userId },
    });

    return c.json({ status: "ok" });
  } catch (err: any) {
    console.error("[DeviceToken] Gagal menghapus:", err);
    return c.json(
      { error: err.message || "Gagal menghapus device token" },
      500,
    );
  }
});

export default device;
