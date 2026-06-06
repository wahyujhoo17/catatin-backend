import { Context, Next } from "hono";
import redis from "../lib/redis";

interface CacheOptions {
  ttl: number; // seconds
  key?: string | ((c: Context) => string);
}

// ─── Cache GET responses in Redis ─────────────────────────────
export function cacheResponse(options: CacheOptions) {
  const { ttl } = options;

  return async (c: Context, next: Next) => {
    // Hanya cache method GET
    if (c.req.method !== "GET" || !redis) {
      return next();
    }

    const cacheKey =
      typeof options.key === "function"
        ? options.key(c)
        : options.key || `${c.req.method}:${c.req.path}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = JSON.parse(cached);
        c.header("X-Cache", "HIT");
        return c.json(data);
      }

      // Simpan response asli
      const original = c.res;
      await next();

      // Simpan ke cache setelah response selesai
      const finalRes = c.res;
      if (finalRes.status === 200) {
        const clone = finalRes.clone();
        const body = await clone.json();
        await redis.setex(cacheKey, ttl, JSON.stringify(body));
        c.header("X-Cache", "MISS");
      }
    } catch (err) {
      console.warn("[Cache] Error:", err);
      await next();
    }
  };
}

// ─── Clear cache by pattern ──────────────────────────────────
export async function clearCache(pattern: string): Promise<void> {
  if (!redis) return;
  const stream = redis.scanStream({ match: pattern, count: 100 });
  for await (const keys of stream) {
    if (keys.length) await redis.del(...keys);
  }
}
