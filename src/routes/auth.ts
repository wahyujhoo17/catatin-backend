import { Hono } from "hono";
import bcrypt from "bcrypt";
import { OAuth2Client } from "google-auth-library";
import prisma from "../lib/prisma";
import {
  signAccessToken,
  signRefreshToken,
  signResetToken,
  verifyResetToken,
} from "../lib/jwt";
import { authMiddleware } from "../middleware/auth";
import { sendOtpNotification } from "../services/otp";
import { sendRecoveryEmail } from "../services/mailer";
import { sendWhatsApp } from "../services/wavo";
import { normalizePhone } from "../lib/phone";
import { verifyTurnstile } from "../lib/turnstile";
import {
  checkLoginLockout,
  recordLoginAttempt,
  resetLoginAttempts,
} from "../lib/login-protection";
import {
  registerSchema,
  loginSchema,
  verifyOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../validators";

const auth = new Hono();

// ─── Google OAuth Client ──────────────────────────────────────
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

// ─── Helper: deteksi email vs nomor HP ────────────────────────
function isEmail(val: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
}

// ─── Helper: buat token & session ─────────────────────────────
async function createSession(userId: string, email: string) {
  const token = signAccessToken({ userId, email });
  const refreshToken = signRefreshToken({ userId, email });

  await prisma.session.create({
    data: {
      userId,
      refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  return { token, refreshToken };
}

// ─── GOOGLE OAuth: Redirect ke consent screen ─────────────────
auth.get("/google", (c) => {
  const authUrl = googleClient.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    prompt: "select_account",
  });
  return c.redirect(authUrl);
});

// ─── GOOGLE OAuth: Callback ───────────────────────────────────
auth.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    const error = c.req.query("error");
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    return c.redirect(
      `${frontendUrl}/login?error=${encodeURIComponent(error || "Google auth dibatalkan")}`,
    );
  }

  try {
    // Tukar code dengan token
    const { tokens } = await googleClient.getToken(code);
    const idToken = tokens.id_token;

    if (!idToken) {
      throw new Error("Gagal mendapatkan token dari Google");
    }

    // Verifikasi & decode id_token
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new Error("Gagal mendapatkan info user dari Google");
    }

    const googleId = payload.sub;
    const email = payload.email.toLowerCase().trim();
    const name = payload.name || payload.email.split("@")[0];
    const avatar = payload.picture || null;

    // Cek apakah user sudah ada by googleId
    let user = await prisma.user.findUnique({ where: { googleId } });

    if (!user) {
      // Cek apakah email sudah terdaftar (manual register)
      const existingByEmail = await prisma.user.findUnique({
        where: { email },
      });

      if (existingByEmail) {
        // Link Google account ke existing user
        user = await prisma.user.update({
          where: { id: existingByEmail.id },
          data: {
            googleId,
            avatar: avatar || existingByEmail.avatar,
          },
        });
      } else {
        // Buat user baru
        user = await prisma.user.create({
          data: {
            email,
            googleId,
            name,
            avatar,
            // password null — Google users have no password
          },
        });

        // Buat OTP dummy supaya dianggap "verified"
        await prisma.otpCode.create({
          data: {
            userId: user.id,
            code: "GOOGLE",
            type: "REGISTER",
            used: true,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          },
        });
      }
    }

    const { token, refreshToken } = await createSession(user.id, user.email);

    // Redirect ke frontend callback page
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const callbackUrl = new URL(`${frontendUrl}/auth/callback`);
    callbackUrl.searchParams.set("token", token);
    callbackUrl.searchParams.set("refreshToken", refreshToken);
    callbackUrl.searchParams.set("name", user.name);
    callbackUrl.searchParams.set("email", user.email);
    callbackUrl.searchParams.set("mode", user.mode || "PERSONAL");

    return c.redirect(callbackUrl.toString());
  } catch (err) {
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const errorMsg = err instanceof Error ? err.message : "Google auth gagal";
    return c.redirect(
      `${frontendUrl}/login?error=${encodeURIComponent(errorMsg)}`,
    );
  }
});

