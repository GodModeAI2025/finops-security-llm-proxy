// ============================================================
// Environment bindings
// ============================================================

export interface Env {
  TOKENS: KVNamespace;
  USAGE_COUNTER: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  GOOGLE_API_KEY?: string;
  ADMIN_KEY: string;
  ENVIRONMENT: string;
}

// ============================================================
// Shared helpers
// ============================================================

export async function revokeToken(env: Env, token: TokenData, reason: string): Promise<void> {
  token.status = "revoked";
  token.revoke_reason = reason;
  token.revoked_at = new Date().toISOString();
  await env.TOKENS.put(token.id, JSON.stringify(token));
}

export function getUsageStub(env: Env, tokenId: string): DurableObjectStub {
  const id = env.USAGE_COUNTER.idFromName(tokenId);
  return env.USAGE_COUNTER.get(id);
}

export async function getUsage(env: Env, tokenId: string): Promise<UsageData> {
  const stub = getUsageStub(env, tokenId);
  const res = await stub.fetch(new Request("http://do/usage"));
  return res.json();
}

export function generateTokenId(): string {
  return `ptk_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// ============================================================
// Token types (stored in KV)
// ============================================================

export interface TokenData {
  id: string;
  name: string;
  owner: string;
  status: "active" | "revoked";
  revoke_reason: string | null;
  created_at: string;
  revoked_at: string | null;
  rules: {
    ttl_expires_at: string | null;
    max_budget_usd: number;
    max_requests_per_min: number;
    max_tokens_per_request: number;
    max_fail_streak: number;
  };
  scope: {
    allowed_providers: string[];
    allowed_models: string[];
  };
}

// ============================================================
// Usage types (stored in Durable Object)
// ============================================================

export interface UsageData {
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  fail_streak: number;
  last_request_at: string | null;
  by_provider: Record<string, { requests: number; cost_usd: number }>;
}

// ============================================================
// Pricing
// ============================================================

export interface PricingEntry {
  input_per_1m: number;
  output_per_1m: number;
}
