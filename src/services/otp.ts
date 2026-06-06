import { emailQueue, whatsappQueue } from "../lib/queue";
import { normalizePhone } from "../lib/phone";

export interface SendOtpParams {
  to: string; // email
  phone?: string; // phone number for WA
  otp: string;
  type: "REGISTER" | "FORGOT_PASSWORD";
}

// ─── Send OTP via all available channels (queued) ─────────────
export async function sendOtpNotification(
  params: SendOtpParams,
): Promise<void> {
  const { to, phone: rawPhone, otp, type } = params;
  const phone = normalizePhone(rawPhone);

  // Queue email — diproses background oleh worker
  await emailQueue.add({
    type: "OTP",
    to,
    otp,
  });

  // Queue WhatsApp jika nomor HP tersedia
  if (phone) {
    await whatsappQueue.add({
      type: "OTP",
      to: phone,
      otp,
    });
  }

  // Logging langsung (fast, no blocking)
  console.log(
    `[OTP] Queued for ${to}: ${otp}${phone ? ` (WA: ${phone})` : ""}`,
  );
}
