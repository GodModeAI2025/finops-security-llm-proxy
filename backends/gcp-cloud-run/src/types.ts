// ============================================================
// Token types
// ============================================================

export interface TokenRules {
  ttl_expires_at: string | null;
  max_budget_usd: number;
  max_requests_per_min: number;
  max_tokens_per_request: number;
  max_fail_streak: number;
}

export interface TokenScope {
  allowed_providers: string[];
  allowed_models: string[];
  provider_key_ref: string;
}

export interface TokenDocument {
  id: string;
  name: string;
  owner: string;
  status: "active" | "revoked";
  revoke_reason: string | null;
  created_at: string;
  revoked_at: string | null;
  rules: TokenRules;
  scope: TokenScope;
}

export interface ProviderUsage {
  requests: number;
  cost_usd: number;
}

export interface UsageDocument {
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  fail_streak: number;
  last_request_at: string | null;
  by_provider: Record<string, ProviderUsage>;
}

// ============================================================
// Provider types
// ============================================================

export interface ProviderConfig {
  name: string;
  base_url: string;
  chat_path: string;
  auth_header: (key: string) => Record<string, string>;
  parse_usage: (body: any) => { input_tokens: number; output_tokens: number } | null;
  parse_stream_usage: (chunk: string) => { input_tokens: number; output_tokens: number } | null;
}

export interface PricingEntry {
  input_per_1m: number;
  output_per_1m: number;
}

// ============================================================
// API request/response types
// ============================================================

export interface CreateTokenRequest {
  name: string;
  owner: string;
  rules: Partial<TokenRules>;
  scope?: Partial<TokenScope>;
}

export interface FeedbackRequest {
  request_id?: string;
  success: boolean;
  reason?: string;
}

export interface ProxyRequest {
  model: string;
  messages: any[];
  stream?: boolean;
  [key: string]: any;
}

export interface UsageResponse {
  token_id: string;
  name: string;
  status: string;
  revoke_reason: string | null;
  revoked_at: string | null;
  lifetime: {
    created_at: string;
    last_request_at: string | null;
    duration_hours: number;
  };
  usage: UsageDocument;
}
