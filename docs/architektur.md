# LLM API Proxy — Architektur

## Überblick

Der LLM API Proxy kapselt die echten API-Keys von LLM-Providern (Anthropic, OpenAI, Google AI, etc.) und vergibt stattdessen eigene Proxy-Tokens. Diese können jederzeit widerrufen werden — manuell oder automatisch basierend auf Regeln wie Budget, Laufzeit oder Fehlerquote.

## Designziele

- **Einfachheit**: Ein einziger Cloud Run Service, ein Firestore, ein Secret Manager. Kein Redis, kein Pub/Sub, kein API Gateway.
- **Skalierbarkeit**: Cloud Run skaliert automatisch von 0 auf tausende parallele Requests.
- **Erweiterbarkeit**: Neue LLM-Provider werden über eine Konfigurationsdatei hinzugefügt — kein Code-Umbau nötig.
- **Transparenz**: Jeder Token hat vollständige Usage-Daten, auch nach Revocation abrufbar.

## GCP-Komponenten

### Cloud Run — LLM Proxy Service

Einziger Compute-Service. TypeScript/Node.js Container mit zwei Endpunkt-Gruppen:

| Route | Funktion |
|---|---|
| `POST /v1/chat` | Proxy-Endpoint — nimmt Requests mit Proxy-Token entgegen, leitet an LLM-Provider weiter |
| `POST /admin/tokens` | Token erstellen |
| `GET /admin/tokens/{id}` | Token-Details + Usage abrufen |
| `PATCH /admin/tokens/{id}` | Token-Regeln ändern |
| `DELETE /admin/tokens/{id}` | Token löschen |
| `POST /admin/revoke/{id}` | Sofort-Revocation |
| `POST /admin/reactivate/{id}` | Token reaktivieren |
| `POST /admin/feedback/{id}` | Erfolg/Misserfolg melden |
| `GET /admin/usage/{id}` | Live-Verbrauch abrufen |
| `GET /admin/usage/summary` | Aggregierte Statistiken |
| `GET /admin/tokens` | Alle Tokens listen (mit Filter) |
| `POST /admin/cleanup` | Abgelaufene Tokens revoken (für Cloud Scheduler) |

Konfiguration: `min-instances: 1` eliminiert Cold Starts (~$15/Monat).

### Firestore — Datenspeicher

Einzige Datenbank für Token-Metadaten und Usage-Tracking.

#### Collection: `tokens/{id}`

```json
{
  "id": "ptk_a8f3x9k2m7",
  "name": "Agent-Bot-Prod",
  "owner": "team-alpha",
  "status": "active | revoked",
  "revoke_reason": null,
  "created_at": "2026-03-20T10:00:00Z",
  "revoked_at": null,
  "rules": {
    "ttl_expires_at": "2026-04-20T10:00:00Z",
    "max_budget_usd": 50.00,
    "max_requests_per_min": 60,
    "max_tokens_per_request": 4096,
    "max_fail_streak": 10
  },
  "scope": {
    "allowed_providers": ["anthropic", "openai"],
    "allowed_models": ["claude-sonnet-4-20250514", "gpt-4o"],
    "provider_key_ref": "default"
  }
}
```

#### Subcollection: `tokens/{id}/usage/current`

```json
{
  "total_requests": 1284,
  "successful_requests": 1271,
  "failed_requests": 13,
  "total_input_tokens": 2840000,
  "total_output_tokens": 890000,
  "total_cost_usd": 50.02,
  "fail_streak": 0,
  "last_request_at": "2026-03-28T14:31:58Z",
  "by_provider": {
    "anthropic": { "requests": 900, "cost_usd": 38.10 },
    "openai": { "requests": 384, "cost_usd": 11.92 }
  }
}
```

#### Document: `config/pricing`

```json
{
  "claude-sonnet-4-20250514": { "input_per_1m": 3.0, "output_per_1m": 15.0 },
  "gpt-4o": { "input_per_1m": 2.5, "output_per_1m": 10.0 },
  "gemini-2.0-flash": { "input_per_1m": 0.10, "output_per_1m": 0.40 }
}
```

### Secret Manager — API-Keys

Echte Provider-Keys werden isoliert gespeichert und zur Laufzeit gelesen.

