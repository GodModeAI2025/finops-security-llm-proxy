import { Env } from "./types";

// ============================================================
// Types
// ============================================================

export interface SessionDatapoint {
  session_id: string;
  duration_min: number;
  cost_usd: number;
  success: boolean;
  model: string;
  completed_at: string;
  completed_by: "client" | "system";
}

export interface TopicStats {
  min_cost_usd: number;
  max_cost_usd: number;
  avg_cost_usd: number;
  median_cost_usd: number;
  p90_cost_usd: number;
  min_duration_min: number;
  max_duration_min: number;
  avg_duration_min: number;
  median_duration_min: number;
  p90_duration_min: number;
  total_sessions: number;
  successful_sessions: number;
  failed_sessions: number;
  total_cost_usd: number;
}

export interface TopicProfile {
  topic: string;
  model: string;
  datapoints: number;
  current_limits: {
    max_duration_min: number;
    max_budget_usd: number;
    source: "default" | "adaptive_max" | "adaptive_p90" | "manual";
  };
  stats: TopicStats;
  history: SessionDatapoint[];
  updated_at: string;
}

export interface CalculatedLimits {
  max_duration_min: number;
  max_budget_usd: number;
  source: "default" | "adaptive_max" | "adaptive_p90" | "manual";
  datapoints: number;
  safety_margin: number;
}

// ============================================================
// Constants
// ============================================================

const MAX_DURATION = 50;
const MAX_BUDGET = 50;
const MARGIN = 0.10;
const MIN_FOR_P90 = 5;

// ============================================================
// Core algorithm (pure, no I/O)
// ============================================================

export function calculateLimits(profile: TopicProfile | null): CalculatedLimits {
  if (!profile || profile.datapoints === 0) {
    return { max_duration_min: MAX_DURATION, max_budget_usd: MAX_BUDGET, source: "default", datapoints: 0, safety_margin: MARGIN };
  }

  const ok = profile.history.filter((s) => s.success && s.completed_by === "client");
  if (ok.length === 0) {
    return { max_duration_min: MAX_DURATION, max_budget_usd: MAX_BUDGET, source: "default", datapoints: profile.datapoints, safety_margin: MARGIN };
  }

  const durations = ok.map((s) => s.duration_min).sort((a, b) => a - b);
  const costs = ok.map((s) => s.cost_usd).sort((a, b) => a - b);

  if (ok.length < MIN_FOR_P90) {
    return {
      max_duration_min: Math.min(durations[durations.length - 1] * (1 + MARGIN), MAX_DURATION),
      max_budget_usd: Math.min(costs[costs.length - 1] * (1 + MARGIN), MAX_BUDGET),
      source: "adaptive_max", datapoints: ok.length, safety_margin: MARGIN,
    };
  }

  return {
    max_duration_min: Math.min(pct(durations, 0.90) * (1 + MARGIN), MAX_DURATION),
    max_budget_usd: Math.min(pct(costs, 0.90) * (1 + MARGIN), MAX_BUDGET),
    source: "adaptive_p90", datapoints: ok.length, safety_margin: MARGIN,
  };
}

export function computeStats(history: SessionDatapoint[]): TopicStats {
  const ok = history.filter((s) => s.success && s.completed_by === "client");
  const all = history;

  if (ok.length === 0) {
    return {
      min_cost_usd: 0, max_cost_usd: 0, avg_cost_usd: 0, median_cost_usd: 0, p90_cost_usd: 0,
      min_duration_min: 0, max_duration_min: 0, avg_duration_min: 0, median_duration_min: 0, p90_duration_min: 0,
      total_sessions: all.length, successful_sessions: 0, failed_sessions: all.length,
      total_cost_usd: r(all.reduce((s, x) => s + x.cost_usd, 0)),
    };
  }

  const c = ok.map((s) => s.cost_usd).sort((a, b) => a - b);
  const d = ok.map((s) => s.duration_min).sort((a, b) => a - b);

  return {
    min_cost_usd: r(c[0]), max_cost_usd: r(c[c.length - 1]),
    avg_cost_usd: r(c.reduce((a, b) => a + b, 0) / c.length),
    median_cost_usd: r(pct(c, 0.50)), p90_cost_usd: r(pct(c, 0.90)),
    min_duration_min: r(d[0]), max_duration_min: r(d[d.length - 1]),
    avg_duration_min: r(d.reduce((a, b) => a + b, 0) / d.length),
    median_duration_min: r(pct(d, 0.50)), p90_duration_min: r(pct(d, 0.90)),
    total_sessions: all.length, successful_sessions: ok.length,
    failed_sessions: all.length - ok.length,
    total_cost_usd: r(all.reduce((s, x) => s + x.cost_usd, 0)),
  };
}

// ============================================================
// KV operations
// ============================================================

function topicKey(topic: string, model: string): string {
  return `topic:${topic}:${model}`;
}

export async function getProfile(env: Env, topic: string, model: string): Promise<TopicProfile | null> {
  return env.TOKENS.get<TopicProfile>(topicKey(topic, model), "json");
}

export async function getOrCreateProfile(env: Env, topic: string, model: string): Promise<TopicProfile> {
  const existing = await getProfile(env, topic, model);
  if (existing) return existing;

  const profile: TopicProfile = {
    topic, model, datapoints: 0,
    current_limits: { max_duration_min: MAX_DURATION, max_budget_usd: MAX_BUDGET, source: "default" },
    stats: computeStats([]),
    history: [],
    updated_at: new Date().toISOString(),
  };

  await env.TOKENS.put(topicKey(topic, model), JSON.stringify(profile));
  return profile;
}

export async function recordAndRecalculate(
  env: Env, topic: string, model: string, dp: SessionDatapoint
): Promise<TopicProfile> {
  const profile = await getOrCreateProfile(env, topic, model);
  profile.history.push(dp);
  profile.datapoints = profile.history.length;

  const lim = calculateLimits(profile);
  profile.current_limits = { max_duration_min: lim.max_duration_min, max_budget_usd: lim.max_budget_usd, source: lim.source };
  profile.stats = computeStats(profile.history);
  profile.updated_at = new Date().toISOString();

  await env.TOKENS.put(topicKey(topic, model), JSON.stringify(profile));
  return profile;
}

export async function listAllProfiles(env: Env): Promise<TopicProfile[]> {
  const list = await env.TOKENS.list({ prefix: "topic:" });
  const results = await Promise.all(
    list.keys.map((key) => env.TOKENS.get<TopicProfile>(key.name, "json"))
  );
  return results.filter((p): p is TopicProfile => p !== null);
}

// ============================================================
// Helpers
// ============================================================

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const i = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.min(i, sorted.length - 1)];
}

function r(n: number): number {
  return Number(n.toFixed(4));
}
