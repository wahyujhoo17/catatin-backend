import { startEmailWorker } from "./email";
import { startWhatsAppWorker } from "./whatsapp";

// ─── Start all background workers ─────────────────────────────
export function startWorkers(): void {
  startEmailWorker();
  startWhatsAppWorker();
  console.log("[Workers] All background workers started");
}
