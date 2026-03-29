import { ProviderConfig, PricingEntry } from "../types";

// ============================================================
// Provider adapters — add new providers here
// ============================================================

export const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    name: "anthropic",
    base_url: "https://api.anthropic.com",
    chat_path: "/v1/messages",
    auth_header: (key: string) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }),
    parse_usage: (body: any) => {
      if (body?.usage) {
        return {
          input_tokens: body.usage.input_tokens ?? 0,
          output_tokens: body.usage.output_tokens ?? 0,
        };
      }
      return null;
    },
    parse_stream_usage: (chunk: string) => {
      // Anthropic sends usage in message_stop event
      if (chunk.includes('"type":"message_delta"') || chunk.includes('"type": "message_delta"')) {
        try {
          const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));
          for (const line of lines) {
            const data = JSON.parse(line.slice(6));
            if (data.type === "message_delta" && data.usage) {
              return {
                input_tokens: data.usage.input_tokens ?? 0,
                output_tokens: data.usage.output_tokens ?? 0,
              };
            }
          }
        } catch {}
      }
      return null;
    },
  },

  openai: {
    name: "openai",
    base_url: "https://api.openai.com",
    chat_path: "/v1/chat/completions",
    auth_header: (key: string) => ({
      Authorization: `Bearer ${key}`,
    }),
    parse_usage: (body: any) => {
      if (body?.usage) {
        return {
          input_tokens: body.usage.prompt_tokens ?? 0,
          output_tokens: body.usage.completion_tokens ?? 0,
        };
      }
      return null;
    },
    parse_stream_usage: (chunk: string) => {
      // OpenAI sends usage in the last chunk (when stream_options.include_usage is true)
      if (chunk.includes('"usage"')) {
        try {
          const lines = chunk.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
          for (const line of lines) {
            const data = JSON.parse(line.slice(6));
            if (data.usage) {
              return {
                input_tokens: data.usage.prompt_tokens ?? 0,
                output_tokens: data.usage.completion_tokens ?? 0,
              };
            }
          }
        } catch {}
      }
      return null;
    },
  },

  google: {
    name: "google",
    base_url: "https://generativelanguage.googleapis.com",
    chat_path: "/v1beta/models/{model}:generateContent",
    auth_header: (key: string) => ({
      "x-goog-api-key": key,
    }),
    parse_usage: (body: any) => {
      if (body?.usageMetadata) {
        return {
          input_tokens: body.usageMetadata.promptTokenCount ?? 0,
          output_tokens: body.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
      return null;
    },
    parse_stream_usage: (_chunk: string) => null,
  },
};

// ============================================================
// Default pricing (can be overridden via Firestore config/pricing)
// ============================================================

export const DEFAULT_PRICING: Record<string, PricingEntry> = {
  // Anthropic
  "claude-sonnet-4-20250514": { input_per_1m: 3.0, output_per_1m: 15.0 },
  "claude-opus-4-20250514": { input_per_1m: 15.0, output_per_1m: 75.0 },
  "claude-haiku-4-5-20251001": { input_per_1m: 0.8, output_per_1m: 4.0 },
  // OpenAI
  "gpt-4o": { input_per_1m: 2.5, output_per_1m: 10.0 },
  "gpt-4o-mini": { input_per_1m: 0.15, output_per_1m: 0.6 },
  "o3-mini": { input_per_1m: 1.1, output_per_1m: 4.4 },
  // Google
  "gemini-2.0-flash": { input_per_1m: 0.1, output_per_1m: 0.4 },
  "gemini-2.5-pro": { input_per_1m: 1.25, output_per_1m: 10.0 },
};

// ============================================================
// Resolve which provider a model belongs to
// ============================================================

export function resolveProvider(model: string): string | null {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  if (model.startsWith("gemini-")) return "google";
  return null;
}

// ============================================================
// Calculate cost from token counts
// ============================================================

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, PricingEntry>
): number {
  const p = pricing[model] || DEFAULT_PRICING[model];
  if (!p) return 0;
  return (inputTokens * p.input_per_1m + outputTokens * p.output_per_1m) / 1_000_000;
}
