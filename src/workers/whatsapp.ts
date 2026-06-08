import { whatsappQueue } from "../lib/queue";
import { sendOtpWhatsApp, sendWhatsApp } from "../services/wavo";

// ─── Job types ────────────────────────────────────────────────
interface OtpWhatsAppJob {
  type: "OTP";
  to: string;
  otp: string;
  otpType: "REGISTER" | "FORGOT_PASSWORD" | "PROFILE_CHANGE";
}

interface GenericWhatsAppJob {
  type: "TEXT";
  to: string;
  message: string;
  typingDelay?: boolean;
}

type WhatsAppJob = OtpWhatsAppJob | GenericWhatsAppJob;

// ─── Process WhatsApp queue ───────────────────────────────────
export function startWhatsAppWorker(): void {
  whatsappQueue.process(async (job) => {
    const data = job.data as WhatsAppJob;

    switch (data.type) {
      case "OTP":
        await sendOtpWhatsApp(data.to, data.otp, data.otpType);
        break;
      case "TEXT":
        await sendWhatsApp(data.to, data.message, {
          typingDelay: data.typingDelay,
        });
        break;
    }
  });

  console.log("[Worker] WhatsApp worker started");
}
