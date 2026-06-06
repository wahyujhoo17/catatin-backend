import "dotenv/config"; // ⚠️ Harus paling atas — load .env sebelum modul lain

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { errorMiddleware } from "./middleware/error";
import { rateLimit } from "./middleware/rateLimit";
import { startWorkers } from "./workers";
import authRoutes from "./routes/auth";
import workspaceRoutes from "./routes/workspace";
import productRoutes from "./routes/product";
import categoryRoutes from "./routes/category";
import transactionRoutes from "./routes/transaction";
import walletRoutes from "./routes/wallet";
import kasbonRoutes from "./routes/kasbon";
import budgetRoutes from "./routes/budget";
import aiRoutes from "./routes/ai";
import settingsRoutes from "./routes/settings";
import dashboardRoutes from "./routes/dashboard";

const app = new Hono();

// ─── GLOBAL MIDDLEWARE ────────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || "https://catatin.lumicloud.my.id",
  "http://localhost:3000",
  "http://localhost:3001",
].filter(Boolean) as string[];

app.use(
  "*",
  cors({
    origin: (origin) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return origin;
      const found = ALLOWED_ORIGINS.find((allowed) => origin === allowed);
      if (found) return found;
      // In development, allow any origin
      if (process.env.NODE_ENV !== "production") return origin;
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: [
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
    ],
    maxAge: 86400,
  }),
);
app.use("*", async (c, next) => {
  // ─── Body size limit: 10 MB ──────────────────────────────
  const contentLength = parseInt(c.req.header("content-length") || "0", 10);
  if (contentLength > 10 * 1024 * 1024) {
    return c.json(
      { error: "Request body terlalu besar. Maksimal 10 MB." },
      413,
    );
  }
  await next();
});
app.use("*", logger());
app.use("*", compress());
app.use("*", rateLimit({ windowMs: 60 * 1000, max: 60 }));
app.onError(errorMiddleware);

// ─── HEALTH CHECK ─────────────────────────────────────────────
app.get("/", (c) => c.json({ status: "ok", service: "catatin-api" }));

// ─── ROUTES ───────────────────────────────────────────────────
app.route("/api/auth", authRoutes);
app.route("/api/workspaces", workspaceRoutes);
app.route("/api/products", productRoutes);
app.route("/api/categories", categoryRoutes);
app.route("/api/transactions", transactionRoutes);
app.route("/api/wallet", walletRoutes);
app.route("/api/kasbon", kasbonRoutes);
app.route("/api/budgets", budgetRoutes);
app.route("/api/ai", aiRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/dashboard", dashboardRoutes);

// ─── START ────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || "4000");

// Start background workers (Bull MQ)
startWorkers();

console.log(`🚀 Catatin API running on http://localhost:${port}`);

serve({ fetch: app.fetch, port });

// ─── Graceful shutdown ────────────────────────────────────────
async function shutdown(signal: string) {
  console.log(`[Server] ${signal} received — shutting down...`);
  const { closeQueues } = await import("./lib/queue");
  await closeQueues();
  const prisma = (await import("./lib/prisma")).default;
  await prisma.$disconnect();
  console.log("[Server] Goodbye.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
