// ============================================================
// DynamoDB item: tokens table
// ============================================================

export interface TokenItem {
  pk: string; // "TOKEN#ptk_abc123"
  sk: string; // "META"
  id: string;
  name: string;
  owner: string;
  status: "active" | "revoked";
  revoke_reason: string | null;
  created_at: string;
  revoked_at: string | null;
  ttl_expires_at: string | null;
  max_budget_usd: number;
  max_requests_per_min: number;
  max_tokens_per_request: number;
  max_fail_streak: number;
  allowed_providers: string[];
  allowed_models: string[];
  // GSI for listing by status
  gsi1pk: string; // "STATUS#active"
  gsi1sk: string; // owner
}

// ============================================================
// DynamoDB item: usage (same table, different SK)
// ============================================================

export interface UsageItem {
  pk: string; // "TOKEN#ptk_abc123"
  sk: string; // "USAGE"
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
// API types
// ============================================================

export interface CreateTokenRequest {
  name: string;
  owner: string;
  rules?: {
    ttl_expires_at?: string;
    max_budget_usd?: number;
    max_requests_per_min?: number;
    max_tokens_per_request?: number;
    max_fail_streak?: number;
  };
  scope?: {
    allowed_providers?: string[];
    allowed_models?: string[];
  };
}

export interface PricingEntry {
  input_per_1m: number;
  output_per_1m: number;
}
