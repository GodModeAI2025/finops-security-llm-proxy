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
5. **Request weiterleiten** — Header umschreiben (`Bearer ptk_...` → `Bearer sk-ant-...`), Body 1:1 durchreichen. Streaming wird transparent durchgereicht.
6. **Response evaluieren** — HTTP 200 → `fail_streak = 0`. HTTP 4xx/5xx oder leere Antwort → `fail_streak++`.
7. **Usage tracken** — Firestore Transaction: `total_requests++`, `total_cost_usd += berechnete_kosten`. Prüfen ob Auto-Revoke-Regeln greifen.
8. **Response zurück** — Original LLM-Response an Client, optional mit `X-Proxy-Usage` Header.

## Kostenberechnung

Token-Counts kommen exakt vom Provider in jeder Response (`usage.input_tokens`, `usage.output_tokens`). Die Kosten werden mit der Preistabelle aus `config/pricing` berechnet:

```
kosten = (input_tokens × input_per_1m + output_tokens × output_per_1m) / 1.000.000
```

Genauigkeit: 95-100%. Einzige Fehlerquelle ist eine veraltete Preistabelle.

Bei Streaming liefern beide Provider die Usage-Daten im letzten Event. Bei Stream-Abbruch wird eine konservative Schätzung als Reservierung verbucht.

## Auto-Revocation-Regeln

Nach jedem Request prüft der Proxy:

| Regel | Bedingung | Aktion |
|---|---|---|
| Budget | `total_cost_usd >= max_budget_usd` | Revoke mit Grund `budget_exceeded` |
| TTL | `now() >= ttl_expires_at` | Revoke mit Grund `ttl_expired` |
| Fehlerquote | `fail_streak >= max_fail_streak` | Revoke mit Grund `fail_streak_exceeded` |
| Rate-Limit | Requests/Min > `max_requests_per_min` | Request ablehnen (429), kein Revoke |

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

## Infrastrukturkosten (geschätzt)

| Komponente | Kosten/Monat |
|---|---|
| Cloud Run (min 1 instance) | ~$15 |
| Firestore (Reads/Writes) | ~$1-5 (bei normaler Nutzung) |
| Secret Manager | ~$0.10 |
| Cloud Scheduler | ~$0.10 |
| **Gesamt** | **~$16-20/Monat** |

Die LLM-API-Kosten selbst dominieren — die Infrastruktur ist vernachlässigbar.
