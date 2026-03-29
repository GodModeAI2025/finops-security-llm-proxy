/**
 * Simple sliding-window rate limiter (in-memory).
 * Good enough for a single Cloud Run instance.
 * For multi-instance, replace with Firestore or Redis.
 */

interface RateWindow {
  timestamps: number[];
}

const windows = new Map<string, RateWindow>();

export function checkRateLimit(tokenId: string, maxPerMin: number): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;

  let window = windows.get(tokenId);
  if (!window) {
    window = { timestamps: [] };
    windows.set(tokenId, window);
  }

  // Remove old entries
  window.timestamps = window.timestamps.filter((t) => t > cutoff);

  if (window.timestamps.length >= maxPerMin) {
    return false; // Rate limited
  }

  window.timestamps.push(now);
  return true;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, window] of windows.entries()) {
    window.timestamps = window.timestamps.filter((t) => t > cutoff);
    if (window.timestamps.length === 0) windows.delete(key);
  }
}, 300_000);