| Secret Name | Inhalt |
|---|---|
| `llm-proxy-anthropic-key` | `sk-ant-api03-...` |
| `llm-proxy-openai-key` | `sk-proj-...` |
| `llm-proxy-admin-key` | Admin-Bearer-Token für /admin/* |

### Cloud Scheduler — TTL Cleanup (optional)

Cronjob alle 5 Minuten: `POST /admin/cleanup` an den Cloud Run Service. Revoked alle Tokens mit abgelaufenem TTL. Nicht zwingend nötig — der Lazy Check bei jedem Request reicht funktional.

## Request-Flow

1. **Client sendet Request** — `POST /v1/chat` mit `Authorization: Bearer ptk_...`
2. **Token validieren** — Firestore Read: existiert der Token, ist `status == "active"`?
3. **Regeln prüfen** — TTL abgelaufen? Budget überschritten? Rate-Limit erreicht? → 403/429
4. **Provider auflösen** — Ist der angefragte Provider/Modell erlaubt? Echten API-Key aus Secret Manager laden.
   Vorher greifen die Request-Guards: Output-Limit über `max_tokens_per_request` (400) und Agent-Loop-Breaker (429).
5. **Request weiterleiten** — Header umschreiben (`Bearer ptk_...` → `Bearer sk-ant-...`), Body 1:1 durchreichen. Streaming wird transparent durchgereicht. Ziel-URL und Forward-Body baut `provider-request.ts` (siehe „Provider-Besonderheiten").
6. **Response evaluieren** — HTTP 200 → `fail_streak = 0`. HTTP 4xx/5xx oder leere Antwort → `fail_streak++`.
7. **Usage tracken** — Firestore Transaction: `total_requests++`, `total_cost_usd += berechnete_kosten`. Prüfen ob Auto-Revoke-Regeln greifen.
8. **Response zurück** — Original LLM-Response an Client, optional mit `X-Proxy-Usage` Header.

## Provider-Besonderheiten

Der Proxy übersetzt Request-Bodys nicht — jeder Client spricht das Format seines Providers. Bei der Ziel-URL und beim Forward-Body laufen die Provider trotzdem auseinander; sie liegen gebündelt in `provider-request.ts` (in allen drei Backends identisch).

| Provider | Pfad | Body |
|---|---|---|
| Anthropic | `/v1/messages`, fest | unverändert |
| OpenAI | `/v1/chat/completions`, fest | bei `stream: true` wird `stream_options.include_usage` gesetzt, damit die Usage im letzten Chunk mitkommt |
| Google | `/v1beta/models/{model}:generateContent` — `{model}` wird durch das angefragte Modell ersetzt (URL-kodiert); bei `stream: true` stattdessen `:streamGenerateContent?alt=sse` | `model` und `stream`/`stream_options` werden entfernt |

Zu Google im Einzelnen:

- **Das Modell steht im Pfad.** Bleibt der Platzhalter stehen, antwortet Google mit `404 models/%7Bmodel%7D is not found`.
- **Gemini kennt die Proxy-Felder nicht.** Das Modell gehört in den Pfad, `stream` in die Methode; beide im Body würden mit `400 INVALID_ARGUMENT — Invalid JSON payload received. Unknown name "model"` abgelehnt. Sie werden deshalb vor dem Weiterleiten entfernt.
- **`:generateContent` streamt nicht.** Es liefert die komplette Antwort am Stück, also keine SSE-Events und damit auch keine `usageMetadata` für die Stream-Erfassung. Gestreamte Requests gehen an `:streamGenerateContent?alt=sse`.
- **Das Request-Format ist ein anderes.** Google erwartet `contents` (plus optional `generationConfig`, `systemInstruction`, `tools`) statt `messages`. Ein Request an ein `gemini-*`-Modell ohne nicht-leeres `contents` wird direkt mit `400 google_body_format` abgelehnt, bevor ein Provider-Call entsteht — sonst würde der Provider-Fehler als fehlgeschlagener Request verbucht und im Streaming-Pfad sogar mit geschätzten Input-Tokens bepreist, obwohl das Modell nie erreicht wurde.

Der Electron-PoC-Client schickt ausschließlich OpenAI-förmige Bodys (`messages`) und kann Gemini-Modelle deshalb nicht bedienen; er zeigt die Meldung des Proxys an.

## Kostenberechnung

Token-Counts kommen exakt vom Provider in jeder Response (`usage.input_tokens`, `usage.output_tokens`). Die Kosten werden mit der Preistabelle aus `config/pricing` berechnet:

```
kosten = (input_tokens × input_per_1m + output_tokens × output_per_1m) / 1.000.000
```

Genauigkeit: 95-100%. Einzige Fehlerquelle ist eine veraltete Preistabelle.

Bei Streaming stehen die Zahlen in den SSE-Events des Providers. `services/stream-usage.ts` (GCP) bzw. `stream-usage.ts` (Workers) puffert den Stream zeilenweise und sammelt sie ein:

| Provider | Input-Tokens | Output-Tokens |
|---|---|---|
| Anthropic | `message_start` → `message.usage.input_tokens` | `message_delta` → `usage.output_tokens` |
| OpenAI | letzter Chunk mit `usage` (nur mit `stream_options.include_usage`, wird vom Proxy gesetzt) | dito, `completion_tokens` |
| Google | Chunk mit `usageMetadata.promptTokenCount` | `usageMetadata.candidatesTokenCount` |

Zwei Punkte sind dabei wichtig:

- Eine SSE-Zeile kann über zwei Netzwerk-Chunks verteilt ankommen. Wer je Chunk parst, verliert die Usage des gesamten Streams und bucht 0 Kosten. Deshalb wird über Chunk-Grenzen hinweg gepuffert und erst bei `\n` ausgewertet.
- Anthropic verteilt Input- und Output-Tokens auf zwei verschiedene Events. Wer nur `message_delta` liest, bucht die Input-Tokens mit 0.

Bricht der Stream vorzeitig ab und fehlen die Input-Tokens, wird wie bisher konservativ geschätzt (~4 Zeichen pro Token). Trennt der Client die Verbindung, wird der bis dahin erfasste Verbrauch trotzdem gebucht — der Provider stellt ihn ebenfalls in Rechnung. Cache-Tokens (`cache_read_input_tokens`, `cache_creation_input_tokens`) werden — wie im Nicht-Stream-Pfad — nicht separat bepreist.

## Auto-Revocation-Regeln

Nach jedem Request prüft der Proxy:

| Regel | Bedingung | Aktion |
|---|---|---|
| Budget | `total_cost_usd >= max_budget_usd` | Revoke mit Grund `budget_exceeded` |
| TTL | `now() >= ttl_expires_at` | Revoke mit Grund `ttl_expired` |
| Fehlerquote | `fail_streak >= max_fail_streak` | Revoke mit Grund `fail_streak_exceeded` |
| Rate-Limit | Requests/Min > `max_requests_per_min` | Request ablehnen (429), kein Revoke |
| Output-Limit | Angefragte Output-Tokens > `max_tokens_per_request` | Request ablehnen (400 `max_tokens_exceeded`), kein Revoke. Fehlt die Angabe im Request, setzt der Proxy das Limit (`max_tokens` / `max_completion_tokens` / `generationConfig.maxOutputTokens`) |
| Body-Format | Google-Request ohne `contents` | Request ablehnen (400 `google_body_format`), kein Revoke, nicht an den Provider weitergeleitet |
| Agent-Loop | Mehr als 5 identische Request-Bodies (ohne `stream`-Felder) pro Token innerhalb von 120 s (konfigurierbar) | Request ablehnen (429 `agent_loop_detected`, mit `retry_after_seconds`), kein Revoke, nicht an den Provider weitergeleitet |

Der Loop-Breaker adressiert hängende Agenten, die denselben Prompt endlos wiederholen (OWASP LLM "Unbounded Consumption").

- **Konfiguration:** `AGENT_LOOP_MAX_IDENTICAL` (Default `5`, `0` = aus) und `AGENT_LOOP_WINDOW_SECONDS` (Default `120`) als Umgebungsvariable (Cloud Run, Lambda) bzw. `[vars]` in `wrangler.toml` (Workers).
- **Legitime Wiederholungen:** Auch korrekte Clients senden denselben Body mehrfach, z. B. SDK-Retries nach Netzwerkfehlern oder Best-of-N-Sampling mit Temperatur > 0 (Anthropic kennt kein `n`, also N identische Requests). Jeder Versuch zählt, auch wenn der Provider-Call scheiterte. Wer mehr als 5 identische Requests in 120 s braucht, erhöht die Schwelle oder schaltet den Breaker ab.
- **Zustand ist best effort:** Die Zähler liegen wie beim Rate-Limiter im Speicher der Instanz bzw. des Isolates. Bei mehreren Cloud-Run-/Lambda-Instanzen oder Workers-Isolates zählt jede für sich, nach Kaltstart beginnt der Zähler bei null. Ein Loop kann deshalb später oder gar nicht erkannt werden; die harte Kostengrenze bleibt das Budget pro Token.

## Session-Auswertung (Post-Mortem)

Usage-Daten bleiben vollständig erhalten, auch nach Revocation oder Fehler-Terminierung. Über `GET /admin/usage/{id}` abrufbar:

- Gesamtlaufzeit (created_at → revoked_at/last_request_at)
- Kosten gesamt und pro Provider
- Erfolgs-/Fehlerquote
- Revocation-Grund und -Zeitpunkt

## Provider-Erweiterung

Neuen Provider hinzufügen:

1. Adapter-Config in `src/providers/` anlegen (URL, Header-Format, Usage-Parsing)
2. Preis in `config/pricing` Firestore-Dokument eintragen
3. Echten API-Key in Secret Manager speichern
4. Deploy — fertig

## Sicherheit

- Proxy-Tokens beginnen mit `ptk_` Präfix — sofort unterscheidbar von echten API-Keys
- Admin-Endpoints sind mit separatem Admin-Key geschützt
- Echte API-Keys werden nie geloggt, nie in Responses exponiert, nie in Firestore gespeichert
- HTTPS erzwungen (Cloud Run default)
- Rate-Limiting pro Token eingebaut
- Output-Limit pro Request und Agent-Loop-Breaker gegen unkontrollierten Verbrauch
- Admin-Key-Vergleich zeitkonstant (SHA-256 + `timingSafeEqual`), leerer Admin-Key wird nie akzeptiert

## Infrastrukturkosten (geschätzt)

| Komponente | Kosten/Monat |
|---|---|
| Cloud Run (min 1 instance) | ~$15 |
| Firestore (Reads/Writes) | ~$1-5 (bei normaler Nutzung) |
| Secret Manager | ~$0.10 |
| Cloud Scheduler | ~$0.10 |
| **Gesamt** | **~$16-20/Monat** |

Die LLM-API-Kosten selbst dominieren — die Infrastruktur ist vernachlässigbar.
