import { startEmailWorker } from "./email";
import { startNotificationWorker } from "./notification";
import { startWhatsAppWorker } from "./whatsapp";

// ─── Start all background workers ─────────────────────────────
export function startWorkers(): void {
  startEmailWorker();
  startWhatsAppWorker();
  startNotificationWorker();
  console.log("[Workers] All background workers started");
}
