import { Env } from "./types";
import { handleProxy } from "./handlers/proxy";
import { handleAdmin } from "./handlers/admin";
import { handleSession, handleTopicAdmin } from "./handlers/session";

// Re-export the Durable Object class
export { UsageCounter } from "./usage-counter";

// ============================================================
// Main Worker
// ============================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Health check ───────────────────────────────────
    if (path === "/health") {
      return Response.json({ status: "ok", runtime: "cloudflare-workers", timestamp: new Date().toISOString() });
    }

    // ── Session endpoints (adaptive provisioning) ─────
    if (path.startsWith("/v1/session")) {
      return handleSession(request, env, path);
    }

    // ── Proxy endpoint ─────────────────────────────────
    if (path === "/v1/chat" && request.method === "POST") {
      return handleProxy(request, env, ctx);
    }

    // ── Topic admin endpoints ─────────────────────────
    if (path.startsWith("/admin/topics")) {
      return handleTopicAdmin(request, env, path);
    }

    // ── Admin endpoints ────────────────────────────────
    if (path.startsWith("/admin/")) {
      return handleAdmin(request, env, path);
    }

    // ── 404 ────────────────────────────────────────────
    return Response.json(
      { error: "not_found", message: "Available: POST /v1/chat, /v1/session, /admin/*, GET /health" },
      { status: 404 }
    );
  },

  // ── Cron trigger (TTL cleanup every 5 min) ───────────
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Reuse the admin cleanup handler
    const fakeRequest = new Request("https://localhost/admin/cleanup", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
    });
    await handleAdmin(fakeRequest, env, "/admin/cleanup");
  },
};
