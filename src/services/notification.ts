import { getFirebaseAdmin } from "../lib/firebase-admin";
import prisma from "../lib/prisma";
import { notificationQueue } from "../lib/queue";

// ─── Types ────────────────────────────────────────────────────
export interface PushNotificationPayload {
  userIds: string[]; // bisa satu atau banyak user
  title: string;
  body: string;
  icon?: string;
  clickAction?: string; // URL yang dibuka saat notifikasi diklik (default: /dashboard)
  data?: Record<string, string>;
}

// ─── Send via BullMQ Queue ────────────────────────────────────
export async function sendPushNotification(
  payload: PushNotificationPayload,
): Promise<{ queued: boolean; jobId?: string }> {
  try {
    const job = await notificationQueue.add("push", payload, {
      attempts: 2,
      backoff: { type: "fixed", delay: 5000 },
    });
    console.log(
      `[Notification] Job #${job.id} — ${payload.userIds.length} user(s)`,
    );
    return { queued: true, jobId: job.id?.toString() };
  } catch (err: any) {
    console.error("[Notification] Gagal queue:", err.message);
    return { queued: false };
  }
}

// ─── Direct send (tanpa queue) ────────────────────────────────
export async function sendPushNotificationDirect(
  payload: PushNotificationPayload,
): Promise<{ sent: number; failed: number }> {
  const admin = getFirebaseAdmin();
  if (!admin) {
    console.warn("[Notification] Firebase Admin tidak tersedia.");
    return { sent: 0, failed: payload.userIds.length };
  }

  // Ambil token device dari database
  const deviceTokens = await prisma.deviceToken.findMany({
    where: { userId: { in: payload.userIds } },
    select: { token: true },
  });

  const tokens = deviceTokens.map((d) => d.token);
  if (tokens.length === 0) {
    console.log(
      "[Notification] Tidak ada device token untuk user:",
      payload.userIds,
    );
    return { sent: 0, failed: 0 };
  }

  // Kirim multicast message
  const message = {
    notification: {
      title: payload.title,
      body: payload.body,
      ...(payload.icon ? { imageUrl: payload.icon } : {}),
    },
    webpush: {
      fcmOptions: {
        link: payload.clickAction || "/dashboard",
      },
      notification: {
        icon: payload.icon || "/icon-192.png",
        badge: "/icon-192.png",
        requireInteraction: true,
        actions: [
          { action: "open", title: "Buka" },
          { action: "dismiss", title: "Tutup" },
        ],
      },
    },
    data: payload.data || {},
    tokens,
  };

  const response = await admin.messaging.sendEachForMulticast(message);

  // Bersihkan token yang gagal (unregistered)
  const failedTokens: string[] = [];
  response.responses.forEach((resp, idx) => {
    if (!resp.success) {
      const err = resp.error;
      if (
        err?.code === "messaging/registration-token-not-registered" ||
        err?.code === "messaging/invalid-argument"
      ) {
        failedTokens.push(tokens[idx]);
      }
    }
  });

  if (failedTokens.length > 0) {
    await prisma.deviceToken.deleteMany({
      where: { token: { in: failedTokens } },
    });
    console.log(`[Notification] ${failedTokens.length} token invalid dihapus.`);
  }

  return { sent: response.successCount, failed: response.failureCount };
}
