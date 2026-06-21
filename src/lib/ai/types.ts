// ─── Provider & Key Configuration ─────────────────────────────
export interface ApiKey {
  key: string;
  baseUrl: string;
  isRateLimited: boolean;
  rateLimitResetAt: number | null;
  failures: number;
}

export interface ProviderConfig {
  name: ProviderName;
  textModel: string;
  visionModel?: string;
  keys: ApiKey[];
}

export type ProviderName = "deepseek" | "openrouter" | "groq" | "gemini" | "sambanova" | "cerebras";

// ─── Chat Types ───────────────────────────────────────────────
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string }; // base64 data:image/jpeg;base64,... or URL
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  jsonMode?: boolean;
  tools?: any[];
  tool_choice?: any;
}

export interface AIStreamEvent {
  type: "token" | "done" | "error" | "provider_switch" | "transaction_created" | "transaction_updated" | "transaction_deleted" | "tool_calls";
  content?: string;
  provider?: ProviderName;
  model?: string;
  error?: string;
  tool_calls?: any[];
  transaction?: {
    id?: string;
    type: string;
    amount: number;
    description: string;
    category: string;
    accountId?: string | null;
    account?: string;
  };
}

// ─── Response from manager ────────────────────────────────────
export interface ChatResponse {
  provider: ProviderName;
  model: string;
  content: string;
  tool_calls?: any[];
}

// ─── Environment helpers ──────────────────────────────────────
export function loadKeysFromEnv(
  prefix: string,
  defaultBaseUrl: string,
): ApiKey[] {
  const keys: ApiKey[] = [];
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`${prefix}_KEY_${i}`];
    if (key && key.length > 0) {
      keys.push({
        key,
        baseUrl: process.env[`${prefix}_BASE_URL`] || defaultBaseUrl,
        isRateLimited: false,
        rateLimitResetAt: null,
        failures: 0,
      });
    }
  }
  return keys;
}
