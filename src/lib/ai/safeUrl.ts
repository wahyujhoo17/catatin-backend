import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const KNOWN_PROVIDER_HOSTS = new Set([
  "api.openai.com",
  "api.deepseek.com",
  "api.groq.com",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
  "api.sambanova.ai",
  "api.cerebras.ai",
]);

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:169.254.")
  );
}

export async function assertSafeAiBaseUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Base URL Custom AI tidak valid");
  }

  if (url.username || url.password) {
    throw new Error("Base URL tidak boleh memuat kredensial");
  }
  if (url.protocol !== "https:") {
    const allowLocalDev =
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (!allowLocalDev) {
      throw new Error("Base URL Custom AI wajib menggunakan HTTPS");
    }
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  ) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Host Custom AI tidak diizinkan");
    }
  }

  if (!KNOWN_PROVIDER_HOSTS.has(hostname)) {
    const allowedCustomHosts = new Set(
      (process.env.ALLOWED_CUSTOM_AI_HOSTS || "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    );

    if (
      process.env.NODE_ENV === "production" &&
      !allowedCustomHosts.has(hostname)
    ) {
      throw new Error(
        "Host Custom AI belum tercantum di ALLOWED_CUSTOM_AI_HOSTS",
      );
    }
  }

  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error("Alamat jaringan private tidak diizinkan");
  }

  if (!isIP(hostname) && hostname !== "localhost") {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (
      addresses.length === 0 ||
      addresses.some((entry) => isPrivateAddress(entry.address))
    ) {
      throw new Error("Host Custom AI mengarah ke jaringan private");
    }
  }

  return url;
}

export async function safeAiFetch(
  rawUrl: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<Response> {
  const url = await assertSafeAiBaseUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
