import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";

const workspaces = new Hono();
workspaces.use("*", authMiddleware);

// ─── GET CURRENT MODE ─────────────────────────────────────────
workspaces.get("/", async (c) => {
  const { userId } = c.get("user");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { mode: true },
  });

  return c.json({
    workspace: {
      mode: user?.mode ?? "PERSONAL",
    },
  });
});

// ─── SWITCH MODE ──────────────────────────────────────────────
workspaces.patch("/mode", async (c) => {
  const { userId } = c.get("user");
  const body = await c.req.json();
  const { mode } = body;

  if (!mode || !["POS", "PERSONAL"].includes(mode)) {
    return c.json({ error: "Mode harus POS atau PERSONAL" }, 400);
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { mode },
    select: { mode: true },
  });

  return c.json({ message: "Mode berhasil diubah", workspace: user });
});

export default workspaces;
