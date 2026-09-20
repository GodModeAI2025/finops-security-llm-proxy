import { Router, Request, Response } from "express";
import { PROVIDERS, resolveProvider, calculateCost } from "../providers";
import {
  getUsage,
  trackUsage,
  revokeToken,
  getPricing,
} from "../utils/firestore";
import { getProviderKey } from "../utils/secrets";
import { checkRateLimit } from "../middleware/rate-limiter";
import { proxyAuth } from "../middleware/auth";
import { enforceMaxTokens, checkAgentLoop, loopConfigFromEnv } from "../services/request-guards";
import { createStreamUsageAccumulator } from "../services/stream-usage";
import { buildTargetUrl, buildForwardBody, checkProviderBody } from "../services/provider-request";

const router = Router();

router.post("/v1/chat", proxyAuth, async (req: Request, res: Response) => {
  const token = req.proxyToken!;
  const body = req.body;
  const model: string = body.model;

  if (!model) {
    return res.status(400).json({ error: "missing_model", message: "Request body must include 'model'." });
  }

  // ── 1. Resolve provider ──────────────────────────────────
  const providerName = resolveProvider(model);
  if (!providerName) {
    return res.status(400).json({
      error: "unknown_model",
      message: `Cannot determine provider for model "${model}".`,
    });
  }

  const providerConfig = PROVIDERS[providerName];
  if (!providerConfig) {
    return res.status(400).json({
      error: "unsupported_provider",
      message: `Provider "${providerName}" is not configured.`,
    });
  }

  // ── 2. Check scope ───────────────────────────────────────
  if (
    !token.scope.allowed_providers.includes(providerName) &&
    !token.scope.allowed_providers.includes("*")
  ) {
    return res.status(403).json({
      error: "provider_not_allowed",
      message: `Token is not allowed to use provider "${providerName}".`,
    });
  }

  if (
    !token.scope.allowed_models.includes(model) &&
    !token.scope.allowed_models.includes("*")
  ) {
    return res.status(403).json({
      error: "model_not_allowed",
      message: `Token is not allowed to use model "${model}".`,
    });
  }

  // ── 3. Check budget ──────────────────────────────────────
  const usage = await getUsage(token.id);
  if (usage && usage.total_cost_usd >= token.rules.max_budget_usd) {
    await revokeToken(token.id, "budget_exceeded");
    return res.status(403).json({
      error: "budget_exceeded",
      message: `Token budget of $${token.rules.max_budget_usd} has been exceeded ($${usage.total_cost_usd.toFixed(4)} used). Token revoked.`,
    });
  }

  // ── 4. Check fail streak ─────────────────────────────────
  if (usage && usage.fail_streak >= token.rules.max_fail_streak) {
    await revokeToken(token.id, "fail_streak_exceeded");
    return res.status(403).json({
      error: "fail_streak_exceeded",
      message: `Token exceeded max fail streak of ${token.rules.max_fail_streak}. Token revoked.`,
    });
  }

  // ── 5. Rate limit ────────────────────────────────────────
  if (!checkRateLimit(token.id, token.rules.max_requests_per_min)) {
    return res.status(429).json({
      error: "rate_limited",
      message: `Rate limit of ${token.rules.max_requests_per_min} requests/min exceeded.`,
      retry_after_seconds: 60,
    });
  }

  // ── 6. Output-Limit (max_tokens_per_request) ──────────────
  const maxTokens = enforceMaxTokens(providerName, body, token.rules.max_tokens_per_request);
  if (!maxTokens.ok) {
    return res.status(400).json({
      error: "max_tokens_exceeded",
      message: `Requested ${maxTokens.requested} output tokens, token allows at most ${maxTokens.limit}.`,
    });
  }

  // ── 7. Agent-Loop-Breaker ────────────────────────────────
  const loop = checkAgentLoop(token.id, body, loopConfigFromEnv(process.env));
  if (loop.blocked) {
    return res.status(429).json({
      error: "agent_loop_detected",
      message: `Identical request repeated ${loop.repeats} times within a short window. Change the request or wait.`,
      retry_after_seconds: loop.retry_after_seconds,
    });
  }

  // ── 8. Body-Format des Providers prüfen ──────────────────
  const bodyCheck = checkProviderBody(providerName, maxTokens.body);
  if (!bodyCheck.ok) {
    return res.status(400).json({ error: bodyCheck.error, message: bodyCheck.message });
  }

  // ── 9. Get real API key ──────────────────────────────────
  let realApiKey: string;
  try {
    realApiKey = await getProviderKey(providerName);
  } catch (err: any) {
    console.error(`Failed to get API key for ${providerName}:`, err);
    return res.status(500).json({
      error: "key_resolution_failed",
      message: `Could not resolve API key for provider "${providerName}".`,
    });
  }

  // ── 10. Forward request ──────────────────────────────────
  const isStream = body.stream === true;
  // Pfad-Platzhalter ({model}) und provider-eigene Body-Regeln, siehe provider-request.ts
  const targetUrl = buildTargetUrl(providerName, providerConfig.base_url, providerConfig.chat_path, model, isStream);
  const forwardBody = buildForwardBody(providerName, maxTokens.body, isStream);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...providerConfig.auth_header(realApiKey),
  };

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(forwardBody),
    });

    if (isStream) {
      // ── Streaming response ─────────────────────────────
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.status(upstreamRes.status);

      // Usage wird über Chunk-Grenzen hinweg zeilenweise eingesammelt.
      const usageAccumulator = createStreamUsageAccumulator(providerName);
      const reader = upstreamRes.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            res.write(chunk);
            usageAccumulator.push(chunk);
          }
        } catch (streamErr) {
          console.error("Stream read error:", streamErr);
        }
      }

      res.end();
      usageAccumulator.flush();
      const streamUsage = usageAccumulator.result();

      // Track usage after stream completes
      const pricing = await getPricing();
      // Fehlt die Input-Angabe (abgebrochener Stream, unbekannter Provider), wird geschätzt.
      const inputTokens = streamUsage.input_tokens || estimateInputTokens(body);
      const outputTokens = streamUsage.output_tokens;
      const cost = calculateCost(model, inputTokens, outputTokens, pricing);
      const success = upstreamRes.status >= 200 && upstreamRes.status < 300;

      const updatedUsage = await trackUsage(token.id, providerName, inputTokens, outputTokens, cost, success);
      await checkAutoRevoke(token.id, token.rules, updatedUsage);

    } else {
      // ── Non-streaming response ─────────────────────────
      const responseBody = await upstreamRes.json();
      const success = upstreamRes.status >= 200 && upstreamRes.status < 300;

      // Parse usage from response
      const parsed = providerConfig.parse_usage(responseBody);
      const inputTokens = parsed?.input_tokens ?? 0;
      const outputTokens = parsed?.output_tokens ?? 0;

      const pricing = await getPricing();
      const cost = calculateCost(model, inputTokens, outputTokens, pricing);

      // Track usage atomically
      const updatedUsage = await trackUsage(token.id, providerName, inputTokens, outputTokens, cost, success);

      // Set usage header
      res.setHeader("X-Proxy-Usage", JSON.stringify({
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: Number(cost.toFixed(6)),
        total_cost_usd: Number(updatedUsage.total_cost_usd.toFixed(6)),
        budget_remaining_usd: Number((token.rules.max_budget_usd - updatedUsage.total_cost_usd).toFixed(6)),
      }));

      // Auto-revocation check
      await checkAutoRevoke(token.id, token.rules, updatedUsage);

      // Forward response
      res.status(upstreamRes.status).json(responseBody);
    }
  } catch (err: any) {
    console.error("Proxy error:", err);

    // Track failed request
    const pricing = await getPricing();
    const estimatedInput = estimateInputTokens(body);
    const cost = calculateCost(model, estimatedInput, 0, pricing);
    await trackUsage(token.id, providerName, estimatedInput, 0, cost, false);

    return res.status(502).json({
      error: "upstream_error",
      message: `Failed to reach ${providerName}: ${err.message}`,
    });
  }
});

// ============================================================
// Helpers
// ============================================================

function estimateInputTokens(body: any): number {
  // Rough estimate: ~4 chars per token
  const bodyStr = JSON.stringify(body.messages || body);
  return Math.ceil(bodyStr.length / 4);
}

async function checkAutoRevoke(
  tokenId: string,
  rules: any,
  usage: any
): Promise<void> {
  if (usage.total_cost_usd >= rules.max_budget_usd) {
    await revokeToken(tokenId, "budget_exceeded");
    console.log(`Token ${tokenId} auto-revoked: budget_exceeded`);
  } else if (usage.fail_streak >= rules.max_fail_streak) {
    await revokeToken(tokenId, "fail_streak_exceeded");
    console.log(`Token ${tokenId} auto-revoked: fail_streak_exceeded`);
  }
}

export default router;
