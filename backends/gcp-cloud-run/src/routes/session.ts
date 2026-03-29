import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { adminAuth } from "../middleware/auth";
import { createToken, getTokenBySessionId, updateToken, getUsage, revokeToken } from "../utils/firestore";
import {
  getOrCreateProfile,
  getProfile,
  calculateLimits,
  recordSessionAndRecalculate,
  listAllProfiles,
  updateProfileOverride,
  SessionDatapoint,
} from "../services/topic-profiler";

const router = Router();

// ============================================================
// POST /v1/session — Open a new session
// ============================================================

router.post("/v1/session", async (req: Request, res: Response) => {
  try {
    const { topic, model } = req.body;

    if (!topic || !model) {
      return res.status(400).json({
        error: "missing_fields",
        message: "Required: topic, model",
      });
    }

    // Load or create topic profile, calculate limits
    const profile = await getOrCreateProfile(topic, model);
    const limits = calculateLimits(profile);

    // Calculate expiration from duration limit
    const now = new Date();
    const expiresAt = new Date(now.getTime() + limits.max_duration_min * 60_000);

    // Create a proxy token with the adaptive limits
    const sessionId = `ses_${uuidv4().replace(/-/g, "").slice(0, 16)}`;

    const token = await createToken({
      name: `session:${sessionId}`,
      owner: `topic:${topic}`,
      rules: {
        ttl_expires_at: expiresAt.toISOString(),
        max_budget_usd: limits.max_budget_usd,
        max_requests_per_min: 60,
        max_tokens_per_request: 4096,
        max_fail_streak: 10,
      },
      scope: {
        allowed_providers: ["anthropic", "openai", "google"],
        allowed_models: [model],
      },
    });

    // Store session metadata on the token
    await updateToken(token.id, {
      session_id: sessionId,
      topic,
      session_started_at: now.toISOString(),
      limits_source: limits.source,
    } as any);

    res.status(201).json({
      session_id: sessionId,
      token: token.id,
      model,
      topic,
      limits: {
        max_duration_min: Number(limits.max_duration_min.toFixed(2)),
        max_budget_usd: Number(limits.max_budget_usd.toFixed(4)),
        source: limits.source,
        datapoints: limits.datapoints,
        safety_margin: limits.safety_margin,
      },
      expires_at: expiresAt.toISOString(),
      stats: profile.stats,
    });
  } catch (err: any) {
    console.error("Session creation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /v1/session/:id/complete — Client completes session
// ============================================================

router.post("/v1/session/:sessionId/complete", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { success } = req.body;

    if (typeof success !== "boolean") {
      return res.status(400).json({ error: "Missing required field: success (boolean)" });
    }

    // Find the token belonging to this session
    const tokenData = await getTokenBySessionId(sessionId);
    if (!tokenData) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (tokenData.status === "revoked") {
      return res.status(409).json({
        error: "session_already_ended",
        reason: tokenData.revoke_reason,
      });
    }

    // Get actual usage
    const usage = await getUsage(tokenData.id);
    const startedAt = new Date(tokenData.session_started_at);
    const now = new Date();
    const durationMin = (now.getTime() - startedAt.getTime()) / 60_000;

    // Revoke the token
    await revokeToken(tokenData.id, success ? "session_completed_success" : "session_completed_failure");

    // Record datapoint in topic profile
    const datapoint: SessionDatapoint = {
      session_id: sessionId,
      duration_min: Number(durationMin.toFixed(2)),
      cost_usd: usage?.total_cost_usd ?? 0,
      success,
      model: tokenData.scope?.allowed_models?.[0] ?? "unknown",
      completed_at: now.toISOString(),
      completed_by: "client",
    };

    const updatedProfile = await recordSessionAndRecalculate(
      tokenData.topic,
      datapoint.model,
      datapoint
    );

    res.json({
      session_id: sessionId,
      completed: true,
      success,
      actual: {
        duration_min: datapoint.duration_min,
        cost_usd: Number(datapoint.cost_usd.toFixed(4)),
        total_requests: usage?.total_requests ?? 0,
      },
      topic_update: {
        topic: tokenData.topic,
        new_limits: updatedProfile.current_limits,
        datapoints: updatedProfile.datapoints,
        stats: updatedProfile.stats,
      },
    });
  } catch (err: any) {
    console.error("Session complete error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Admin: GET /admin/topics — List all topic profiles with stats
// ============================================================

router.get("/admin/topics", adminAuth, async (_req: Request, res: Response) => {
  try {
    const profiles = await listAllProfiles();

    const summary = profiles.map((p) => ({
      topic: p.topic,
      model: p.model,
      datapoints: p.datapoints,
      current_limits: p.current_limits,
      stats: p.stats,
      updated_at: p.updated_at,
    }));

    res.json({ topics: summary, count: summary.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Admin: GET /admin/topics/:topic/:model — Single topic detail
// ============================================================

router.get("/admin/topics/:topic/:model", adminAuth, async (req: Request, res: Response) => {
  try {
    const profile = await getProfile(req.params.topic, req.params.model);
    if (!profile) return res.status(404).json({ error: "Topic profile not found" });
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Admin: PATCH /admin/topics/:topic/:model — Manual override
// ============================================================

router.patch("/admin/topics/:topic/:model", adminAuth, async (req: Request, res: Response) => {
  try {
    const updated = await updateProfileOverride(
      req.params.topic,
      req.params.model,
      req.body
    );
    if (!updated) return res.status(404).json({ error: "Topic profile not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
