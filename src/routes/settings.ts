import { Hono } from "hono";
import prisma from "../lib/prisma";
import redis from "../lib/redis";
import { authMiddleware } from "../middleware/auth";
import { sendOtpNotification } from "../services/otp";
import { normalizePhone } from "../lib/phone";

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
  alertThreshold?: number;
  elevenLabsApiKey?: string;
}

const DEFAULT_CONFIG: CustomAiConfig = {
  enabled: false,
  provider: "openai",
  baseUrl: "",
  apiKey: "",
  model: "",
  alertThreshold: 500000,
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

  const { enabled, provider, baseUrl, apiKey, model, alertThreshold, elevenLabsApiKey } = body;

  // Validasi jika enabled
  if (enabled) {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return c.json({ error: "API Key wajib diisi saat Custom AI aktif" }, 400);
    }
    if (!provider || typeof provider !== "string") {
      return c.json({ error: "Provider wajib dipilih" }, 400);
    }
  }

  // Preserve existing config to not overwrite unpassed fields like alertThreshold if it's undefined
  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { customAiConfig: true },
  });
  const currentConfig = (dbUser?.customAiConfig as unknown as CustomAiConfig) || DEFAULT_CONFIG;

  const config: CustomAiConfig = {
    enabled: enabled === true,
    provider: provider || DEFAULT_CONFIG.provider,
    baseUrl: (baseUrl || "").trim(),
    apiKey: (apiKey || "").trim(),
    model: (model || "").trim(),
    alertThreshold: alertThreshold !== undefined ? Number(alertThreshold) : currentConfig.alertThreshold,
    elevenLabsApiKey: elevenLabsApiKey !== undefined ? (elevenLabsApiKey as string).trim() : currentConfig.elevenLabsApiKey,
  };

  await prisma.user.update({
    where: { id: user.userId },
    data: { customAiConfig: config as any },
  });

  return c.json({ success: true, config });
});

// ─── HELPERS: rate limiter khusus OTP profile ─────────────────
const OTP_REQUEST_LIMIT = 3; // max 3 request per window
const OTP_REQUEST_WINDOW = 5 * 60; // 5 menit (detik)

