import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { sendPushNotification } from "../services/notification";

const notificationRoutes = new Hono();
notificationRoutes.use("*", authMiddleware);

// ─── GET /api/notifications — Daftar notifikasi user ──────────
notificationRoutes.get("/", async (c) => {
  const { userId } = c.get("user");
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "30");
  const skip = (page - 1) * limit;
  const filter = c.req.query("filter"); // "unread" | "read" | undefined (all)

  const where: Record<string, any> = { userId };
  if (filter === "unread") where.isRead = false;
  else if (filter === "read") where.isRead = true;

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.notification.count({ where }),
  ]);

  return c.json({
    notifications,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// ─── GET /api/notifications/unread-count ──────────────────────
notificationRoutes.get("/unread-count", async (c) => {
  const { userId } = c.get("user");
  const count = await prisma.notification.count({
    where: { userId, isRead: false },
  });
  return c.json({ count });
});

// ─── PATCH /api/notifications/:id/read — Tandai satu dibaca ──
notificationRoutes.patch("/:id/read", async (c) => {
  const { userId } = c.get("user");
  const id = c.req.param("id");

  const notif = await prisma.notification.findFirst({
    where: { id, userId },
  });

  if (!notif) {
    return c.json({ error: "Notifikasi tidak ditemukan" }, 404);
  }

  await prisma.notification.update({
    where: { id },
    data: { isRead: true },
  });

  return c.json({ message: "Notifikasi ditandai sudah dibaca" });
});

// ─── PATCH /api/notifications/read-all — Tandai semua dibaca ─
notificationRoutes.patch("/read-all", async (c) => {
  const { userId } = c.get("user");

  const result = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });

  return c.json({ message: `${result.count} notifikasi ditandai sudah dibaca` });
});

// ─── POST /api/notifications/admin-broadcast — Broadcast admin ─
notificationRoutes.post("/admin-broadcast", async (c) => {
  // TODO: Add admin role check in the future
  const body = await c.req.json();
  const { title, body: messageBody, clickAction } = body;

  if (!title || !messageBody) {
    return c.json({ error: "Title dan body wajib diisi" }, 400);
  }

  // Get all user IDs
  const allUsers = await prisma.user.findMany({
    select: { id: true },
  });
  const userIds = allUsers.map((u) => u.id);

  if (userIds.length === 0) {
    return c.json({ message: "Tidak ada user untuk di-broadcast" });
  }

  // Send push notification + persist to DB
  await sendPushNotification({
    userIds,
    title,
    body: messageBody,
    clickAction: clickAction || "/dashboard",
    type: "ADMIN_BROADCAST",
  });

  return c.json({
    message: `Broadcast berhasil dikirim ke ${userIds.length} user`,
  });
});

export default notificationRoutes;
