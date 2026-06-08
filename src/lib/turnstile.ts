// ─── Cloudflare Turnstile Verification ────────────────────────
// Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || "";
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
}

/**
 * Verify a Turnstile token.
 * Returns { success: true } if Turnstile is not configured (graceful fallback).
 */
export async function verifyTurnstile(
  token: string | undefined,
): Promise<{ success: boolean; error?: string }> {
  // Skip Turnstile in development mode
  if (process.env.NODE_ENV !== "production") {
    console.log("[Turnstile] Development mode — skipping verification");
    return { success: true };
  }

  // Graceful fallback: if Turnstile not configured, skip verification
  if (!TURNSTILE_SECRET) {
    console.warn(
      "[Turnstile] Secret key not configured — skipping verification",
    );
    return { success: true };
  }

  if (!token || typeof token !== "string" || !token.trim()) {
    return { success: false, error: "Token Turnstile tidak ditemukan" };
  }

  try {
    const formData = new URLSearchParams();
    formData.append("secret", TURNSTILE_SECRET);
    formData.append("response", token);

    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    const data: TurnstileResponse = await res.json();

    if (!data.success) {
      const codes = data["error-codes"]?.join(", ") || "unknown";
      console.warn(`[Turnstile] Verification failed: ${codes}`);
      return {
        success: false,
        error: "Verifikasi Turnstile gagal. Silakan coba lagi.",
      };
    }

    console.log("[Turnstile] Token verified successfully");
    return { success: true };
  } catch (err: any) {
    console.error("[Turnstile] Network error:", err.message);
    return {
      success: false,
      error: "Gagal memverifikasi Turnstile. Periksa koneksi Anda.",
    };
  }
}
