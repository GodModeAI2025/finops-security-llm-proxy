import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, ScheduledEvent } from "aws-lambda";
import { PROVIDERS, resolveProvider, calculateCost, buildChatUrl } from "./providers";
import {
  createToken, getToken, getUsage, deleteToken, listTokens,
  revokeToken, reactivateToken, trackUsage, recordFeedback, cleanupExpired, putItem,
} from "./utils/dynamodb";
import { getProviderKey, getAdminKey } from "./utils/secrets";
import {
  getOrCreateProfile, getProfile, calculateLimits, recordAndRecalculate,
  listAllProfiles, saveSessionMeta, getSessionMeta, SessionDatapoint,
} from "./services/topic-profiler";
import { v4 as uuidv4 } from "uuid";

// ============================================================
// Response helpers
// ============================================================

function json(body: any, status = 200, headers?: Record<string, string>): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

// ============================================================
// Rate limiter (in-memory, per Lambda instance)
// ============================================================

const rateBuckets = new Map<string, number[]>();

function checkRate(tokenId: string, max: number): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(tokenId) ?? [];
  bucket = bucket.filter((t) => t > now - 60_000);
  if (bucket.length >= max) return false;
  bucket.push(now);
  rateBuckets.set(tokenId, bucket);
  return true;
}

function estimateTokens(body: any): number {
  return Math.ceil(JSON.stringify(body.messages ?? body).length / 4);
}

// ============================================================
// Main HTTP handler (API Gateway v2)
// ============================================================

