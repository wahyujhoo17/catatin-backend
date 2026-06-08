import { emailQueue } from "../lib/queue";
import { sendOtpEmail, sendEmail } from "../services/mailer";

// ─── Job types ────────────────────────────────────────────────
interface OtpEmailJob {
  type: "OTP";
  to: string;
  otp: string;
  otpType?: "REGISTER" | "FORGOT_PASSWORD" | "PROFILE_CHANGE";
}

interface GenericEmailJob {
  type: "GENERIC";
  to: string;
  subject: string;
  html: string;
}

type EmailJob = OtpEmailJob | GenericEmailJob;

// ─── Process email queue ──────────────────────────────────────
export function startEmailWorker(): void {
  emailQueue.process(async (job) => {
    const data = job.data as EmailJob;

    switch (data.type) {
      case "OTP":
        await sendOtpEmail(data.to, data.otp, data.otpType);
        break;
      case "GENERIC":
        await sendEmail(data.to, data.subject, data.html);
        break;
    }
  });

  console.log("[Worker] Email worker started");
}
