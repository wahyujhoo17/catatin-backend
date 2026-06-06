/**
 * Login brute-force protection using Redis.
 *
 * Rules:
 * - Max 5 failed attempts per email within 15 minutes
 * - Max 10 failed attempts per IP within 15 minutes
 * - Lockout duration: 15 menit
 */

import redis from "./redis";

const MAX_ATTEMPTS_EMAIL = 5;
const MAX_ATTEMPTS_IP = 10;
const WINDOW_SECONDS = 15 * 60; // 15 menit
const LOCKOUT_SECONDS = 15 * 60; // 15 menit

function emailKey(email: string): string {
  return `login:attempts:email:${email.toLowerCase().trim()}`;
}

function ipKey(ip: string): string {
  return `login:attempts:ip:${ip}`;
}

function lockKey(email: string): string {
  return `login:locked:${email.toLowerCase().trim()}`;
}

// ─── Record attempt ──────────────────────────────────────────
export async function recordLoginAttempt(
  email: string,
  ip: string,
  success: boolean,
): Promise<void> {
  if (!redis) return;
  if (success) return;

  const eKey = emailKey(email);
  const iKey = ipKey(ip);

  try {
    const multi = redis.multi();
    multi.incr(eKey);
    multi.expire(eKey, WINDOW_SECONDS);
    multi.incr(iKey);
    multi.expire(iKey, WINDOW_SECONDS);
    await multi.exec();

    // Check if should lock
    const [emailCount, ipCount] = await Promise.all([
      redis.get(eKey).then(Number),
      redis.get(iKey).then(Number),
    ]);

    if (emailCount >= MAX_ATTEMPTS_EMAIL) {
      await redis.setex(lockKey(email), LOCKOUT_SECONDS, "1");
    }
  } catch (err) {
    console.warn("[LoginProtection] Redis error:", err);
  }
}

// ─── Reset attempts on success ───────────────────────────────
export async function resetLoginAttempts(
  email: string,
  ip: string,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(emailKey(email), ipKey(ip), lockKey(email));
  } catch (err) {
    console.warn("[LoginProtection] Redis error:", err);
  }
}

// ─── Check lockout status ────────────────────────────────────
export async function checkLoginLockout(
  email: string,
  ip: string,
): Promise<{ isLocked: boolean; lockTtlSeconds: number }> {
  if (!redis) return { isLocked: false, lockTtlSeconds: 0 };

  try {
    const [locked, ttl] = await Promise.all([
      redis.get(lockKey(email)),
      redis.ttl(lockKey(email)),
    ]);

    if (locked) {
      return { isLocked: true, lockTtlSeconds: Math.max(0, ttl) };
    }

    // Also check IP-based lockout
    const [emailCount, ipCount] = await Promise.all([
      redis.get(emailKey(email)).then(Number),
      redis.get(ipKey(ip)).then(Number),
    ]);

    if (emailCount >= MAX_ATTEMPTS_EMAIL || ipCount >= MAX_ATTEMPTS_IP) {
      // Auto-lock if threshold reached
      await redis.setex(lockKey(email), LOCKOUT_SECONDS, "1");
      return { isLocked: true, lockTtlSeconds: LOCKOUT_SECONDS };
    }

    return { isLocked: false, lockTtlSeconds: 0 };
  } catch (err) {
    console.warn("[LoginProtection] Redis error:", err);
    return { isLocked: false, lockTtlSeconds: 0 };
  }
}
