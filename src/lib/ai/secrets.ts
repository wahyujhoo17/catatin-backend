import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";

function encryptionKey(): Buffer {
  const secret =
    process.env.AI_CONFIG_ENCRYPTION_KEY ||
    (process.env.NODE_ENV !== "production"
      ? process.env.JWT_SECRET
      : undefined);
  if (!secret || secret.length < 32) {
    throw new Error(
      "AI_CONFIG_ENCRYPTION_KEY wajib diatur dengan minimal 32 karakter",
    );
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptAiSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptAiSecret(value?: string | null): string {
  if (!value) return "";
  if (!value.startsWith(`${VERSION}:`)) {
    // Backward compatibility for existing plaintext values. The next settings
    // update replaces them with encrypted fields.
    return value;
  }

  const [, ivRaw, tagRaw, encryptedRaw] = value.split(":");
  if (!ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Format secret AI tidak valid");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function maskAiSecret(value?: string | null): string {
  return value ? "••••••••••••" : "";
}
