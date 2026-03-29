import { Env, TokenData, UsageData, revokeToken, getUsageStub, getUsage, generateTokenId } from "../types";

// ============================================================
// Admin route handler
// ============================================================

export async function handleAdmin(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  // Auth check
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.ADMIN_KEY}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── POST /admin/tokens ─────────────────────────────────
  if (request.method === "POST" && path === "/admin/tokens") {
    const body = await request.json<any>();
    if (!body.name || !body.owner) {
      return Response.json({ error: "Missing name and owner" }, { status: 400 });
    }

    const token: TokenData = {
      id: generateTokenId(),
      name: body.name,
      owner: body.owner,
      status: "active",
      revoke_reason: null,
      created_at: new Date().toISOString(),
      revoked_at: null,
      rules: {
        ttl_expires_at: body.rules?.ttl_expires_at ?? null,
        max_budget_usd: body.rules?.max_budget_usd ?? 100,
        max_requests_per_min: body.rules?.max_requests_per_min ?? 60,
        max_tokens_per_request: body.rules?.max_tokens_per_request ?? 4096,
        max_fail_streak: body.rules?.max_fail_streak ?? 10,
      },
      scope: {
        allowed_providers: body.scope?.allowed_providers ?? ["anthropic", "openai"],
        allowed_models: body.scope?.allowed_models ?? ["*"],
      },
    };

    // Store in KV with optional TTL
    const kvOptions: KVNamespacePutOptions = {};
    if (token.rules.ttl_expires_at) {
      const ttlSeconds = Math.floor(
        (new Date(token.rules.ttl_expires_at).getTime() - Date.now()) / 1000
      );
      if (ttlSeconds > 0) kvOptions.expirationTtl = ttlSeconds;
    }

    await env.TOKENS.put(token.id, JSON.stringify(token), kvOptions);
    return Response.json(token, { status: 201 });
  }

  // ── GET /admin/tokens ──────────────────────────────────
  if (request.method === "GET" && path === "/admin/tokens") {
    const list = await env.TOKENS.list({ prefix: "ptk_" });
    const tokens = (await Promise.all(
      list.keys.map((key) => env.TOKENS.get<TokenData>(key.name, "json"))
    )).filter((t): t is TokenData => t !== null);

    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("status");
    const ownerFilter = url.searchParams.get("owner");

    const filtered = tokens.filter((t) => {
      if (statusFilter && t.status !== statusFilter) return false;
      if (ownerFilter && t.owner !== ownerFilter) return false;
      return true;
    });

    return Response.json({ tokens: filtered, count: filtered.length });
  }

  // ── GET /admin/tokens/:id ──────────────────────────────
  const tokenMatch = path.match(/^\/admin\/tokens\/(ptk_[a-z0-9]+)$/);
  if (request.method === "GET" && tokenMatch) {
    const token = await env.TOKENS.get<TokenData>(tokenMatch[1], "json");
    if (!token) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(token);
  }

  // ── PATCH /admin/tokens/:id ────────────────────────────
  if (request.method === "PATCH" && tokenMatch) {
    const token = await env.TOKENS.get<TokenData>(tokenMatch[1], "json");
    if (!token) return Response.json({ error: "not_found" }, { status: 404 });

    const updates = await request.json<any>();
    if (updates.rules) Object.assign(token.rules, updates.rules);
    if (updates.scope) Object.assign(token.scope, updates.scope);
    if (updates.name) token.name = updates.name;

    await env.TOKENS.put(token.id, JSON.stringify(token));
    return Response.json(token);
  }

  // ── DELETE /admin/tokens/:id ───────────────────────────
  if (request.method === "DELETE" && tokenMatch) {
    const token = await env.TOKENS.get(tokenMatch[1]);
    if (!token) return Response.json({ error: "not_found" }, { status: 404 });

    await env.TOKENS.delete(tokenMatch[1]);
    // Also clear the Durable Object
    const stub = getUsageStub(env, tokenMatch[1]);
    await stub.fetch(new Request("http://do/usage", { method: "DELETE" }));

    return Response.json({ deleted: true, id: tokenMatch[1] });
  }

  // ── POST /admin/revoke/:id ─────────────────────────────
  const revokeMatch = path.match(/^\/admin\/revoke\/(ptk_[a-z0-9]+)$/);
  if (request.method === "POST" && revokeMatch) {
    const token = await env.TOKENS.get<TokenData>(revokeMatch[1], "json");
    if (!token) return Response.json({ error: "not_found" }, { status: 404 });
    if (token.status === "revoked") {
      return Response.json({ error: "already_revoked", reason: token.revoke_reason }, { status: 409 });
    }

    const body = await request.json<any>().catch(() => ({}));
    await revokeToken(env, token, body.reason || "manual_revocation");

    return Response.json({ revoked: true, id: token.id, reason: token.revoke_reason });
  }

  // ── POST /admin/reactivate/:id ─────────────────────────
  const reactivateMatch = path.match(/^\/admin\/reactivate\/(ptk_[a-z0-9]+)$/);
  if (request.method === "POST" && reactivateMatch) {
    const token = await env.TOKENS.get<TokenData>(reactivateMatch[1], "json");
    if (!token) return Response.json({ error: "not_found" }, { status: 404 });

    token.status = "active";
    token.revoke_reason = null;
    token.revoked_at = null;
    await env.TOKENS.put(token.id, JSON.stringify(token));

    const stub = getUsageStub(env, token.id);
    await stub.fetch(new Request("http://do/reset-streak", { method: "POST" }));

    return Response.json({ reactivated: true, id: token.id });
  }

  // ── POST /admin/feedback/:id ───────────────────────────
  const feedbackMatch = path.match(/^\/admin\/feedback\/(ptk_[a-z0-9]+)$/);
  if (request.method === "POST" && feedbackMatch) {
    const token = await env.TOKENS.get<TokenData>(feedbackMatch[1], "json");
    if (!token) return Response.json({ error: "not_found" }, { status: 404 });

    const body = await request.json<{ success: boolean; reason?: string }>();
    if (typeof body.success !== "boolean") {
      return Response.json({ error: "Missing success field" }, { status: 400 });
    }

    const stub = getUsageStub(env, token.id);
    const res = await stub.fetch(
      new Request("http://do/feedback", {
        method: "POST",
        body: JSON.stringify({ success: body.success }),
      })
    );
    const result = await res.json<{ fail_streak: number }>();

    // Auto-revoke check
    if (!body.success && result.fail_streak >= token.rules.max_fail_streak) {
      await revokeToken(env, token, "fail_streak_exceeded_via_feedback");
      return Response.json({ recorded: true, fail_streak: result.fail_streak, auto_revoked: true });
    }

    return Response.json({ recorded: true, fail_streak: result.fail_streak, auto_revoked: false });
  }

  // ── GET /admin/usage/:id ───────────────────────────────
  const usageMatch = path.match(/^\/admin\/usage\/(ptk_[a-z0-9]+)$/);
  if (request.method === "GET" && usageMatch) {
    const token = await env.TOKENS.get<TokenData>(usageMatch[1], "json");
    if (!token) return Response.json({ error: "not_found" }, { status: 404 });

    const usage = await getUsage(env, token.id);
    const created = new Date(token.created_at);
    const endTime = token.revoked_at ? new Date(token.revoked_at) : new Date();
    const durationHours = (endTime.getTime() - created.getTime()) / 3_600_000;

    return Response.json({
      token_id: token.id,
      name: token.name,
      status: token.status,
      revoke_reason: token.revoke_reason,
      revoked_at: token.revoked_at,
      lifetime: {
        created_at: token.created_at,
        last_request_at: usage.last_request_at,
        duration_hours: Number(durationHours.toFixed(2)),
      },
      usage,
    });
  }

  // ── GET /admin/usage/summary ───────────────────────────
  if (request.method === "GET" && path === "/admin/usage/summary") {
    const list = await env.TOKENS.list({ prefix: "ptk_" });
    const allTokens = (await Promise.all(
      list.keys.map((key) => env.TOKENS.get<TokenData>(key.name, "json"))
    )).filter((t): t is TokenData => t !== null);

    const allUsages = await Promise.all(
      allTokens.map((token) => getUsage(env, token.id))
    );

    let totalCost = 0;
    let totalRequests = 0;
    let active = 0;
    let revoked = 0;
    const consumers: { id: string; name: string; cost_usd: number }[] = [];

    for (let i = 0; i < allTokens.length; i++) {
      const token = allTokens[i];
      const usage = allUsages[i];
      if (token.status === "active") active++;
      else revoked++;

      totalCost += usage.total_cost_usd;
      totalRequests += usage.total_requests;
      consumers.push({ id: token.id, name: token.name, cost_usd: usage.total_cost_usd });
    }

    consumers.sort((a, b) => b.cost_usd - a.cost_usd);
    return Response.json({
      total_tokens: list.keys.length,
      active_tokens: active,
      revoked_tokens: revoked,
      total_cost_usd: Number(totalCost.toFixed(4)),
      total_requests: totalRequests,
      top_consumers: consumers.slice(0, 10),
    });
  }

  // ── POST /admin/cleanup ────────────────────────────────
  if (request.method === "POST" && path === "/admin/cleanup") {
    const list = await env.TOKENS.list({ prefix: "ptk_" });
    const now = new Date();

    const allTokens = (await Promise.all(
      list.keys.map((key) => env.TOKENS.get<TokenData>(key.name, "json"))
    )).filter((t): t is TokenData => t !== null);

    const expired = allTokens.filter(
      (t) => t.status === "active" && t.rules.ttl_expires_at && new Date(t.rules.ttl_expires_at) <= now
    );

    await Promise.all(expired.map((t) => revokeToken(env, t, "ttl_expired")));

    return Response.json({ cleaned: expired.length, timestamp: now.toISOString() });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}
