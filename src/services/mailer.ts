import nodemailer from "nodemailer";

// ─── Logo ─────────────────────────────────────────────────────
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://catatin.lumicloud.my.id";
const LOGO_URL = `${FRONTEND_URL}/logo/logo.png`;

// ─── Shared email wrapper ─────────────────────────────────────
function emailWrapper(title: string, content: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: 'Inter', -apple-system, sans-serif; background: #f5f5f7; margin: 0; padding: 0; }
    .container { max-width: 480px; margin: 40px auto; background: #ffffff; border-radius: 24px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 32px; text-align: center; }
    .header img { height: 48px; width: auto; margin-bottom: 8px; }
    .header h1 { color: #ffffff; font-size: 20px; margin: 8px 0 0; font-weight: 600; }
    .body { padding: 32px; }
    .body p { color: #4a4a6a; font-size: 15px; line-height: 1.6; margin: 0 0 16px; }
    .cta-button { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #4f3786 0%, #63597c 100%); color: #ffffff; text-decoration: none; border-radius: 12px; font-size: 16px; font-weight: 600; margin: 16px 0; }
    .otp-code { font-size: 40px; font-weight: 700; letter-spacing: 8px; text-align: center; color: #1a1a2e; background: #f5f5f7; padding: 20px; border-radius: 16px; margin: 24px 0; font-family: 'SF Mono', monospace; }
    .link-box { word-break: break-all; font-size: 13px; color: #4f3786; background: #f5f5f7; padding: 16px; border-radius: 12px; margin: 16px 0; }
    .footer { text-align: center; padding: 24px 32px; border-top: 1px solid #eee; }
    .footer p { color: #8e8ea0; font-size: 13px; margin: 4px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <img src="${LOGO_URL}" alt="Catatin" />
      <h1>${title}</h1>
    </div>
    <div class="body">
      ${content}
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} Catatin. All rights reserved.</p>
      <p>Financial Intelligence</p>
    </div>
  </div>
</body>
</html>`;
}

// ─── Transporter ──────────────────────────────────────────────
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });

  transporter
    .verify()
    .then(() => console.log("[Mailer] SMTP ready ✅"))
    .catch((err) =>
      console.warn(
        "[Mailer] SMTP verify failed (will retry on send):",
        err.message,
      ),
    );

  return transporter;
}

const FROM = `"Catatin" <${process.env.SMTP_FROM || "noreply@catatin.app"}>`;

// ─── Send OTP Email (REGISTER only) ───────────────────────────
export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  const content = `
      <p>Halo,</p>
      <p>Terima kasih telah mendaftar di Catatin! Gunakan kode OTP berikut untuk verifikasi akun Anda:</p>
      <div class="otp-code">${otp}</div>
      <p>Kode ini berlaku selama <strong>10 menit</strong>.</p>
      <p style="color: #8e8ea0; font-size: 13px;">Jika Anda tidak melakukan pendaftaran, abaikan email ini.</p>`;

  const html = emailWrapper("Verifikasi Akun", content);
  await doSend(to, "Verifikasi Akun", html);
}

// ─── Send Recovery Email (link, not OTP) ──────────────────────
export async function sendRecoveryEmail(
  to: string,
  resetLink: string,
): Promise<void> {
  const content = `
      <p>Halo,</p>
      <p>Kami menerima permintaan reset password untuk akun Anda. Klik tombol di bawah ini untuk membuat password baru:</p>
      <div style="text-align:center;">
        <a href="${resetLink}" class="cta-button" style="color:#ffffff !important;">Reset Password</a>
      </div>
      <p style="color: #8e8ea0; font-size: 13px; margin-top: 20px;">Atau salin link berikut ke browser Anda:</p>
      <div class="link-box">${resetLink}</div>
      <p>Link ini berlaku selama <strong>15 menit</strong>.</p>
      <p style="color: #8e8ea0; font-size: 13px;">Jika Anda tidak meminta reset password, abaikan email ini — akun Anda tetap aman.</p>`;

  const html = emailWrapper("Reset Password", content);
  await doSend(to, "Reset Password Catatin", html);
}

// ─── Send generic email ───────────────────────────────────────
export async function sendEmail(
  to: string,
  subject: string,
  bodyHtml: string,
): Promise<void> {
  const html = emailWrapper(subject, bodyHtml);
  await doSend(to, subject, html);
}

// ─── Internal sender ──────────────────────────────────────────
async function doSend(
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const t = getTransporter();
  if (t) {
    try {
      await t.sendMail({ from: FROM, to, subject, html });
      console.log(`[Mailer] "${subject}" sent to ${to} via SMTP`);
    } catch (err: any) {
      console.error(
        `[Mailer] Failed to send "${subject}" to ${to}:`,
        err.message,
      );
      transporter = null; // invalidate so next attempt retries fresh
    }
  } else {
    console.log(
      `[Mailer] "${subject}" would be sent to ${to} (SMTP not configured)`,
    );
  }
}

export default transporter;
