/**
 * Request-Guards gegen unbegrenzten Verbrauch (OWASP LLM "Unbounded Consumption").
 *
 * 1. max_tokens_per_request: begrenzt die Output-Tokens pro Request. Fehlt die Angabe
 *    im Request, wird das Limit gesetzt; liegt sie darüber, wird der Request abgelehnt.
 * 2. Agent-Loop-Breaker: Schickt ein Token denselben Request-Body in kurzer Folge immer
 *    wieder (typisch für hängende Agenten), wird er mit 429 geblockt, bevor Kosten entstehen.
 *
 * Laufzeit-neutral (kein Node-/Workers-spezifisches API) und in allen drei Backends identisch.
 * Der Loop-Zustand liegt im Speicher der Instanz — wie der Rate-Limiter. Er ist daher
 * best effort: Cloud Run/Lambda mit mehreren Instanzen bzw. Workers-Isolates zählen getrennt,
 * nach Kaltstart ist der Zähler leer. Schutz vor Kosten bietet weiterhin das Budget.
 */

// ============================================================
// max_tokens_per_request
// ============================================================

export type MaxTokensCheck =
  | { ok: true; body: any; applied: number; injected: boolean }
  | { ok: false; requested: number; limit: number };

/** Liefert das im Request angefragte Output-Limit (provider-spezifisches Feld). */
export function getRequestedMaxTokens(providerName: string, body: any): number | undefined {
  const value =
    providerName === "openai"
      ? body.max_completion_tokens ?? body.max_tokens
      : providerName === "google"
        ? body.generationConfig?.maxOutputTokens
        : body.max_tokens;
  return typeof value === "number" ? value : undefined;
}

/**
 * Setzt bzw. prüft das Output-Limit. Gibt einen neuen Body zurück, der Original-Body
 * bleibt unverändert. limit <= 0 oder undefined bedeutet: keine Begrenzung.
 */
export function enforceMaxTokens(providerName: string, body: any, limit: number | undefined): MaxTokensCheck {
  if (!limit || limit <= 0) {
    return { ok: true, body, applied: getRequestedMaxTokens(providerName, body) ?? 0, injected: false };
  }

  const requested = getRequestedMaxTokens(providerName, body);
  if (requested !== undefined) {
    if (requested > limit) return { ok: false, requested, limit };
    return { ok: true, body, applied: requested, injected: false };
  }

  const capped = { ...body };
  if (providerName === "openai") {
    capped.max_completion_tokens = limit;
  } else if (providerName === "google") {
    capped.generationConfig = { ...(body.generationConfig ?? {}), maxOutputTokens: limit };
  } else {
    capped.max_tokens = limit;
  }
  return { ok: true, body: capped, applied: limit, injected: true };
}

// ============================================================
// Agent-Loop-Breaker
// ============================================================

/** Default-Zeitfenster, in dem identische Requests gezählt werden. */
export const LOOP_WINDOW_MS = 120_000;
/**
 * Default: so viele identische Requests sind im Fenster erlaubt; der nächste wird geblockt.
 * Bewusst nicht zu knapp: SDK-Retries nach Netzwerkfehlern (meist 2–3 Wiederholungen) und
 * Best-of-N-Sampling mit Temperatur > 0 schicken legitim denselben Body mehrfach.
 */
export const LOOP_MAX_IDENTICAL = 5;

export interface LoopConfig {
  /** 0 = Loop-Breaker aus. */
  maxIdentical: number;
  windowMs: number;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = { maxIdentical: LOOP_MAX_IDENTICAL, windowMs: LOOP_WINDOW_MS };

/**
 * Konfiguration aus Umgebungsvariablen (process.env bzw. Workers-env):
 * AGENT_LOOP_MAX_IDENTICAL (0 = aus), AGENT_LOOP_WINDOW_SECONDS. Ungültige Werte → Default.
 */
export function loopConfigFromEnv(env: Record<string, unknown> | undefined): LoopConfig {
  const read = (name: string): number | undefined => {
    const raw = env?.[name];
    if (raw === undefined || raw === null || raw === "") return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  };
  const windowSeconds = read("AGENT_LOOP_WINDOW_SECONDS");
  return {
    maxIdentical: read("AGENT_LOOP_MAX_IDENTICAL") ?? LOOP_MAX_IDENTICAL,
    windowMs: windowSeconds ? windowSeconds * 1000 : LOOP_WINDOW_MS,
  };
}

const loopHistory = new Map<string, number[]>();

/**
 * Fingerprint eines Requests: Body ohne Transport-Felder (stream, stream_options),
 * damit ein Wechsel zwischen Streaming und Non-Streaming keinen Loop verschleiert.
 * cyrb53-Hash — kein Kryptografie-Zweck, nur Wiedererkennung.
 */
export function fingerprintRequest(body: any): string {
  const { stream, stream_options, ...rest } = body ?? {};
  const input = JSON.stringify(rest);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export type LoopCheck = { blocked: false } | { blocked: true; repeats: number; retry_after_seconds: number };

/** Zählt den Request und meldet, ob er als Agent-Loop geblockt werden soll. */
export function checkAgentLoop(
  tokenId: string,
  body: any,
  config: LoopConfig = DEFAULT_LOOP_CONFIG,
  now = Date.now()
): LoopCheck {
  const { maxIdentical, windowMs } = config;
  if (maxIdentical <= 0) return { blocked: false };

  const key = `${tokenId}:${fingerprintRequest(body)}`;
  const seen = (loopHistory.get(key) ?? []).filter((t) => t > now - windowMs);

  if (seen.length >= maxIdentical) {
    loopHistory.set(key, seen);
    const retryAfterMs = seen[0] + windowMs - now;
    return { blocked: true, repeats: seen.length, retry_after_seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  seen.push(now);
  loopHistory.set(key, seen);

  // Speicher begrenzen: gelegentlich abgelaufene Einträge entfernen
  if (loopHistory.size > 10_000) {
    for (const [k, times] of loopHistory) {
      if (times.every((t) => t <= now - windowMs)) loopHistory.delete(k);
    }
  }
  return { blocked: false };
}
