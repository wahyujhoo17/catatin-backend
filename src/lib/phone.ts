/**
 * Normalize Indonesian phone number to WAVO-compatible format.
 *
 * WAVO requires: 6281234567890 (without + prefix, no leading 0)
 *
 * Input examples:
 *   "081234567890"   → "6281234567890"
 *   "+6281234567890" → "6281234567890"
 *   "6281234567890"  → "6281234567890"  (unchanged)
 *   "81234567890"    → "6281234567890"
 */
export function normalizePhone(
  phone: string | undefined | null,
): string | null {
  if (!phone) return null;

  // Strip all non-digit characters
  let cleaned = phone.replace(/\D/g, "");

  // Remove leading "0" and replace with "62"
  if (cleaned.startsWith("0")) {
    cleaned = "62" + cleaned.slice(1);
  }

  // Remove leading "62" prefix if it appears twice (e.g., from +62 becoming 6262)
  if (cleaned.startsWith("6262")) {
    cleaned = cleaned.slice(2);
  }

  // If no country prefix, add "62"
  if (!cleaned.startsWith("62")) {
    cleaned = "62" + cleaned;
  }

  // Must be at least 10 digits and at most 15 digits
  if (cleaned.length < 10 || cleaned.length > 15) {
    console.warn(
      `[Phone] Invalid length after normalization: ${cleaned} (original: ${phone})`,
    );
    return null;
  }

  return cleaned;
}
