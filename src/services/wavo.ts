const WAVO_BASE_URL = "https://api-usewavo.lumicloud.my.id/api/v1";
const WAVO_API_KEY = process.env.WAVO_API_KEY || "";
const WAVO_SERVICE_ID = process.env.WAVO_SERVICE_ID || "";

// ─── Send WhatsApp text message ───────────────────────────────
export async function sendWhatsApp(
  to: string,
  message: string,
  options?: { typingDelay?: boolean },
): Promise<{ success: boolean; data?: any; error?: string }> {
  if (!WAVO_API_KEY || !WAVO_SERVICE_ID) {
    console.warn(
      `[Wavo] Not configured — logged WA message to ${to}: ${message}`,
    );
    return { success: false, error: "Wavo not configured" };
  }

  try {
    const res = await fetch(`${WAVO_BASE_URL}/send/text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": WAVO_API_KEY,
        Authorization: `Bearer ${WAVO_SERVICE_ID}`,
      },
      body: JSON.stringify({
        serviceId: WAVO_API_KEY, // UUID, bukan secret key
        to,
        message,
        options: {
          typingDelay: options?.typingDelay ?? true,
        },
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("[Wavo] API error:", JSON.stringify(data, null, 2));
      return {
        success: false,
        error: data?.error?.message || data?.message || "Wavo API error",
      };
    }

    console.log(`[Wavo] Message sent to ${to}`);
    return { success: true, data };
  } catch (err: any) {
    console.error("[Wavo] Request failed:", err.message);
    return { success: false, error: err.message };
  }
}

// ─── Send OTP via WhatsApp ────────────────────────────────────
export async function sendOtpWhatsApp(
  to: string,
  otp: string,
  type: "REGISTER" | "FORGOT_PASSWORD",
): Promise<{ success: boolean; error?: string }> {
  const action =
    type === "REGISTER"
      ? "mendaftarkan akun Catetin"
      : "mereset password Catetin";

  const message = `🔐 *Catetin — Kode Verifikasi*

Kode OTP Anda: *${otp}*

Gunakan kode di atas untuk ${action}.
Kode berlaku selama 10 menit.

Jika Anda tidak melakukan permintaan ini, abaikan pesan ini.

— Catetin Financial Intelligence`;

  return sendWhatsApp(to, message);
}
