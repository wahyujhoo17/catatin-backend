import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

let app: App | null = null;
let messaging: Messaging | null = null;

function getFirebaseAdmin(): { app: App; messaging: Messaging } | null {
  // Return cached if already initialized
  if (app && messaging) return { app, messaging };

  if (getApps().length > 0) {
    app = getApps()[0];
    messaging = getMessaging(app);
    return { app, messaging };
  }

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!base64) {
    console.warn(
      "[FirebaseAdmin] FIREBASE_SERVICE_ACCOUNT_BASE64 tidak diset — push notification dinonaktifkan.",
    );
    return null;
  }

  try {
    const serviceAccount = JSON.parse(
      Buffer.from(base64, "base64").toString("utf-8"),
    );

    app = initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });

    messaging = getMessaging(app);
    console.log("[FirebaseAdmin] Inisialisasi berhasil");
    return { app, messaging };
  } catch (err) {
    console.error("[FirebaseAdmin] Gagal inisialisasi:", err);
    return null;
  }
}

export { getFirebaseAdmin };
