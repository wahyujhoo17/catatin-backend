import OpenAI from "openai";
import redis from "../redis";
import type {
  ProviderConfig,
  ProviderName,
  ChatMessage,
  ChatOptions,
  AIStreamEvent,
  ChatResponse,
  ApiKey,
} from "./types";
import { loadKeysFromEnv } from "./types";

// ─── Provider default models & base URLs ──────────────────────
const PROVIDER_DEFAULTS: Record<
  ProviderName,
  { textModel: string; visionModel?: string; baseUrl: string }
> = {
  deepseek: {
    textModel: "deepseek-v4-flash",
    // DeepSeek tidak support vision — dilewati untuk image request
    baseUrl: "https://api.deepseek.com",
  },
  openrouter: {
    textModel: "openrouter/free",
    visionModel: "openrouter/free",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  groq: {
    textModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    visionModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  gemini: {
    textModel: "gemini-2.5-flash",
    visionModel: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  },
};

// ─── Separate routing for text vs vision ───────────────────
// Text priority  : OpenRouter (default) → Gemini → DeepSeek
// Vision priority: Groq (dedicated KEY_3) → Gemini → OpenRouter
const PROVIDER_ORDER_TEXT: ProviderName[] = [
  "openrouter",
  "gemini",
  "deepseek",
];

const PROVIDER_ORDER_VISION: ProviderName[] = ["groq", "gemini", "openrouter"];

// ─── Redis keys ───────────────────────────────────────────────
function rateLimitKey(provider: string, keyIndex: number): string {
  return `ai:ratelimit:${provider}:${keyIndex}`;
}
function usageKey(provider: string, keyIndex: number): string {
  return `ai:usage:${provider}:${keyIndex}`;
}

class AIProviderManager {
  private providers: Map<ProviderName, ProviderConfig> = new Map();
  private keyIndices: Map<string, number> = new Map(); // round-robin index per provider
  private initialized = false;

  constructor() {
    this.loadProviders();
  }

  // ─── Load providers from environment ────────────────────────
  private loadProviders() {
    const allProviders = [
      ...new Set([...PROVIDER_ORDER_TEXT, ...PROVIDER_ORDER_VISION]),
    ];
    for (const name of allProviders) {
      const defaults = PROVIDER_DEFAULTS[name];
      const envPrefix = name.toUpperCase();
      const keys = loadKeysFromEnv(envPrefix, defaults.baseUrl);

      if (keys.length > 0) {
        this.providers.set(name, {
          name,
          textModel:
            process.env[`${envPrefix}_TEXT_MODEL`] || defaults.textModel,
          visionModel:
            process.env[`${envPrefix}_VISION_MODEL`] || defaults.visionModel,
          keys,
        });
        this.keyIndices.set(name, 0);
        console.log(
          `[AI] ${name}: ${keys.length} key(s), model=${this.providers.get(name)!.textModel}`,
        );
      }
    }

    this.initialized = this.providers.size > 0;
    if (!this.initialized) {
      console.warn(
        "[AI] No AI providers configured — set DEEPSEEK_KEY_1, GROQ_KEY_1, or OPENROUTER_KEY_1",
      );
    }
  }

  // ─── Get available (non-rate-limited) keys for a provider ───
  private async getAvailableKeys(
    provider: ProviderConfig,
  ): Promise<{ key: ApiKey; index: number }[]> {
    const available: { key: ApiKey; index: number }[] = [];

    for (let i = 0; i < provider.keys.length; i++) {
      const key = provider.keys[i];

      // Check Redis for rate-limit status
      if (redis) {
        const rlData = await redis.get(rateLimitKey(provider.name, i));
        if (rlData) {
          const { resetAt } = JSON.parse(rlData);
          if (Date.now() < resetAt) {
            continue; // masih kena rate limit
          }
          // Reset sudah expired — clear flag
          key.isRateLimited = false;
          key.rateLimitResetAt = null;
          await redis.del(rateLimitKey(provider.name, i));
        }
      }

      if (
        key.isRateLimited &&
        key.rateLimitResetAt &&
        Date.now() < key.rateLimitResetAt
      ) {
        continue;
      }

      // Reset jika sudah lewat
      if (key.isRateLimited) {
        key.isRateLimited = false;
        key.rateLimitResetAt = null;
      }

      available.push({ key, index: i });
    }

    return available;
  }

  // ─── Mark a key as rate-limited ────────────────────────────
  private async markRateLimited(
    provider: ProviderName,
    keyIndex: number,
    retryAfterSec = 60,
  ) {
    const providerCfg = this.providers.get(provider);
    if (!providerCfg) return;

    const key = providerCfg.keys[keyIndex];
    if (!key) return;

    const resetAt = Date.now() + retryAfterSec * 1000;
    key.isRateLimited = true;
    key.rateLimitResetAt = resetAt;

    if (redis) {
      await redis.setex(
        rateLimitKey(provider, keyIndex),
        retryAfterSec,
        JSON.stringify({ resetAt }),
      );
    }

    console.warn(
      `[AI] ${provider} key #${keyIndex + 1} rate-limited for ${retryAfterSec}s`,
    );
  }

  // ─── Get next round-robin key index ────────────────────────
  private getNextKeyIndex(
    providerName: string,
    availableCount: number,
  ): number {
    const current = this.keyIndices.get(providerName) || 0;
    const next = (current + 1) % availableCount;
    this.keyIndices.set(providerName, next);
    return current; // return current, not next
  }

  // ─── Create OpenAI client for a specific key ──────────────
  private createClient(baseUrl: string, apiKey: string): OpenAI {
    return new OpenAI({
      baseURL: baseUrl,
      apiKey,
      timeout: 5000, // 5s timeout — fast failover
      maxRetries: 0, // no retry, langsung pindah provider
    });
  }

  // ─── Increment usage counter in Redis ───────────────────────
  private async trackUsage(provider: ProviderName, keyIndex: number) {
    if (!redis) return;
    const key = usageKey(provider, keyIndex);
    await redis.incr(key);
    await redis.expire(key, 86400); // expire after 24h
  }

  // ─── Smart: chat with auto-switch provider + key ──────────
  async chat(
    messages: ChatMessage[],
    options: ChatOptions & { vision?: boolean } = {},
  ): Promise<ChatResponse> {
    if (!this.initialized) {
      throw new Error("No AI providers configured. Set API keys in .env");
    }

    const errors: string[] = [];

    const providerOrder = options.vision
      ? PROVIDER_ORDER_VISION
      : PROVIDER_ORDER_TEXT;

    for (const providerName of providerOrder) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      // Skip provider jika perlu vision tapi tidak support
      if (options.vision && !provider.visionModel) {
        errors.push(`${providerName}: tidak support vision`);
        continue;
      }

      const available = await this.getAvailableKeys(provider);
      if (available.length === 0) {
        errors.push(`${providerName}: all keys rate-limited`);
        continue;
      }

      // Round-robin key selection
      const startIndex = this.getNextKeyIndex(providerName, available.length);
      // Try keys starting from round-robin index
      for (let ri = 0; ri < available.length; ri++) {
        const idx = (startIndex + ri) % available.length;
        const { key, index } = available[idx];

        try {
          const client = this.createClient(key.baseUrl, key.key);
          const model =
            options.vision && provider.visionModel
              ? provider.visionModel
              : provider.textModel;

          const response = await client.chat.completions.create({
            model,
            messages: messages as any,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 2048,
            stream: false,
          });

          const content = response.choices?.[0]?.message?.content || "";
          await this.trackUsage(providerName, index);
          key.failures = 0; // reset on success

          return {
            provider: providerName,
            model,
            content,
          };
        } catch (err: any) {
          key.failures++;

          // Rate limited — mark and skip
          if (err.status === 429) {
            const retryAfter = parseInt(
              err.headers?.["retry-after"] || "30",
              10,
            );
            await this.markRateLimited(providerName, index, retryAfter);
            continue; // coba key lain
          }

          // Timeout or server error — coba key lain
          if (
            err.status >= 500 ||
            err.code === "ETIMEDOUT" ||
            err.code === "ECONNRESET"
          ) {
            console.warn(
              `[AI] ${providerName} key #${index + 1} error: ${err.message}`,
            );
            continue;
          }

          // Auth error — skip semua key di provider ini
          if (err.status === 401) {
            errors.push(`${providerName}: invalid API key #${index + 1}`);
            break; // skip provider, semua key mungkin invalid
          }

          // Unknown error — coba key lain
          console.warn(
            `[AI] ${providerName} key #${index + 1} error: ${err.message}`,
          );
          continue;
        }
      }

      errors.push(`${providerName}: all keys exhausted`);
    }

    throw new Error(`All AI providers failed: ${errors.join(" → ")}`);
  }

  // ─── Streaming chat with auto-switch ─────────────────────
  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions & { vision?: boolean } = {},
  ): AsyncGenerator<AIStreamEvent> {
    if (!this.initialized) {
      yield { type: "error", error: "No AI providers configured" };
      return;
    }

    let triedAnyProvider = false;

    const providerOrder = options.vision
      ? PROVIDER_ORDER_VISION
      : PROVIDER_ORDER_TEXT;

    for (const providerName of providerOrder) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      // Skip provider jika perlu vision tapi tidak support
      if (options.vision && !provider.visionModel) continue;

      const available = await this.getAvailableKeys(provider);
      if (available.length === 0) continue;

      const startIndex = this.getNextKeyIndex(providerName, available.length);

      for (let ri = 0; ri < available.length; ri++) {
        const idx = (startIndex + ri) % available.length;
        const { key, index } = available[idx];

        try {
          triedAnyProvider = true;
          const client = this.createClient(key.baseUrl, key.key);
          const model =
            options.vision && provider.visionModel
              ? provider.visionModel
              : provider.textModel;

          yield {
            type: "provider_switch",
            provider: providerName,
            model,
          };

          const stream = await client.chat.completions.create({
            model,
            messages: messages as any,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 2048,
            stream: true,
          });

          let fullContent = "";

          for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              yield {
                type: "token",
                content: delta,
                provider: providerName,
                model,
              };
            }
          }

          await this.trackUsage(providerName, index);
          key.failures = 0;
          yield {
            type: "done",
            content: fullContent,
            provider: providerName,
            model,
          };
          return; // SUCCESS — stop here
        } catch (err: any) {
          key.failures++;

          if (err.status === 429) {
            const retryAfter = parseInt(
              err.headers?.["retry-after"] || "30",
              10,
            );
            await this.markRateLimited(providerName, index, retryAfter);
            continue;
          }

          if (
            err.status >= 500 ||
            err.code === "ETIMEDOUT" ||
            err.code === "ECONNRESET"
          ) {
            console.warn(
              `[AI] ${providerName} key #${index + 1}: ${err.message}`,
            );
            continue;
          }

          if (err.status === 401) {
            yield {
              type: "error",
              error: `${providerName}: invalid API key #${index + 1}`,
            };
            break;
          }

          console.warn(
            `[AI] ${providerName} key #${index + 1}: ${err.message}`,
          );
          continue;
        }
      }
    }

    if (!triedAnyProvider) {
      yield {
        type: "error",
        error:
          "Tidak ada provider AI yang aktif. Silakan konfigurasi API key di pengaturan.",
      };
    } else {
      yield {
        type: "error",
        error: "Semua provider AI gagal merespons. Coba lagi nanti.",
      };
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────
export const aiManager = new AIProviderManager();
