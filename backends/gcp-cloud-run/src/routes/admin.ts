import { Router, Request, Response } from "express";
import { adminAuth } from "../middleware/auth";
import {
  createToken,
  getToken,
  updateToken,
  deleteToken,
  listTokens,
  revokeToken,
  reactivateToken,
  getUsage,
  recordFeedback,
  cleanupExpiredTokens,
} from "../utils/firestore";
import { UsageResponse, CreateTokenRequest, FeedbackRequest } from "../types";

const router = Router();

// All admin routes require admin key
router.use(adminAuth);

// ============================================================
// Token CRUD
// ============================================================

// Create token
router.post("/tokens", async (req: Request, res: Response) => {
  try {
    const body = req.body as CreateTokenRequest;
    if (!body.name || !body.owner) {
      return res.status(400).json({ error: "Missing required fields: name, owner" });
    }
    const token = await createToken(body);
    res.status(201).json(token);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get token details
router.get("/tokens/:id", async (req: Request, res: Response) => {
  try {
    const token = await getToken(req.params.id);
    if (!token) return res.status(404).json({ error: "Token not found" });
    res.json(token);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update token rules/scope
router.patch("/tokens/:id", async (req: Request, res: Response) => {
  try {
    const token = await getToken(req.params.id);
    if (!token) return res.status(404).json({ error: "Token not found" });

    const updates: any = {};
    if (req.body.rules) {
      for (const [key, value] of Object.entries(req.body.rules)) {
        updates[`rules.${key}`] = value;
      }
    }
    if (req.body.scope) {
      for (const [key, value] of Object.entries(req.body.scope)) {
        updates[`scope.${key}`] = value;
      }
    }
    if (req.body.name) updates.name = req.body.name;

    await updateToken(req.params.id, updates);
    const updated = await getToken(req.params.id);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete token
router.delete("/tokens/:id", async (req: Request, res: Response) => {
  try {
    const token = await getToken(req.params.id);
    if (!token) return res.status(404).json({ error: "Token not found" });
    await deleteToken(req.params.id);
    res.json({ deleted: true, id: req.params.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List tokens (with optional filters)
router.get("/tokens", async (req: Request, res: Response) => {
  try {
    const filters: any = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.owner) filters.owner = req.query.owner;
    const tokens = await listTokens(filters);
    res.json({ tokens, count: tokens.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Revocation + Feedback
// ============================================================

// Revoke token
router.post("/revoke/:id", async (req: Request, res: Response) => {
  try {
    const token = await getToken(req.params.id);
    if (!token) return res.status(404).json({ error: "Token not found" });
    if (token.status === "revoked") {
      return res.status(409).json({ error: "Token already revoked", reason: token.revoke_reason });
    }

    const reason = req.body.reason || "manual_revocation";
    await revokeToken(req.params.id, reason);
    res.json({ revoked: true, id: req.params.id, reason });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Reactivate token
router.post("/reactivate/:id", async (req: Request, res: Response) => {
  try {
    const token = await getToken(req.params.id);
    if (!token) return res.status(404).json({ error: "Token not found" });
    if (token.status === "active") {
      return res.status(409).json({ error: "Token is already active" });
    }

    await reactivateToken(req.params.id);
    res.json({ reactivated: true, id: req.params.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// External feedback (success/failure)
router.post("/feedback/:id", async (req: Request, res: Response) => {
  try {
    const token = await getToken(req.params.id);
    if (!token) return res.status(404).json({ error: "Token not found" });

    const body = req.body as FeedbackRequest;
    if (typeof body.success !== "boolean") {
      return res.status(400).json({ error: "Missing required field: success (boolean)" });
    }

    const newStreak = await recordFeedback(req.params.id, body.success);

    // Auto-revoke on fail streak
    if (!body.success && newStreak >= token.rules.max_fail_streak) {
      await revokeToken(req.params.id, "fail_streak_exceeded_via_feedback");
      return res.json({
        recorded: true,
        fail_streak: newStreak,
        auto_revoked: true,
        reason: "fail_streak_exceeded_via_feedback",
      });
    }

    res.json({ recorded: true, fail_streak: newStreak, auto_revoked: false });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Usage + Monitoring
// ============================================================

// Aggregated usage summary across all tokens
router.get("/usage/summary", async (req: Request, res: Response) => {
  try {
    const allTokens = await listTokens();
    const usages = await Promise.all(allTokens.map((t) => getUsage(t.id)));

    let totalCost = 0;
    let totalRequests = 0;
    let activeCount = 0;
    let revokedCount = 0;
    const topConsumers: { id: string; name: string; cost_usd: number }[] = [];

    for (let i = 0; i < allTokens.length; i++) {
      const token = allTokens[i];
      const usage = usages[i];
      if (token.status === "active") activeCount++;
      else revokedCount++;

      if (usage) {
        totalCost += usage.total_cost_usd;
        totalRequests += usage.total_requests;
        topConsumers.push({
          id: token.id,
          name: token.name,
          cost_usd: usage.total_cost_usd,
        });
      }
    }

    topConsumers.sort((a, b) => b.cost_usd - a.cost_usd);

    res.json({
      total_tokens: allTokens.length,
      active_tokens: activeCount,
      revoked_tokens: revokedCount,
      total_cost_usd: Number(totalCost.toFixed(4)),
      total_requests: totalRequests,
      top_consumers: topConsumers.slice(0, 10),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get usage for a specific token
router.get("/usage/:id", async (req: Request, res: Response) => {
  try {
    const token = await getToken(req.params.id);
    if (!token) return res.status(404).json({ error: "Token not found" });

    const usage = await getUsage(req.params.id);
    if (!usage) return res.status(404).json({ error: "No usage data found" });

    const now = new Date();
    const created = new Date(token.created_at);
    const lastActive = usage.last_request_at
      ? new Date(usage.last_request_at)
      : created;
    const endTime = token.revoked_at ? new Date(token.revoked_at) : lastActive;
    const durationHours = (endTime.getTime() - created.getTime()) / 3_600_000;

    const response: UsageResponse = {
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
    };

    res.json(response);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// TTL Cleanup (called by Cloud Scheduler)
// ============================================================

router.post("/cleanup", async (_req: Request, res: Response) => {
  try {
    const count = await cleanupExpiredTokens();
    res.json({ cleaned: count, timestamp: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
