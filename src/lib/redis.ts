import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

let redis: Redis | null = null;

if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 3) return null; // stop retrying after 3 attempts
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  });

  redis.on("error", (err) => {
    console.warn("[Redis] Connection error:", err.message);
  });

  redis.on("connect", () => {
    console.log("[Redis] Connected");
  });
} else {
  console.warn("[Redis] REDIS_URL not set — running without cache");
}

// ─── Helper: get or set cache ─────────────────────────────────
export async function getOrSet<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlSec = 300,
): Promise<T> {
  if (!redis) return fetchFn();

  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as T;

  const data = await fetchFn();
  await redis.setex(key, ttlSec, JSON.stringify(data));
  return data;
}

// ─── Helper: invalidate cache ─────────────────────────────────
export async function invalidateCache(key: string): Promise<void> {
  if (!redis) return;
  await redis.del(key);
}

// ─── Helper: invalidate by pattern ────────────────────────────
export async function invalidatePattern(pattern: string): Promise<void> {
  if (!redis) return;
  const stream = redis.scanStream({ match: pattern, count: 100 });
  for await (const keys of stream) {
    if (keys.length) await redis.del(...keys);
  }
}

// ─── Helper: clear user AI cache ──────────────────────────────
export async function clearUserAiCache(userId: string): Promise<void> {
  await invalidatePattern(`user:context:${userId}:*`);
}

export default redis;
