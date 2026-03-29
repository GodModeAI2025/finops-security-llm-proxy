import { Firestore, FieldValue } from "@google-cloud/firestore";
import { v4 as uuidv4 } from "uuid";
import {
  TokenDocument,
  UsageDocument,
  CreateTokenRequest,
  PricingEntry,
} from "../types";
import { DEFAULT_PRICING } from "../providers";

export const db = new Firestore();
const tokensCollection = db.collection("tokens");
const configCollection = db.collection("config");

// ============================================================
// Token CRUD
// ============================================================

export async function createToken(req: CreateTokenRequest): Promise<TokenDocument> {
  const id = `ptk_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  const token: TokenDocument = {
    id,
    name: req.name,
    owner: req.owner,
    status: "active",
    revoke_reason: null,
    created_at: now,
    revoked_at: null,
    rules: {
      ttl_expires_at: req.rules.ttl_expires_at ?? null,
      max_budget_usd: req.rules.max_budget_usd ?? 100,
      max_requests_per_min: req.rules.max_requests_per_min ?? 60,
      max_tokens_per_request: req.rules.max_tokens_per_request ?? 4096,
      max_fail_streak: req.rules.max_fail_streak ?? 10,
    },
    scope: {
      allowed_providers: req.scope?.allowed_providers ?? ["anthropic", "openai"],
      allowed_models: req.scope?.allowed_models ?? ["*"],
      provider_key_ref: req.scope?.provider_key_ref ?? "default",
    },
  };

  const initialUsage: UsageDocument = {
    total_requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0,
    fail_streak: 0,
    last_request_at: null,
    by_provider: {},
  };

  const batch = db.batch();
  batch.set(tokensCollection.doc(id), token);
  batch.set(tokensCollection.doc(id).collection("usage").doc("current"), initialUsage);
  await batch.commit();

  return token;
}

export async function getToken(id: string): Promise<TokenDocument | null> {
  const doc = await tokensCollection.doc(id).get();
  if (!doc.exists) return null;
  return doc.data() as TokenDocument;
}

export async function updateToken(id: string, updates: Partial<TokenDocument>): Promise<void> {
  await tokensCollection.doc(id).update(updates as any);
}

export async function getTokenBySessionId(sessionId: string): Promise<(TokenDocument & Record<string, any>) | null> {
  const snap = await tokensCollection
    .where("session_id", "==", sessionId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].data() as TokenDocument & Record<string, any>;
}

export async function deleteToken(id: string): Promise<void> {
  // Delete usage subcollection first
  const usageDocs = await tokensCollection.doc(id).collection("usage").listDocuments();
  const batch = db.batch();
  for (const doc of usageDocs) {
    batch.delete(doc);
  }
  batch.delete(tokensCollection.doc(id));
  await batch.commit();
}

export async function listTokens(filters?: {
  status?: string;
  owner?: string;
}): Promise<TokenDocument[]> {
  let query: FirebaseFirestore.Query = tokensCollection;
  if (filters?.status) query = query.where("status", "==", filters.status);
  if (filters?.owner) query = query.where("owner", "==", filters.owner);

  const snap = await query.get();
  return snap.docs.map((d) => d.data() as TokenDocument);
}

// ============================================================
// Revocation
// ============================================================

export async function revokeToken(id: string, reason: string): Promise<void> {
  await tokensCollection.doc(id).update({
    status: "revoked",
    revoke_reason: reason,
    revoked_at: new Date().toISOString(),
  });
}

export async function reactivateToken(id: string): Promise<void> {
  const batch = db.batch();
  batch.update(tokensCollection.doc(id), {
    status: "active",
    revoke_reason: null,
    revoked_at: null,
  });
  batch.update(tokensCollection.doc(id).collection("usage").doc("current"), {
    fail_streak: 0,
  });
  await batch.commit();
}

// ============================================================
// Usage tracking (atomic)
// ============================================================

export async function trackUsage(
  tokenId: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
  success: boolean
): Promise<UsageDocument> {
  const usageRef = tokensCollection.doc(tokenId).collection("usage").doc("current");

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(usageRef);
    const current = doc.data() as UsageDocument;

    const updates: Record<string, any> = {
      total_requests: FieldValue.increment(1),
      total_input_tokens: FieldValue.increment(inputTokens),
      total_output_tokens: FieldValue.increment(outputTokens),
      total_cost_usd: FieldValue.increment(cost),
      last_request_at: new Date().toISOString(),
      [`by_provider.${provider}.requests`]: FieldValue.increment(1),
      [`by_provider.${provider}.cost_usd`]: FieldValue.increment(cost),
    };

    if (success) {
      updates.successful_requests = FieldValue.increment(1);
      updates.fail_streak = 0;
    } else {
      updates.failed_requests = FieldValue.increment(1);
      updates.fail_streak = FieldValue.increment(1);
    }

    tx.update(usageRef, updates);

    // Return projected state for auto-revocation checks
    return {
      ...current,
      total_requests: current.total_requests + 1,
      total_cost_usd: current.total_cost_usd + cost,
      fail_streak: success ? 0 : current.fail_streak + 1,
      last_request_at: new Date().toISOString(),
    } as UsageDocument;
  });
}

export async function getUsage(tokenId: string): Promise<UsageDocument | null> {
  const doc = await tokensCollection.doc(tokenId).collection("usage").doc("current").get();
  if (!doc.exists) return null;
  return doc.data() as UsageDocument;
}

export async function recordFeedback(
  tokenId: string,
  success: boolean
): Promise<number> {
  const usageRef = tokensCollection.doc(tokenId).collection("usage").doc("current");

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(usageRef);
    const current = doc.data() as UsageDocument;

    if (success) {
      tx.update(usageRef, { fail_streak: 0 });
      return 0;
    } else {
      const newStreak = current.fail_streak + 1;
      tx.update(usageRef, { fail_streak: FieldValue.increment(1) });
      return newStreak;
    }
  });
}

// ============================================================
// TTL Cleanup
// ============================================================

export async function cleanupExpiredTokens(): Promise<number> {
  const now = new Date().toISOString();
  const snap = await tokensCollection
    .where("status", "==", "active")
    .where("rules.ttl_expires_at", "<=", now)
    .where("rules.ttl_expires_at", "!=", null)
    .get();

  const docs = snap.docs;
  if (docs.length === 0) return 0;

  // Firestore batches are limited to 500 operations
  for (let i = 0; i < docs.length; i += 500) {
    const chunk = docs.slice(i, i + 500);
    const batch = db.batch();
    for (const doc of chunk) {
      batch.update(doc.ref, {
        status: "revoked",
        revoke_reason: "ttl_expired",
        revoked_at: now,
      });
    }
    await batch.commit();
  }

  return docs.length;
}

// ============================================================
// Pricing config
// ============================================================

let cachedPricing: Record<string, PricingEntry> | null = null;
let pricingLastFetch = 0;
const PRICING_CACHE_MS = 60_000; // refresh every minute

export async function getPricing(): Promise<Record<string, PricingEntry>> {
  const now = Date.now();
  if (cachedPricing && now - pricingLastFetch < PRICING_CACHE_MS) {
    return cachedPricing;
  }

  try {
    const doc = await configCollection.doc("pricing").get();
    if (doc.exists) {
      cachedPricing = doc.data() as Record<string, PricingEntry>;
      pricingLastFetch = now;
      return cachedPricing;
    }
  } catch (err) {
    console.warn("Failed to load pricing from Firestore, using defaults:", err);
  }

  cachedPricing = DEFAULT_PRICING;
  pricingLastFetch = now;
  return DEFAULT_PRICING;
}