// ─── REGISTER ─────────────────────────────────────────────────
auth.post("/register", async (c) => {
  const body = await c.req.json();
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  const {
    name,
    email: emailOrPhone,
    password: rawPassword,
    cfTurnstileToken,
  } = parsed.data;

  // ─── Turnstile verification ──────────────────────────────
  const turnstile = await verifyTurnstile(cfTurnstileToken);
  if (!turnstile.success) {
    return c.json(
      { error: turnstile.error || "Verifikasi keamanan gagal" },
      400,
    );
  }

  // Deteksi: input adalah email atau nomor HP?
  let email: string;
  let phone: string | null = null;

  if (isEmail(emailOrPhone)) {
    email = emailOrPhone.toLowerCase().trim();
  } else {
    phone = normalizePhone(emailOrPhone);
    if (!phone) {
      return c.json({ error: "Nomor HP tidak valid" }, 400);
    }
    email = `hp_${phone}@catatin.app`;
  }

  // Check existing user — cek by email DAN by phone
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, phone ? { phone } : {}].filter(Boolean) },
  });

  if (existing) {
    const alreadyVerified = await prisma.otpCode.findFirst({
      where: { userId: existing.id, type: "REGISTER", used: true },
    });

    if (alreadyVerified) {
      // Cek apakah duplikat karena phone vs email
      if (phone && existing.phone === phone) {
        return c.json({ error: "Nomor HP sudah terdaftar" }, 409);
      }
      return c.json({ error: "Email sudah terdaftar" }, 409);
    }

    // User belum verifikasi — izinkan re-register
    const hashedPassword = await bcrypt.hash(rawPassword, 12);
    await prisma.user.update({
      where: { id: existing.id },
      data: { name, email, phone, password: hashedPassword },
    });

    await prisma.otpCode.updateMany({
      where: { userId: existing.id, type: "REGISTER", used: false },
      data: { used: true },
    });

    const newOtp = Math.floor(1000 + Math.random() * 9000).toString();
    await prisma.otpCode.create({
      data: {
        userId: existing.id,
        code: newOtp,
        type: "REGISTER",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await sendOtpNotification({
      to: existing.email,
      phone: phone || existing.phone || undefined,
      otp: newOtp,
      type: "REGISTER",
    });

    return c.json(
      {
        message:
          "Akun sudah ada tapi belum diverifikasi. OTP baru telah dikirim.",
        email: existing.email,
        registrationType: phone ? "phone" : "email",
      },
      200,
    );
  }

  const hashedPassword = await bcrypt.hash(rawPassword, 12);
  const user = await prisma.user.create({
    data: { name, email, phone, password: hashedPassword },
  });

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  await prisma.otpCode.create({
    data: {
      userId: user.id,
      code: otp,
      type: "REGISTER",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  await sendOtpNotification({
    to: user.email,
    phone: user.phone || undefined,
    otp,
    type: "REGISTER",
  });

  return c.json(
    {
      message: "Registrasi berhasil. Silakan verifikasi OTP.",
      email: user.email,
      registrationType: phone ? "phone" : "email",
    },
    201,
  );
});

// ─── VERIFY OTP ───────────────────────────────────────────────
auth.post("/verify-otp", async (c) => {
  const body = await c.req.json();
  const parsed = verifyOtpSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  const { email: identifier, code } = parsed.data;

  // Cari user by synthetic email ATAU by phone ATAU by real email
  let user = await prisma.user.findUnique({
    where: { email: identifier },
  });

  // Jika tidak ketemu, coba cari by phone (user input nomor HP langsung)
  if (!user) {
    const normalizedPhone = normalizePhone(identifier);
    if (normalizedPhone) {
      // Cari by phone field, atau by synthetic email hp_*@catatin.app
      const syntheticEmail = `hp_${normalizedPhone}@catatin.app`;
      user = await prisma.user.findFirst({
        where: { OR: [{ phone: normalizedPhone }, { email: syntheticEmail }] },
      });
    }
  }

  // Jika tidak ketemu juga, coba asumsikan itu synthetic email (hp_*@catatin.app)
  // yang terbentuk dari nomor HP
  if (
    !user &&
    identifier.startsWith("hp_") &&
    identifier.endsWith("@catatin.app")
  ) {
    const phoneFromSynthetic = identifier
      .replace("hp_", "")
      .replace("@catatin.app", "");
    const normalizedPhone = normalizePhone(phoneFromSynthetic);
    if (normalizedPhone) {
      user = await prisma.user.findFirst({
        where: { OR: [{ phone: normalizedPhone }, { email: identifier }] },
      });
    }
  }

  if (!user) return c.json({ error: "User tidak ditemukan" }, 404);

  const otpRecord = await prisma.otpCode.findFirst({
    where: {
      userId: user.id,
      code,
      used: false,
      expiresAt: { gte: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!otpRecord) {
    return c.json(
      { error: "Kode OTP tidak valid atau sudah kedaluwarsa" },
      400,
    );
  }

  await prisma.otpCode.update({
    where: { id: otpRecord.id },
    data: { used: true },
  });

  const token = signAccessToken({ userId: user.id, email: user.email });
  const refreshToken = signRefreshToken({ userId: user.id, email: user.email });

  // Simpan session
  await prisma.session.create({
    data: {
      userId: user.id,
      refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  return c.json({
    message: "Verifikasi berhasil",
    token,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, mode: user.mode },
  });
});

// ─── LOGIN ────────────────────────────────────────────────────
auth.post("/login", async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  const { email: emailOrPhone, password, cfTurnstileToken } = parsed.data;

  // ─── Turnstile verification ──────────────────────────────
  const turnstile = await verifyTurnstile(cfTurnstileToken);
  if (!turnstile.success) {
    return c.json(
      { error: turnstile.error || "Verifikasi keamanan gagal" },
      400,
    );
  }

  // --- Brute-force check (Redis-based) ---
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown";

  const lockoutKey = emailOrPhone.toLowerCase().trim();
  const { isLocked, lockTtlSeconds } = await checkLoginLockout(lockoutKey, ip);
  if (isLocked) {
    return c.json(
      {
        error: `Terlalu banyak percobaan login. Coba lagi dalam ${Math.ceil(lockTtlSeconds / 60)} menit.`,
      },
      429,
      { "Retry-After": String(lockTtlSeconds) },
    );
  }

  // Cari user by email ATAU by nomor HP
  let user;
  if (isEmail(emailOrPhone)) {
    user = await prisma.user.findUnique({
      where: { email: emailOrPhone.toLowerCase().trim() },
    });
  } else {
    const normalizedPhone = normalizePhone(emailOrPhone);
    if (normalizedPhone) {
      user = await prisma.user.findFirst({
        where: { phone: normalizedPhone },
      });
    }
  }

  if (!user) {
    await recordLoginAttempt(lockoutKey, ip, false);
    return c.json({ error: "Email atau password salah" }, 401);
  }

  // Google-only user — tidak bisa login dengan password
  if (!user.password) {
    return c.json(
      { error: "Akun ini menggunakan Google. Silakan login dengan Google." },
      400,
    );
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    await recordLoginAttempt(lockoutKey, ip, false);
    return c.json({ error: "Email atau password salah" }, 401);
  }

  // --- Pastikan user sudah verifikasi OTP ---
  const verifiedOtp = await prisma.otpCode.findFirst({
    where: {
      userId: user.id,
      type: "REGISTER",
      used: true,
    },
  });

  if (!verifiedOtp) {
    return c.json(
      {
        error:
          "Akun belum diverifikasi. Silakan verifikasi OTP terlebih dahulu.",
        code: "UNVERIFIED",
        email: user.email,
      },
      403,
    );
  }

  // --- Login sukses — reset attempt counter ---
  await resetLoginAttempts(lockoutKey, ip);

  const token = signAccessToken({ userId: user.id, email: user.email });
  const refreshToken = signRefreshToken({ userId: user.id, email: user.email });

  await prisma.session.create({
    data: {
      userId: user.id,
      refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  return c.json({
    message: "Login berhasil",
    token,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, mode: user.mode },
  });
});

// ─── FORGOT PASSWORD ──────────────────────────────────────────
auth.post("/forgot-password", async (c) => {
  const body = await c.req.json();
  const parsed = forgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  const { email: emailOrPhone, cfTurnstileToken } = parsed.data;

  // ─── Turnstile verification ──────────────────────────────
  const turnstile = await verifyTurnstile(cfTurnstileToken);
  if (!turnstile.success) {
    return c.json(
      { error: turnstile.error || "Verifikasi keamanan gagal" },
      400,
    );
  }

  // Cari user by email ATAU by nomor HP
  let user;
  let isPhoneInput = false;
  let normalizedPhone: string | null = null;

  if (isEmail(emailOrPhone)) {
    user = await prisma.user.findUnique({
      where: { email: emailOrPhone.toLowerCase().trim() },
    });
  } else {
    normalizedPhone = normalizePhone(emailOrPhone);
    if (normalizedPhone) {
      isPhoneInput = true;
      user = await prisma.user.findFirst({
        where: { phone: normalizedPhone },
      });
    }
  }

  if (!user) return c.json({ error: "Akun tidak ditemukan" }, 404);

  // Google-only user — tidak bisa reset password
  if (!user.password) {
    return c.json(
      {
        error: "Akun ini menggunakan Google. Silakan login dengan Google.",
      },
      400,
    );
  }

  // ─── Input nomor HP → kirim link reset via WhatsApp ──────────
  if (isPhoneInput && normalizedPhone) {
    const resetToken = signResetToken({
      userId: user.id,
      email: user.email,
      purpose: "reset-password",
    });

    const frontendUrl =
      process.env.FRONTEND_URL || "https://catatin.lumicloud.my.id";
    const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

    // Kirim link via WhatsApp
    await sendWhatsApp(
      normalizedPhone,
      `🔐 *Catatin — Reset Password*\n\nKlik link berikut untuk membuat password baru:\n${resetLink}\n\nLink berlaku selama 15 menit.\nJika Anda tidak meminta reset, abaikan pesan ini.\n\n— Catatin Financial Intelligence`,
    );

    return c.json({
      message: "Link reset password telah dikirim via WhatsApp",
      type: "phone",
    });
  }

  // ─── Input email → kirim recovery link ────────────────────────
  const resetToken = signResetToken({
    userId: user.id,
    email: user.email,
    purpose: "reset-password",
  });

  const frontendUrl =
    process.env.FRONTEND_URL || "https://catatin.lumicloud.my.id";
  const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

  // Kirim email recovery link
  await sendRecoveryEmail(user.email, resetLink);

  return c.json({
    message: "Link reset password telah dikirim ke email Anda",
    type: "email",
  });
});

// ─── RESET PASSWORD ───────────────────────────────────────────
auth.post("/reset-password", async (c) => {
  const body = await c.req.json();
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  const { token, password } = parsed.data;

  // Verifikasi reset token
  let payload;
  try {
    payload = verifyResetToken(token);
  } catch {
    return c.json(
      { error: "Link reset tidak valid atau sudah kedaluwarsa" },
      400,
    );
  }

  if (payload.purpose !== "reset-password") {
    return c.json({ error: "Token tidak valid" }, 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
  });
  if (!user) return c.json({ error: "User tidak ditemukan" }, 404);

  const hashedPassword = await bcrypt.hash(password, 12);
  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashedPassword },
  });

  return c.json({ message: "Password berhasil direset. Silakan login." });
});

// ─── GET PROFILE ──────────────────────────────────────────────
auth.get("/me", authMiddleware, async (c) => {
  const { userId } = c.get("user");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      mode: true,
      createdAt: true,
    },
  });
  return c.json({ user });
});

// ─── UPDATE MODE (POS / PERSONAL) ─────────────────────────────
auth.patch("/mode", authMiddleware, async (c) => {
  const { userId } = c.get("user");
  const body = await c.req.json();
  const { mode } = body;

  if (!["POS", "PERSONAL"].includes(mode)) {
    return c.json({ error: "Mode harus POS atau PERSONAL" }, 400);
  }

  await prisma.user.update({ where: { id: userId }, data: { mode } });
  return c.json({ message: "Mode berhasil diperbarui", mode });
});

export default auth;
