import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";

const settingsRoutes = new Hono();

// ─── Semua settings routes require auth ───────────────────────
settingsRoutes.use("*", authMiddleware);

// ─── Types ────────────────────────────────────────────────────
interface CustomAiConfig {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULT_CONFIG: CustomAiConfig = {
  enabled: false,
  provider: "openai",
  baseUrl: "",
  apiKey: "",
  model: "",
};

// ─── GET /api/settings/ai-config ─────────────────────────────
settingsRoutes.get("/ai-config", async (c) => {
  const user = c.get("user");

  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { customAiConfig: true },
  });

  const config =
    (dbUser?.customAiConfig as unknown as CustomAiConfig) || DEFAULT_CONFIG;
  return c.json(config);
});

// ─── PATCH /api/settings/ai-config ───────────────────────────
settingsRoutes.patch("/ai-config", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();

  const { enabled, provider, baseUrl, apiKey, model } = body;

  // Validasi jika enabled
  if (enabled) {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return c.json({ error: "API Key wajib diisi saat Custom AI aktif" }, 400);
    }
    if (!provider || typeof provider !== "string") {
      return c.json({ error: "Provider wajib dipilih" }, 400);
    }
  }

  const config: CustomAiConfig = {
    enabled: enabled === true,
    provider: provider || DEFAULT_CONFIG.provider,
    baseUrl: (baseUrl || "").trim(),
    apiKey: (apiKey || "").trim(),
    model: (model || "").trim(),
  };

  await prisma.user.update({
    where: { id: user.userId },
    data: { customAiConfig: config as any },
  });

  return c.json({ success: true, config });
});

export default settingsRoutes;
