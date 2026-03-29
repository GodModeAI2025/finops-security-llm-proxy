import { db } from "../utils/firestore";

const topicsCollection = db.collection("topics");

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
    source: "default" | "adaptive_max" | "adaptive_p90";
  };
  stats: TopicStats;
  history: SessionDatapoint[];
  updated_at: string;
}

export interface CalculatedLimits {
  max_duration_min: number;
  max_budget_usd: number;
  source: "default" | "adaptive_max" | "adaptive_p90";
  datapoints: number;
  safety_margin: number;
}

// ============================================================
// Constants
// ============================================================

const MAX_DURATION_MIN = 50;
const MAX_BUDGET_USD = 50;
const SAFETY_MARGIN = 0.10;
const MIN_DATAPOINTS_FOR_P90 = 5;

// ============================================================
// Core: Calculate adaptive limits
// ============================================================

export function calculateLimits(profile: TopicProfile | null): CalculatedLimits {
  // Stufe 1: Unknown topic
  if (!profile || profile.datapoints === 0) {
    return {
      max_duration_min: MAX_DURATION_MIN,
      max_budget_usd: MAX_BUDGET_USD,
      source: "default",
      datapoints: 0,
      safety_margin: SAFETY_MARGIN,
    };
  }

  const successful = profile.history.filter((s) => s.success && s.completed_by === "client");

  if (successful.length === 0) {
    return {
      max_duration_min: MAX_DURATION_MIN,
      max_budget_usd: MAX_BUDGET_USD,
      source: "default",
      datapoints: profile.datapoints,
      safety_margin: SAFETY_MARGIN,
    };
  }

  const durations = successful.map((s) => s.duration_min).sort((a, b) => a - b);
  const costs = successful.map((s) => s.cost_usd).sort((a, b) => a - b);

  // Stufe 2: Few datapoints (1-4)
  if (successful.length < MIN_DATAPOINTS_FOR_P90) {
    const maxDuration = durations[durations.length - 1];
    const maxCost = costs[costs.length - 1];
    return {
      max_duration_min: Math.min(maxDuration * (1 + SAFETY_MARGIN), MAX_DURATION_MIN),
      max_budget_usd: Math.min(maxCost * (1 + SAFETY_MARGIN), MAX_BUDGET_USD),
      source: "adaptive_max",
      datapoints: successful.length,
      safety_margin: SAFETY_MARGIN,
    };
  }

  // Stufe 3: P90
  const p90Duration = percentile(durations, 0.90);
  const p90Cost = percentile(costs, 0.90);

  return {
    max_duration_min: Math.min(p90Duration * (1 + SAFETY_MARGIN), MAX_DURATION_MIN),
    max_budget_usd: Math.min(p90Cost * (1 + SAFETY_MARGIN), MAX_BUDGET_USD),
    source: "adaptive_p90",
    datapoints: successful.length,
    safety_margin: SAFETY_MARGIN,
  };
}

// ============================================================
// Stats: Compute full statistics for a topic
// ============================================================

export function computeStats(history: SessionDatapoint[]): TopicStats {
  const successful = history.filter((s) => s.success && s.completed_by === "client");

  if (successful.length === 0) {
    return {
      min_cost_usd: 0, max_cost_usd: 0, avg_cost_usd: 0, median_cost_usd: 0, p90_cost_usd: 0,
      min_duration_min: 0, max_duration_min: 0, avg_duration_min: 0, median_duration_min: 0, p90_duration_min: 0,
      total_sessions: history.length, successful_sessions: successful.length,
      failed_sessions: history.length - successful.length,
      total_cost_usd: history.reduce((sum, s) => sum + s.cost_usd, 0),
    };
  }

  const costs = successful.map((s) => s.cost_usd).sort((a, b) => a - b);
  const durations = successful.map((s) => s.duration_min).sort((a, b) => a - b);

  return {
    min_cost_usd: round(costs[0]),
    max_cost_usd: round(costs[costs.length - 1]),
    avg_cost_usd: round(costs.reduce((a, b) => a + b, 0) / costs.length),
    median_cost_usd: round(percentile(costs, 0.50)),
    p90_cost_usd: round(percentile(costs, 0.90)),
    min_duration_min: round(durations[0]),
    max_duration_min: round(durations[durations.length - 1]),
    avg_duration_min: round(durations.reduce((a, b) => a + b, 0) / durations.length),
    median_duration_min: round(percentile(durations, 0.50)),
    p90_duration_min: round(percentile(durations, 0.90)),
    total_sessions: history.length,
    successful_sessions: successful.length,
    failed_sessions: history.length - successful.length,
    total_cost_usd: round(history.reduce((sum, s) => sum + s.cost_usd, 0)),
  };
}

