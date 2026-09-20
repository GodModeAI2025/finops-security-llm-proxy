/**
 * Ziel-URL und Forward-Body je Provider.
 *
 * Anthropic und OpenAI haben einen festen Pfad und nehmen den Body so entgegen, wie
 * der Client ihn schickt. Google/Gemini nicht — dort lief das Routing bisher ins Leere:
 *
 * 1. Der Pfad enthält den Platzhalter "{model}" (/v1beta/models/{model}:generateContent).
 *    Wurde er nicht ersetzt, antwortete Google mit 404 "models/%7Bmodel%7D is not found".
 * 2. Das Modell steht bei Gemini im Pfad, nicht im Body, und "stream" kennt die REST-API
 *    überhaupt nicht. Gemini lehnt unbekannte Body-Felder mit 400 INVALID_ARGUMENT ab —
 *    die reinen Proxy-Felder müssen vor dem Weiterleiten heraus.
 * 3. Gestreamt wird bei Gemini über ":streamGenerateContent?alt=sse"; ":generateContent"
 *    liefert immer die komplette Antwort am Stück, also keine SSE-Events und damit auch
 *    keine usageMetadata für die Stream-Erfassung.
 *
 * Der Body selbst wird weiterhin nicht übersetzt (Designentscheidung "Body 1:1
 * durchreichen"): für Google muss der Client das Gemini-Format schicken (contents,
 * generationConfig). checkProviderBody lehnt einen offensichtlich fremden Body mit einer
 * eindeutigen Meldung ab, statt ihn weiterzuleiten — sonst würde der Provider-Fehler als
 * fehlgeschlagener Request verbucht und im Streaming-Pfad sogar mit geschätzten
 * Input-Tokens bepreist, obwohl das Modell nie erreicht wurde.
 *
 * Laufzeit-neutral (kein Node-/Workers-spezifisches API) und in allen drei Backends identisch.
 */

/** Felder, die nur der Proxy braucht und die die Gemini-REST-API nicht kennt. */
const GOOGLE_PROXY_ONLY_FIELDS = ["model", "stream", "stream_options"];

/**
 * Baut die Ziel-URL. "{model}" im chat_path wird ersetzt (URL-kodiert, damit ein
 * Modellname den Pfad nicht verlassen kann); für gestreamte Google-Requests wird auf
 * den SSE-Endpunkt umgeschaltet.
 */
export function buildTargetUrl(
  providerName: string,
  baseUrl: string,
  chatPath: string,
  model: string,
  isStream: boolean
): string {
  let path = chatPath.replace("{model}", encodeURIComponent(model));
  if (providerName === "google" && isStream) {
    path = path.replace(":generateContent", ":streamGenerateContent?alt=sse");
  }
  return `${baseUrl}${path}`;
}

/**
 * Body für den Provider-Call. Der Original-Body bleibt unverändert.
 * OpenAI bekommt bei Streams stream_options.include_usage, damit die Usage im letzten
 * Chunk mitkommt; Google verliert die Proxy-Felder (siehe oben).
 */
export function buildForwardBody(providerName: string, body: any, isStream: boolean): any {
  const forward: any = { ...(body ?? {}) };
  if (providerName === "openai" && isStream) {
    forward.stream_options = { include_usage: true };
  }
  if (providerName === "google") {
    for (const field of GOOGLE_PROXY_ONLY_FIELDS) delete forward[field];
  }
  return forward;
}

export type ProviderBodyCheck =
  | { ok: true }
  | { ok: false; error: string; message: string };

/**
 * Prüft, ob der Body zum Provider passt. Relevant ist nur Google: dort ist das
 * Request-Format ein anderes und ein durchgereichter OpenAI-/Anthropic-Body würde beim
 * Provider scheitern, statt hier klar abgelehnt zu werden.
 */
export function checkProviderBody(providerName: string, body: any): ProviderBodyCheck {
  if (providerName !== "google") return { ok: true };

  if (!Array.isArray(body?.contents) || body.contents.length === 0) {
    return {
      ok: false,
      error: "google_body_format",
      message:
        "Google/Gemini expects the native request format: a non-empty 'contents' array " +
        "(plus optional 'generationConfig', 'systemInstruction', 'tools'). " +
        "The proxy forwards request bodies unchanged and does not translate 'messages'.",
    };
  }
  return { ok: true };
}