export async function handler(
  event: APIGatewayProxyEventV2 | ScheduledEvent
): Promise<APIGatewayProxyResultV2 | void> {

  // ── Scheduled event (cleanup cron) ─────────────────────
  if ("source" in event && event.source === "aws.events") {
    const count = await cleanupExpired();
    console.log(`Cleanup: ${count} tokens revoked`);
    return;
  }

  const httpEvent = event as APIGatewayProxyEventV2;
  const method = httpEvent.requestContext?.http?.method ?? "GET";
  const path = httpEvent.rawPath ?? "/";
  const auth = httpEvent.headers?.authorization ?? "";
  const body = httpEvent.body ? JSON.parse(httpEvent.body) : {};

  // ── Health ─────────────────────────────────────────────
  if (path === "/health") {
    return json({ status: "ok", runtime: "aws-lambda", timestamp: new Date().toISOString() });
  }

  // ══════════════════════════════════════════════════════
  // SESSION ENDPOINTS (adaptive provisioning)
  // ══════════════════════════════════════════════════════

  // POST /v1/session — Open session
  if (path === "/v1/session" && method === "POST") {
    if (!body.topic || !body.model) {
      return json({ error: "Missing topic and model" }, 400);
    }

    const profile = await getOrCreateProfile(body.topic, body.model);
    const limits = calculateLimits(profile);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + limits.max_duration_min * 60_000);
    const sessionId = `ses_${uuidv4().replace(/-/g, "").slice(0, 16)}`;

    const token = await createToken({
      name: `session:${sessionId}`,
      owner: `topic:${body.topic}`,
      rules: {
        ttl_expires_at: expiresAt.toISOString(),
        max_budget_usd: limits.max_budget_usd,
        max_requests_per_min: 60,
        max_tokens_per_request: 4096,
        max_fail_streak: 10,
      },
      scope: {
        allowed_providers: ["anthropic", "openai", "google"],
        allowed_models: [body.model],
      },
    });

    await saveSessionMeta({
      pk: `SESSION#${sessionId}`, sk: "META",
      token_id: token.id, topic: body.topic, model: body.model,
      started_at: now.toISOString(), limits_source: limits.source,
    });

    return json({
      session_id: sessionId, token: token.id, model: body.model, topic: body.topic,
      limits: {
        max_duration_min: Number(limits.max_duration_min.toFixed(2)),
        max_budget_usd: Number(limits.max_budget_usd.toFixed(4)),
        source: limits.source, datapoints: limits.datapoints, safety_margin: limits.safety_margin,
      },
      expires_at: expiresAt.toISOString(),
      stats: profile.stats,
    }, 201);
  }

  // POST /v1/session/:id/complete — End session
  const sessionCompleteMatch = path.match(/^\/v1\/session\/(ses_[a-z0-9]+)\/complete$/);
  if (method === "POST" && sessionCompleteMatch) {
    if (typeof body.success !== "boolean") return json({ error: "Missing success field" }, 400);

    const sessionId = sessionCompleteMatch[1];
    const meta = await getSessionMeta(sessionId);
    if (!meta) return json({ error: "Session not found" }, 404);

    const token = await getToken(meta.token_id);
    if (!token) return json({ error: "Token not found" }, 404);
    if (token.status === "revoked") return json({ error: "Session already ended", reason: token.revoke_reason }, 409);

    const usage = await getUsage(meta.token_id);
    const now = new Date();
    const durationMin = (now.getTime() - new Date(meta.started_at).getTime()) / 60_000;

    await revokeToken(meta.token_id, body.success ? "session_completed_success" : "session_completed_failure");

    const datapoint: SessionDatapoint = {
      session_id: sessionId, duration_min: Number(durationMin.toFixed(2)),
      cost_usd: usage?.total_cost_usd ?? 0, success: body.success,
      model: meta.model, completed_at: now.toISOString(), completed_by: "client",
    };

    const updatedProfile = await recordAndRecalculate(meta.topic, meta.model, datapoint);

    return json({
      session_id: sessionId, completed: true, success: body.success,
      actual: {
        duration_min: datapoint.duration_min,
        cost_usd: Number(datapoint.cost_usd.toFixed(4)),
        total_requests: usage?.total_requests ?? 0,
      },
      topic_update: {
        topic: meta.topic, new_limits: updatedProfile.current_limits,
        datapoints: updatedProfile.datapoints, stats: updatedProfile.stats,
      },
    });
  }

  // ══════════════════════════════════════════════════════
  // PROXY ENDPOINT
  // ══════════════════════════════════════════════════════
  if (path === "/v1/chat" && method === "POST") {
    // Auth
    if (!auth.startsWith("Bearer ptk_")) return json({ error: "unauthorized" }, 401);
    const tokenId = auth.slice(7);

    const token = await getToken(tokenId);
    if (!token) return json({ error: "token_not_found" }, 401);
    if (token.status === "revoked") return json({ error: "token_revoked", reason: token.revoke_reason }, 403);

    // TTL check
    if (token.ttl_expires_at && new Date(token.ttl_expires_at) <= new Date()) {
      await revokeToken(token.id, "ttl_expired");
      return json({ error: "token_expired" }, 403);
    }

    const model = body.model;
    if (!model) return json({ error: "missing_model" }, 400);

    const providerName = resolveProvider(model);
    if (!providerName || !PROVIDERS[providerName]) return json({ error: "unknown_model", model }, 400);

    // Scope
    if (!token.allowed_providers.includes(providerName) && !token.allowed_providers.includes("*"))
      return json({ error: "provider_not_allowed" }, 403);
    if (!token.allowed_models.includes(model) && !token.allowed_models.includes("*"))
      return json({ error: "model_not_allowed" }, 403);

    // Budget + fail streak
    const usage = await getUsage(token.id);
    if (usage && usage.total_cost_usd >= token.max_budget_usd) {
      await revokeToken(token.id, "budget_exceeded");
      return json({ error: "budget_exceeded" }, 403);
    }
    if (usage && usage.fail_streak >= token.max_fail_streak) {
      await revokeToken(token.id, "fail_streak_exceeded");
      return json({ error: "fail_streak_exceeded" }, 403);
    }

    // Rate limit
    if (!checkRate(token.id, token.max_requests_per_min))
      return json({ error: "rate_limited", retry_after_seconds: 60 }, 429);

    // Get real key
    let realKey: string;
    try { realKey = await getProviderKey(providerName); }
    catch { return json({ error: "key_not_configured" }, 500); }

    // Forward request
    const provider = PROVIDERS[providerName];
    const forwardBody = { ...body };
    // Lambda doesn't support response streaming via API Gateway
    forwardBody.stream = false;

    try {
      const targetUrl = buildChatUrl(provider, model);
      const upstreamRes = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...provider.auth_header(realKey) },
        body: JSON.stringify(forwardBody),
      });

      const responseBody = await upstreamRes.json();
      const success = upstreamRes.ok;

      const parsed = provider.parse_usage(responseBody);
      const inputTokens = parsed?.input_tokens ?? 0;
      const outputTokens = parsed?.output_tokens ?? 0;
      const cost = calculateCost(model, inputTokens, outputTokens);

      const updatedUsage = await trackUsage(token.id, providerName, inputTokens, outputTokens, cost, success);

      // Auto-revoke
      if (updatedUsage.total_cost_usd >= token.max_budget_usd)
        await revokeToken(token.id, "budget_exceeded");
      else if (updatedUsage.fail_streak >= token.max_fail_streak)
        await revokeToken(token.id, "fail_streak_exceeded");

      return json(responseBody, upstreamRes.status, {
        "X-Proxy-Usage": JSON.stringify({
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: Number(cost.toFixed(6)),
          total_cost_usd: Number(updatedUsage.total_cost_usd.toFixed(6)),
          budget_remaining_usd: Number((token.max_budget_usd - updatedUsage.total_cost_usd).toFixed(6)),
        }),
      });
    } catch (err: any) {
      const est = estimateTokens(body);
      const cost = calculateCost(model, est, 0);
      await trackUsage(token.id, providerName, est, 0, cost, false);
      return json({ error: "upstream_error", message: err.message }, 502);
    }
  }

  // ══════════════════════════════════════════════════════
  // ADMIN ENDPOINTS
  // ══════════════════════════════════════════════════════
  if (path.startsWith("/admin/")) {
    let adminKey: string;
    try { adminKey = await getAdminKey(); }
    catch { return json({ error: "admin_key_not_configured" }, 500); }

    if (auth !== `Bearer ${adminKey}`) return json({ error: "unauthorized" }, 401);

    // POST /admin/tokens
    if (method === "POST" && path === "/admin/tokens") {
      if (!body.name || !body.owner) return json({ error: "Missing name and owner" }, 400);
      const token = await createToken(body);
      return json(token, 201);
    }

    // GET /admin/tokens
    if (method === "GET" && path === "/admin/tokens") {
      const params = httpEvent.queryStringParameters ?? {};
      const tokens = await listTokens(params.status, params.owner);
      return json({ tokens, count: tokens.length });
    }

    // Token-specific routes
    const idMatch = path.match(/^\/admin\/(?:tokens|revoke|reactivate|feedback|usage)\/(ptk_[a-z0-9]+)$/);
    const tokenId = idMatch?.[1];

    if (tokenId) {
      // GET /admin/tokens/:id
      if (method === "GET" && path.startsWith("/admin/tokens/")) {
        const token = await getToken(tokenId);
        if (!token) return json({ error: "not_found" }, 404);
        return json(token);
      }

      // PATCH /admin/tokens/:id
      if (method === "PATCH" && path.startsWith("/admin/tokens/")) {
        const token = await getToken(tokenId);
        if (!token) return json({ error: "not_found" }, 404);
        if (body.rules) {
          if (body.rules.max_budget_usd !== undefined) token.max_budget_usd = body.rules.max_budget_usd;
          if (body.rules.max_requests_per_min !== undefined) token.max_requests_per_min = body.rules.max_requests_per_min;
          if (body.rules.max_tokens_per_request !== undefined) token.max_tokens_per_request = body.rules.max_tokens_per_request;
          if (body.rules.max_fail_streak !== undefined) token.max_fail_streak = body.rules.max_fail_streak;
          if (body.rules.ttl_expires_at !== undefined) token.ttl_expires_at = body.rules.ttl_expires_at;
        }
        if (body.scope) {
          if (body.scope.allowed_providers) token.allowed_providers = body.scope.allowed_providers;
          if (body.scope.allowed_models) token.allowed_models = body.scope.allowed_models;
        }
        if (body.name) token.name = body.name;
        await putItem(token);
        return json(token);
      }

      // DELETE /admin/tokens/:id
      if (method === "DELETE" && path.startsWith("/admin/tokens/")) {
        await deleteToken(tokenId);
        return json({ deleted: true, id: tokenId });
      }

      // POST /admin/revoke/:id
      if (method === "POST" && path.startsWith("/admin/revoke/")) {
        const token = await getToken(tokenId);
        if (!token) return json({ error: "not_found" }, 404);
        if (token.status === "revoked") return json({ error: "already_revoked" }, 409);
        await revokeToken(tokenId, body.reason || "manual_revocation");
        return json({ revoked: true, id: tokenId });
      }

      // POST /admin/reactivate/:id
      if (method === "POST" && path.startsWith("/admin/reactivate/")) {
        await reactivateToken(tokenId);
        return json({ reactivated: true, id: tokenId });
      }

      // POST /admin/feedback/:id
      if (method === "POST" && path.startsWith("/admin/feedback/")) {
        if (typeof body.success !== "boolean") return json({ error: "Missing success field" }, 400);
        const token = await getToken(tokenId);
        if (!token) return json({ error: "not_found" }, 404);
        const streak = await recordFeedback(tokenId, body.success);
        if (!body.success && streak >= token.max_fail_streak) {
          await revokeToken(tokenId, "fail_streak_exceeded_via_feedback");
          return json({ recorded: true, fail_streak: streak, auto_revoked: true });
        }
        return json({ recorded: true, fail_streak: streak, auto_revoked: false });
      }

      // GET /admin/usage/:id
      if (method === "GET" && path.startsWith("/admin/usage/")) {
        const token = await getToken(tokenId);
        if (!token) return json({ error: "not_found" }, 404);
        const usage = await getUsage(tokenId);
        if (!usage) return json({ error: "no_usage" }, 404);
        const created = new Date(token.created_at);
        const endTime = token.revoked_at ? new Date(token.revoked_at) : new Date();
        return json({
          token_id: token.id, name: token.name, status: token.status,
          revoke_reason: token.revoke_reason, revoked_at: token.revoked_at,
          lifetime: {
            created_at: token.created_at,
            last_request_at: usage.last_request_at,
            duration_hours: Number(((endTime.getTime() - created.getTime()) / 3_600_000).toFixed(2)),
          },
          usage,
        });
      }
    }

    // POST /admin/cleanup
    if (method === "POST" && path === "/admin/cleanup") {
      const count = await cleanupExpired();
      return json({ cleaned: count, timestamp: new Date().toISOString() });
    }

    // ── Topic admin routes ─────────────────────────────
    // GET /admin/topics — List all topic profiles with stats
    if (method === "GET" && path === "/admin/topics") {
      const profiles = await listAllProfiles();
      const summary = profiles.map((p) => ({
        topic: p.topic, model: p.model, datapoints: p.datapoints,
        current_limits: p.current_limits, stats: p.stats, updated_at: p.updated_at,
      }));
      return json({ topics: summary, count: summary.length });
    }

    // GET /admin/topics/:topic/:model — Single topic detail
    const topicDetailMatch = path.match(/^\/admin\/topics\/([^/]+)\/([^/]+)$/);
    if (method === "GET" && topicDetailMatch) {
      const profile = await getProfile(topicDetailMatch[1], topicDetailMatch[2]);
      if (!profile) return json({ error: "Topic not found" }, 404);
      return json(profile);
    }

    // PATCH /admin/topics/:topic/:model — Manual override
    if (method === "PATCH" && topicDetailMatch) {
      const profile = await getProfile(topicDetailMatch[1], topicDetailMatch[2]);
      if (!profile) return json({ error: "Topic not found" }, 404);
      if (body.max_duration_min !== undefined) profile.current_limits.max_duration_min = body.max_duration_min;
      if (body.max_budget_usd !== undefined) profile.current_limits.max_budget_usd = body.max_budget_usd;
      profile.current_limits.source = "default";
      profile.updated_at = new Date().toISOString();
      await putItem(profile);
      return json(profile);
    }
  }

  return json({ error: "not_found" }, 404);
}
