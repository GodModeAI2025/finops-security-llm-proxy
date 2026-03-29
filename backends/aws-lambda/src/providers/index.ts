import { PricingEntry } from "./types";

export interface ProviderConfig {
  base_url: string;
  chat_path: string;
  auth_header: (key: string) => Record<string, string>;
  parse_usage: (body: any) => { input_tokens: number; output_tokens: number } | null;
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    base_url: "https://api.anthropic.com",
    chat_path: "/v1/messages",
    auth_header: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    parse_usage: (body) =>
      body?.usage ? { input_tokens: body.usage.input_tokens ?? 0, output_tokens: body.usage.output_tokens ?? 0 } : null,
  },
  openai: {
    base_url: "https://api.openai.com",
    chat_path: "/v1/chat/completions",
    auth_header: (key) => ({ Authorization: `Bearer ${key}` }),
    parse_usage: (body) =>
      body?.usage ? { input_tokens: body.usage.prompt_tokens ?? 0, output_tokens: body.usage.completion_tokens ?? 0 } : null,
  },
  google: {
    base_url: "https://generativelanguage.googleapis.com",
    chat_path: "/v1beta/models/{model}:generateContent",
    auth_header: (key) => ({ "x-goog-api-key": key }),
    parse_usage: (body) =>
      body?.usageMetadata ? { input_tokens: body.usageMetadata.promptTokenCount ?? 0, output_tokens: body.usageMetadata.candidatesTokenCount ?? 0 } : null,
  },
};

export const PRICING: Record<string, PricingEntry> = {
  "claude-sonnet-4-20250514": { input_per_1m: 3.0, output_per_1m: 15.0 },
  "claude-opus-4-20250514": { input_per_1m: 15.0, output_per_1m: 75.0 },
  "claude-haiku-4-5-20251001": { input_per_1m: 0.8, output_per_1m: 4.0 },
  "gpt-4o": { input_per_1m: 2.5, output_per_1m: 10.0 },
  "gpt-4o-mini": { input_per_1m: 0.15, output_per_1m: 0.6 },
  "o3-mini": { input_per_1m: 1.1, output_per_1m: 4.4 },
  "gemini-2.0-flash": { input_per_1m: 0.1, output_per_1m: 0.4 },
  "gemini-2.5-pro": { input_per_1m: 1.25, output_per_1m: 10.0 },
};

export function resolveProvider(model: string): string | null {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  if (model.startsWith("gemini-")) return "google";
  return null;
}

export function buildChatUrl(provider: ProviderConfig, model: string): string {
  return `${provider.base_url}${provider.chat_path.replace("{model}", model)}`;
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (inputTokens * p.input_per_1m + outputTokens * p.output_per_1m) / 1_000_000;
}