// ============================================================
// Firestore operations
// ============================================================

function topicKey(topic: string, model: string): string {
  return `${topic}:${model}`;
}

function defaultProfile(topic: string, model: string): TopicProfile {
  return {
    topic,
    model,
    datapoints: 0,
    current_limits: {
      max_duration_min: MAX_DURATION_MIN,
      max_budget_usd: MAX_BUDGET_USD,
      source: "default",
    },
    stats: computeStats([]),
    history: [],
    updated_at: new Date().toISOString(),
  };
}

export async function getProfile(topic: string, model: string): Promise<TopicProfile | null> {
  const doc = await topicsCollection.doc(topicKey(topic, model)).get();
  if (!doc.exists) return null;
  return doc.data() as TopicProfile;
}

export async function getOrCreateProfile(topic: string, model: string): Promise<TopicProfile> {
  const key = topicKey(topic, model);
  const docRef = topicsCollection.doc(key);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(docRef);
    if (doc.exists) return doc.data() as TopicProfile;

    const profile = defaultProfile(topic, model);
    tx.set(docRef, profile);
    return profile;
  });
}

export async function recordSessionAndRecalculate(
  topic: string,
  model: string,
  datapoint: SessionDatapoint
): Promise<TopicProfile> {
  const key = topicKey(topic, model);
  const docRef = topicsCollection.doc(key);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(docRef);
    const profile = doc.exists
      ? (doc.data() as TopicProfile)
      : defaultProfile(topic, model);

    profile.history.push(datapoint);
    profile.datapoints = profile.history.length;

    const newLimits = calculateLimits(profile);
    profile.current_limits = {
      max_duration_min: newLimits.max_duration_min,
      max_budget_usd: newLimits.max_budget_usd,
      source: newLimits.source,
    };

    profile.stats = computeStats(profile.history);
    profile.updated_at = new Date().toISOString();

    tx.set(docRef, profile);
    return profile;
  });
}

export async function listAllProfiles(): Promise<TopicProfile[]> {
  const snap = await topicsCollection.get();
  return snap.docs.map((d) => d.data() as TopicProfile);
}

export async function updateProfileOverride(
  topic: string,
  model: string,
  overrides: { max_duration_min?: number; max_budget_usd?: number }
): Promise<TopicProfile | null> {
  const key = topicKey(topic, model);
  const docRef = topicsCollection.doc(key);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(docRef);
    if (!doc.exists) return null;

    const profile = doc.data() as TopicProfile;

    if (overrides.max_duration_min !== undefined) {
      profile.current_limits.max_duration_min = overrides.max_duration_min;
    }
    if (overrides.max_budget_usd !== undefined) {
      profile.current_limits.max_budget_usd = overrides.max_budget_usd;
    }
    profile.current_limits.source = "default";
    profile.updated_at = new Date().toISOString();

    tx.set(docRef, profile);
    return profile;
  });
}

// ============================================================
// Math helpers
// ============================================================

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.min(index, sorted.length - 1)];
}

function round(n: number): number {
  return Number(n.toFixed(4));
}