async function checkOtpRequestLimit(userId: string): Promise<boolean> {
  if (!redis) return true;
  const key = `otp_req:profile:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, OTP_REQUEST_WINDOW);
  return count <= OTP_REQUEST_LIMIT;
}

// ─── Helper: mask email/phone ─────────────────────────────────
function maskEmail(email: string): string {
  return email.replace(/(.{2}).*(@.*)/, "$1***$2");
}
function maskPhone(phone: string): string {
  return phone.slice(0, -4).replace(/\d/g, "*") + phone.slice(-4);
}

// ─── Helper: generate & store OTP, then send to chosen channel ─
async function generateAndSendOtp(
  userId: string,
  dbUser: { email: string; phone: string | null },
  channel: "email" | "whatsapp",
): Promise<{ otp: string; maskedTarget: string }> {
  const otp = Math.floor(1000 + Math.random() * 9000).toString();

  // Invalidate OTP sebelumnya
  await prisma.otpCode.updateMany({
    where: { userId, type: "PROFILE_CHANGE", used: false },
    data: { used: true },
  });

  // Simpan OTP baru
  await prisma.otpCode.create({
    data: {
      userId,
      code: otp,
      type: "PROFILE_CHANGE",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  if (channel === "email") {
    await sendOtpNotification({
      to: dbUser.email,
      otp,
      type: "PROFILE_CHANGE",
    });
    return { otp, maskedTarget: maskEmail(dbUser.email) };
  } else {
    const currentPhone = dbUser.phone ? normalizePhone(dbUser.phone) : null;
    if (!currentPhone) {
      throw new Error("Nomor HP tidak tersedia untuk mengirim OTP");
    }
    await sendOtpNotification({
      to: dbUser.email,
      phone: currentPhone,
      otp,
      type: "PROFILE_CHANGE",
    });
    return { otp, maskedTarget: maskPhone(currentPhone) };
  }
}

// ─── POST /api/settings/profile/request-otp ──────────────────
// Kirim OTP untuk verifikasi identitas sebelum ganti email/phone.
// User bisa pilih channel: "email" (default) atau "whatsapp".
settingsRoutes.post("/profile/request-otp", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const { name, email, phone, channel = "email" } = body;

  if (!name && !email && !phone) {
    return c.json({ error: "Tidak ada perubahan yang diminta" }, 400);
  }

  if (!["email", "whatsapp"].includes(channel)) {
    return c.json({ error: "Channel harus 'email' atau 'whatsapp'" }, 400);
  }

  // Rate limit
  if (!(await checkOtpRequestLimit(user.userId))) {
    return c.json(
      { error: "Terlalu banyak permintaan OTP. Coba lagi dalam 5 menit." },
      429,
    );
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { id: true, email: true, phone: true, name: true },
  });
  if (!dbUser) return c.json({ error: "User tidak ditemukan" }, 404);

  // ─── Tentukan channel yang tersedia ──────────────────────
  const currentPhone = dbUser.phone ? normalizePhone(dbUser.phone) : null;
  const availableChannels: string[] = [];
  if (dbUser.email && !dbUser.email.startsWith("hp_"))
    availableChannels.push("email");
  if (currentPhone) availableChannels.push("whatsapp");

  // Jika channel yang dipilih tidak tersedia, fallback
  const chosenChannel = availableChannels.includes(channel)
    ? channel
    : availableChannels[0];
  if (!chosenChannel) {
    return c.json({ error: "Tidak ada channel verifikasi yang tersedia" }, 400);
  }

  // ─── Validasi perubahan email ────────────────────────────
  let changes: Record<string, string> = {};
  if (name && name !== dbUser.name) changes.name = name;

  if (email && email !== dbUser.email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: "Format email tidak valid" }, 400);
    }
    const dup = await prisma.user.findFirst({
      where: { email: email.toLowerCase().trim(), id: { not: user.userId } },
    });
    if (dup) return c.json({ error: "Email sudah digunakan akun lain" }, 409);
    changes.email = email.toLowerCase().trim();
  }

  if (phone && phone !== (dbUser.phone || "")) {
    const nPhone = normalizePhone(phone);
    if (!nPhone) return c.json({ error: "Nomor HP tidak valid" }, 400);
    const dup = await prisma.user.findFirst({
      where: { phone: nPhone, id: { not: user.userId } },
    });
    if (dup)
      return c.json({ error: "Nomor HP sudah digunakan akun lain" }, 409);
    changes.phone = nPhone;
  }

  // ─── Hanya ganti nama ➔ langsung update ──────────────────
  if (Object.keys(changes).length === 1 && changes.name) {
    await prisma.user.update({
      where: { id: user.userId },
      data: { name: changes.name },
    });
    return c.json({ message: "Nama berhasil diubah", directUpdate: true });
  }

  if (Object.keys(changes).length === 0) {
    return c.json({ error: "Tidak ada perubahan baru yang terdeteksi" }, 400);
  }

  // ─── Generate OTP & kirim ke channel yang dipilih ─────────
  try {
    const { maskedTarget } = await generateAndSendOtp(
      user.userId,
      dbUser,
      chosenChannel as "email" | "whatsapp",
    );

    return c.json({
      message:
        chosenChannel === "email"
          ? "Kode OTP telah dikirim ke email Anda"
          : "Kode OTP telah dikirim via WhatsApp",
      channel: chosenChannel,
      maskedTarget,
      availableChannels,
      changes,
    });
  } catch (err: unknown) {
    return c.json(
      { error: err instanceof Error ? err.message : "Gagal mengirim OTP" },
      400,
    );
  }
});

// ─── POST /api/settings/profile/confirm-change ───────────────
// Verifikasi OTP & terapkan perubahan email/phone
settingsRoutes.post("/profile/confirm-change", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const { code, changes } = body;

  if (!code || code.length !== 4) {
    return c.json({ error: "Kode OTP harus 4 digit" }, 400);
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { id: true, email: true, phone: true },
  });
  if (!dbUser) return c.json({ error: "User tidak ditemukan" }, 404);

  // ─── Rate limit: max 5 percobaan salah per OTP ─────────────
  const attemptsKey = `otp_attempts:${user.userId}`;
  const lockedKey = `otp_locked:${user.userId}`;

  if (redis) {
    const locked = await redis.get(lockedKey);
    if (locked) {
      const ttl = await redis.ttl(lockedKey);
      return c.json(
        {
          error: `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil(ttl / 60)} menit.`,
        },
        429,
      );
    }
  }

  // Cari OTP valid
  const otpRecord = await prisma.otpCode.findFirst({
    where: {
      userId: user.userId,
      code,
      type: "PROFILE_CHANGE",
      used: false,
      expiresAt: { gte: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!otpRecord) {
    // Track percobaan gagal
    if (redis) {
      const fails = await redis.incr(attemptsKey);
      if (fails === 1) await redis.expire(attemptsKey, 10 * 60);
      if (fails >= 5) {
        await redis.set(lockedKey, "1", "EX", 10 * 60); // lock 10 menit
        await prisma.otpCode.updateMany({
          where: { userId: user.userId, type: "PROFILE_CHANGE", used: false },
          data: { used: true }, // invalidasi semua OTP pending
        });
        return c.json(
          {
            error: "Terlalu banyak percobaan. Akun dikunci selama 10 menit.",
          },
          429,
        );
      }
    }

    return c.json(
      {
        error: "Kode OTP tidak valid atau sudah kedaluwarsa",
        attemptsLeft: redis
          ? Math.max(
              0,
              5 - (((await redis.get(attemptsKey)) as unknown as number) || 0),
            )
          : undefined,
      },
      400,
    );
  }

  // OTP valid → tandai terpakai
  await prisma.otpCode.update({
    where: { id: otpRecord.id },
    data: { used: true },
  });

  // Reset counter percobaan
  if (redis) {
    await redis.del(attemptsKey);
    await redis.del(lockedKey);
  }

  // ─── Terapkan perubahan ────────────────────────────────────
  console.log(
    "[confirm-change] Raw changes from body:",
    JSON.stringify(changes),
  );
  const updateData: Record<string, string> = {};
  if (changes?.name) updateData.name = changes.name;
  if (changes?.email) updateData.email = changes.email;
  if (changes?.phone) updateData.phone = changes.phone;

  console.log(
    "[confirm-change] Computed updateData:",
    JSON.stringify(updateData),
  );

  if (Object.keys(updateData).length === 0) {
    return c.json({ error: "Tidak ada perubahan untuk diterapkan" }, 400);
  }

  const updated = await prisma.user.update({
    where: { id: user.userId },
    data: updateData,
    select: { id: true, name: true, email: true, phone: true },
  });

  console.log(
    "[confirm-change] Update success, new user:",
    JSON.stringify(updated),
  );

  return c.json({
    message: "Profil berhasil diperbarui",
    user: updated,
  });
});

export default settingsRoutes;
