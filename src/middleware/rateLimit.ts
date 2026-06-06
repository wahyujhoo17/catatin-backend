import { Context, Next } from "hono";
import redis from "../lib/redis";

interface RateLimitConfig {
  windowMs: number; // time window in ms
  max: number; // max requests per window
  message?: string;
}

const defaults: RateLimitConfig = {
  windowMs: 60 * 1000, // 1 menit
  max: 60, // 60 request per menit
  message: "Terlalu banyak permintaan. Silakan coba lagi nanti.",
};

// ─── Rate limiter berbasis Redis (akurat untuk multi-instance/cluster) ──
export function rateLimit(config: Partial<RateLimitConfig> = {}) {
  const opts = { ...defaults, ...config };

  return async (c: Context, next: Next) => {
    if (!redis) {
      return next();
    }

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";

    const key = `ratelimit:${ip}`;

    try {
      const current = await redis.incr(key);

      if (current === 1) {
        await redis.pexpire(key, opts.windowMs);
      }

      const ttl = await redis.pttl(key);

      c.header("X-RateLimit-Limit", String(opts.max));
      c.header(
        "X-RateLimit-Remaining",
        String(Math.max(0, opts.max - current)),
      );
      c.header(
        "X-RateLimit-Reset",
        String(Math.ceil((Date.now() + ttl) / 1000)),
      );

      if (current > opts.max) {
        return c.json({ error: opts.message }, 429, {
          "Retry-After": String(Math.ceil(ttl / 1000)),
        });
      }

      await next();
    } catch (err) {
      console.warn("[RateLimit] Error:", err);
      await next();
    }
  };
}
