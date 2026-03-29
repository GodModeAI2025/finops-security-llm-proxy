import { UsageData } from "./types";

// ============================================================
// UsageCounter Durable Object
// Handles atomic usage tracking per token.
// Each token gets its own DO instance (keyed by token ID).
// ============================================================

export class UsageCounter implements DurableObject {
  private state: DurableObjectState;
  private usage: UsageData | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async load(): Promise<UsageData> {
    if (this.usage) return this.usage;
    this.usage = (await this.state.storage.get<UsageData>("usage")) ?? {
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
    return this.usage;
  }

  private async save(): Promise<void> {
    if (this.usage) {
      await this.state.storage.put("usage", this.usage);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /usage — return current usage
      if (request.method === "GET" && path === "/usage") {
        const usage = await this.load();
        return Response.json(usage);
      }

      // POST /track — record a request
      if (request.method === "POST" && path === "/track") {
        const body = await request.json<{
          provider: string;
          input_tokens: number;
          output_tokens: number;
          cost: number;
          success: boolean;
        }>();

        const usage = await this.load();

        usage.total_requests++;
        usage.total_input_tokens += body.input_tokens;
        usage.total_output_tokens += body.output_tokens;
        usage.total_cost_usd += body.cost;
        usage.last_request_at = new Date().toISOString();

        if (body.success) {
          usage.successful_requests++;
          usage.fail_streak = 0;
        } else {
          usage.failed_requests++;
          usage.fail_streak++;
        }

        // Per-provider breakdown
        if (!usage.by_provider[body.provider]) {
          usage.by_provider[body.provider] = { requests: 0, cost_usd: 0 };
        }
        usage.by_provider[body.provider].requests++;
        usage.by_provider[body.provider].cost_usd += body.cost;

        await this.save();
        return Response.json(usage);
      }

      // POST /feedback — external success/failure signal
      if (request.method === "POST" && path === "/feedback") {
        const body = await request.json<{ success: boolean }>();
        const usage = await this.load();

        if (body.success) {
          usage.fail_streak = 0;
        } else {
          usage.fail_streak++;
        }

        await this.save();
        return Response.json({ fail_streak: usage.fail_streak });
      }

      // POST /reset-streak — reset fail streak (on reactivation)
      if (request.method === "POST" && path === "/reset-streak") {
        const usage = await this.load();
        usage.fail_streak = 0;
        await this.save();
        return Response.json({ ok: true });
      }

      // DELETE /usage — clear all usage data
      if (request.method === "DELETE" && path === "/usage") {
        await this.state.storage.deleteAll();
        this.usage = null;
        return Response.json({ deleted: true });
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }
}
