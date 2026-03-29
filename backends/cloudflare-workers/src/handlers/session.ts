import { Env, TokenData, UsageData, revokeToken, getUsage, generateTokenId } from "../types";
import {
  getOrCreateProfile,
  getProfile,
  calculateLimits,
  recordAndRecalculate,
  listAllProfiles,
  SessionDatapoint,
} from "../topic-profiler";

// ============================================================
// Session handler
// ============================================================

export async function handleSession(request: Request, env: Env, path: string): Promise<Response> {

  // ── POST /v1/session — Open session ────────────────────
  if (request.method === "POST" && path === "/v1/session") {
    const body = await request.json<{ topic: string; model: string }>();
    if (!body.topic || !body.model) {
      return Response.json({ error: "Missing topic and model" }, { status: 400 });
    }

    const profile = await getOrCreateProfile(env, body.topic, body.model);
    const limits = calculateLimits(profile);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + limits.max_duration_min * 60_000);

    // Generate session ID and token
    const sessionId = `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const tokenId = generateTokenId();

    const token: TokenData = {
      id: tokenId,
      name: `session:${sessionId}`,
      owner: `topic:${body.topic}`,
      status: "active",
      revoke_reason: null,
      created_at: now.toISOString(),
      revoked_at: null,
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
    };

    // Store token and session metadata in parallel
    await Promise.all([
      env.TOKENS.put(tokenId, JSON.stringify(token)),
      env.TOKENS.put(`session:${sessionId}`, JSON.stringify({
        token_id: tokenId,
        topic: body.topic,
        model: body.model,
        started_at: now.toISOString(),
        limits_source: limits.source,
      })),
    ]);

    return Response.json({
      session_id: sessionId,
      token: tokenId,
      model: body.model,
      topic: body.topic,
      limits: {
        max_duration_min: Number(limits.max_duration_min.toFixed(2)),
        max_budget_usd: Number(limits.max_budget_usd.toFixed(4)),
        source: limits.source,
        datapoints: limits.datapoints,
        safety_margin: limits.safety_margin,
      },
      expires_at: expiresAt.toISOString(),
      stats: profile.stats,
    }, { status: 201 });
  }

  // ── POST /v1/session/:id/complete — End session ────────
  const completeMatch = path.match(/^\/v1\/session\/(ses_[a-z0-9]+)\/complete$/);
  if (request.method === "POST" && completeMatch) {
    const sessionId = completeMatch[1];
    const body = await request.json<{ success: boolean; notes?: string }>();

    if (typeof body.success !== "boolean") {
      return Response.json({ error: "Missing success field" }, { status: 400 });
    }

    // Load session metadata
    const sessionMeta = await env.TOKENS.get<{
      token_id: string; topic: string; model: string; started_at: string; limits_source: string;
    }>(`session:${sessionId}`, "json");

    if (!sessionMeta) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Load token and usage in parallel (both depend on sessionMeta.token_id)
    const [token, usage] = await Promise.all([
      env.TOKENS.get<TokenData>(sessionMeta.token_id, "json"),
      getUsage(env, sessionMeta.token_id),
    ]);

    if (!token) {
      return Response.json({ error: "Token not found" }, { status: 404 });
    }
    if (token.status === "revoked") {
      return Response.json({ error: "Session already ended", reason: token.revoke_reason }, { status: 409 });
    }

    // Calculate actual duration
    const startedAt = new Date(sessionMeta.started_at);
    const now = new Date();
    const durationMin = (now.getTime() - startedAt.getTime()) / 60_000;

    // Revoke token
    await revokeToken(env, token, body.success ? "session_completed_success" : "session_completed_failure");

    // Record datapoint and recalculate
    const datapoint: SessionDatapoint = {
      session_id: sessionId,
      duration_min: Number(durationMin.toFixed(2)),
      cost_usd: usage.total_cost_usd,
      success: body.success,
      model: sessionMeta.model,
      completed_at: now.toISOString(),
      completed_by: "client",
    };

    const updatedProfile = await recordAndRecalculate(
      env, sessionMeta.topic, sessionMeta.model, datapoint
    );

    return Response.json({
      session_id: sessionId,
      completed: true,
      success: body.success,
      actual: {
        duration_min: datapoint.duration_min,
        cost_usd: Number(datapoint.cost_usd.toFixed(4)),
        total_requests: usage.total_requests,
      },
      topic_update: {
        topic: sessionMeta.topic,
        new_limits: updatedProfile.current_limits,
        datapoints: updatedProfile.datapoints,
        stats: updatedProfile.stats,
      },
    });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

// ============================================================
// Admin: Topic management
// ============================================================

export async function handleTopicAdmin(request: Request, env: Env, path: string): Promise<Response> {
  // Auth check
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.ADMIN_KEY}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // GET /admin/topics — List all
  if (request.method === "GET" && path === "/admin/topics") {
    const profiles = await listAllProfiles(env);
    const summary = profiles.map((p) => ({
      topic: p.topic, model: p.model, datapoints: p.datapoints,
      current_limits: p.current_limits, stats: p.stats, updated_at: p.updated_at,
    }));
    return Response.json({ topics: summary, count: summary.length });
  }

  // GET /admin/topics/:topic/:model — Detail
  const detailMatch = path.match(/^\/admin\/topics\/([^/]+)\/([^/]+)$/);
  if (request.method === "GET" && detailMatch) {
    const profile = await getProfile(env, detailMatch[1], detailMatch[2]);
    if (!profile) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(profile);
  }

  // PATCH /admin/topics/:topic/:model — Override limits
  if (request.method === "PATCH" && detailMatch) {
    const profile = await getProfile(env, detailMatch[1], detailMatch[2]);
    if (!profile) return Response.json({ error: "not_found" }, { status: 404 });

    const body = await request.json<{ max_duration_min?: number; max_budget_usd?: number }>();
    if (body.max_duration_min !== undefined) profile.current_limits.max_duration_min = body.max_duration_min;
    if (body.max_budget_usd !== undefined) profile.current_limits.max_budget_usd = body.max_budget_usd;
    profile.current_limits.source = "manual";
    profile.updated_at = new Date().toISOString();

    await env.TOKENS.put(`topic:${detailMatch[1]}:${detailMatch[2]}`, JSON.stringify(profile));
    return Response.json(profile);
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}
