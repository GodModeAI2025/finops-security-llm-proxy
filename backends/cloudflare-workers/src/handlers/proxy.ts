import { Env, TokenData, UsageData, revokeToken, getUsageStub } from "../types";
import { PROVIDERS, resolveProvider, getProviderKey, calculateCost } from "../providers";

// ============================================================
// Simple in-memory rate limiter (per-isolate)
// ============================================================

const rateBuckets = new Map<string, number[]>();

function checkRate(tokenId: string, max: number): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  let bucket = rateBuckets.get(tokenId) ?? [];
  bucket = bucket.filter((t) => t > cutoff);
  if (bucket.length === 0) {
    rateBuckets.delete(tokenId);
  }
  if (bucket.length >= max) return false;
  bucket.push(now);
  rateBuckets.set(tokenId, bucket);
  return true;
}

// ============================================================
// Proxy handler
// ============================================================

export async function handleProxy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // ── 1. Extract token ───────────────────────────────────
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ptk_")) {
    return Response.json(
      { error: "unauthorized", message: "Expected: Bearer ptk_..." },
      { status: 401 }
    );
  }
  const tokenId = auth.slice(7);

  // ── 2. Load token from KV ──────────────────────────────
  const token = await env.TOKENS.get<TokenData>(tokenId, "json");
  if (!token) {
    return Response.json({ error: "token_not_found" }, { status: 401 });
  }
  if (token.status === "revoked") {
    return Response.json(
      { error: "token_revoked", reason: token.revoke_reason, revoked_at: token.revoked_at },
      { status: 403 }
    );
  }

  // ── 3. Check TTL ───────────────────────────────────────
  if (token.rules.ttl_expires_at && new Date(token.rules.ttl_expires_at) <= new Date()) {
    await revokeToken(env, token, "ttl_expired");
    return Response.json({ error: "token_expired", message: "TTL expired, auto-revoked." }, { status: 403 });
  }

  // ── 4. Parse body ──────────────────────────────────────
  const body = await request.json<any>();
  const model: string = body.model;
  if (!model) {
    return Response.json({ error: "missing_model" }, { status: 400 });
  }

  // ── 5. Resolve provider ────────────────────────────────
  const providerName = resolveProvider(model);
  if (!providerName || !PROVIDERS[providerName]) {
    return Response.json({ error: "unknown_model", model }, { status: 400 });
  }

  // ── 6. Scope checks ───────────────────────────────────
  if (
    !token.scope.allowed_providers.includes(providerName) &&
    !token.scope.allowed_providers.includes("*")
  ) {
    return Response.json({ error: "provider_not_allowed", provider: providerName }, { status: 403 });
  }
  if (
    !token.scope.allowed_models.includes(model) &&
    !token.scope.allowed_models.includes("*")
  ) {
    return Response.json({ error: "model_not_allowed", model }, { status: 403 });
  }

  // ── 7. Budget + fail streak (from DO) ──────────────────
  const doStub = getUsageStub(env, tokenId);
  const usageRes = await doStub.fetch(new Request("http://do/usage"));
  const usage = await usageRes.json<UsageData>();

  if (usage.total_cost_usd >= token.rules.max_budget_usd) {
    await revokeToken(env, token, "budget_exceeded");
    return Response.json({ error: "budget_exceeded", used: usage.total_cost_usd, limit: token.rules.max_budget_usd }, { status: 403 });
  }
  if (usage.fail_streak >= token.rules.max_fail_streak) {
    await revokeToken(env, token, "fail_streak_exceeded");
    return Response.json({ error: "fail_streak_exceeded" }, { status: 403 });
  }

  // ── 8. Rate limit ──────────────────────────────────────
  if (!checkRate(tokenId, token.rules.max_requests_per_min)) {
    return Response.json({ error: "rate_limited", retry_after_seconds: 60 }, { status: 429 });
  }

  // ── 9. Get real key + forward ──────────────────────────
  const realKey = getProviderKey(providerName, env);
  if (!realKey) {
    return Response.json({ error: "key_not_configured", provider: providerName }, { status: 500 });
  }

  const provider = PROVIDERS[providerName];
  const isStream = body.stream === true;

  // Inject stream_options for OpenAI streaming
  const forwardBody = { ...body };
  if (isStream && providerName === "openai") {
    forwardBody.stream_options = { include_usage: true };
  }

  const targetUrl = `${provider.base_url}${provider.chat_path}`;

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...provider.auth_header(realKey) },
      body: JSON.stringify(forwardBody),
    });

    const success = upstreamRes.ok;

    if (isStream) {
      // ── Streaming: pipe through, track after ─────────
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const reader = upstreamRes.body?.getReader();
      const decoder = new TextDecoder();
      let streamedUsage: { input_tokens: number; output_tokens: number } | null = null;

      // Process in background — waitUntil ensures the worker doesn't shut down before tracking completes
      ctx.waitUntil((async () => {
        try {
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await writer.write(value);

              // Try parsing usage from chunks
              const chunk = decoder.decode(value, { stream: true });
              if (chunk.includes('"usage"') || chunk.includes('"message_delta"')) {
                const parsed = provider.parse_usage?.(tryParseStreamChunk(chunk));
                if (parsed) streamedUsage = parsed;
              }
            }
          }
        } catch (e) {
          console.error("Stream error:", e);
        } finally {
          await writer.close();

          // Track usage
          const inputTokens = streamedUsage?.input_tokens ?? estimateTokens(body);
          const outputTokens = streamedUsage?.output_tokens ?? 0;
          const cost = calculateCost(model, inputTokens, outputTokens);

          const trackRes = await doStub.fetch(
            new Request("http://do/track", {
              method: "POST",
              body: JSON.stringify({ provider: providerName, input_tokens: inputTokens, output_tokens: outputTokens, cost, success }),
            })
          );
          const trackedUsage = await trackRes.json<UsageData>();

          // Auto-revoke check
          await checkAutoRevoke(env, token, trackedUsage);
        }
      })());

      return new Response(readable, {
        status: upstreamRes.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } else {
      // ── Non-streaming ────────────────────────────────
      const responseBody = await upstreamRes.json<any>();
      const parsed = provider.parse_usage(responseBody);
      const inputTokens = parsed?.input_tokens ?? 0;
      const outputTokens = parsed?.output_tokens ?? 0;
      const cost = calculateCost(model, inputTokens, outputTokens);

      // Track usage in DO
      const trackRes = await doStub.fetch(
        new Request("http://do/track", {
          method: "POST",
          body: JSON.stringify({ provider: providerName, input_tokens: inputTokens, output_tokens: outputTokens, cost, success }),
        })
      );
      const updatedUsage = await trackRes.json<UsageData>();

      // Auto-revoke
      await checkAutoRevoke(env, token, updatedUsage);

      return Response.json(responseBody, {
        status: upstreamRes.status,
        headers: {
          "X-Proxy-Usage": JSON.stringify({
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cost_usd: Number(cost.toFixed(6)),
            total_cost_usd: Number(updatedUsage.total_cost_usd.toFixed(6)),
            budget_remaining_usd: Number((token.rules.max_budget_usd - updatedUsage.total_cost_usd).toFixed(6)),
          }),
        },
      });
    }
  } catch (err: any) {
    // Track failed request
    const estimatedInput = estimateTokens(body);
    const cost = calculateCost(model, estimatedInput, 0);
    await doStub.fetch(
      new Request("http://do/track", {
        method: "POST",
        body: JSON.stringify({ provider: providerName, input_tokens: estimatedInput, output_tokens: 0, cost, success: false }),
      })
    );

    return Response.json({ error: "upstream_error", message: err.message }, { status: 502 });
  }
}

// ============================================================
// Helpers
// ============================================================

function estimateTokens(body: any): number {
  return Math.ceil(JSON.stringify(body.messages ?? body).length / 4);
}

function tryParseStreamChunk(chunk: string): any {
  const lines = chunk.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
  for (const line of lines) {
    try {
      return JSON.parse(line.slice(6));
    } catch {}
  }
  return {};
}

async function checkAutoRevoke(env: Env, token: TokenData, usage: UsageData): Promise<void> {
  let reason: string | null = null;
  if (usage.total_cost_usd >= token.rules.max_budget_usd) reason = "budget_exceeded";
  else if (usage.fail_streak >= token.rules.max_fail_streak) reason = "fail_streak_exceeded";

  if (reason) {
    await revokeToken(env, token, reason);
  }
}
