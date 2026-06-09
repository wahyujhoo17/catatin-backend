import { notificationQueue } from "../lib/queue";
import { sendPushNotificationDirect, type PushNotificationPayload } from "../services/notification";

// ─── Process notification queue ──────────────────────────────
export function startNotificationWorker(): void {
  notificationQueue.process("push", async (job) => {
    const payload = job.data as PushNotificationPayload;

    console.log(`[Worker:Notification] Memproses job #${job.id} — ${payload.title}`);

    const result = await sendPushNotificationDirect(payload);

    console.log(
      `[Worker:Notification] Job #${job.id} selesai — terkirim: ${result.sent}, gagal: ${result.failed}`,
    );

    return result;
  });

  console.log("[Worker] Notification worker started");
}
