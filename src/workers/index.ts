import { startEmailWorker } from "./email";
import { startNotificationWorker } from "./notification";
import { startWhatsAppWorker } from "./whatsapp";
import { startCronWorker, registerCronJobs } from "./cron";

// ─── Start all background workers ─────────────────────────────
export function startWorkers(): void {
  startEmailWorker();
  startWhatsAppWorker();
  startNotificationWorker();
  startCronWorker();
  registerCronJobs().catch((err) => console.error("[Workers] Gagal register cron jobs:", err));
  console.log("[Workers] All background workers started");
}
