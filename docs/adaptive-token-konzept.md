# Adaptive Token-Provisionierung — Konzept

## 1. Problemstellung

Aktuell muss ein Administrator beim Erstellen eines Proxy-Tokens manuell Budget (USD) und Laufzeit (Minuten) festlegen. Das erfordert Vorwissen über den Use Case und führt entweder zu überdimensionierten Limits (Kostenverschwendung) oder zu vorzeitigen Abbrüchen (Limit zu knapp).

## 2. Zielbild

Der Client meldet sich beim System mit nur zwei Parametern:

```
POST /v1/session
{
  "topic": "kundensupport-zusammenfassung",
  "model": "claude-sonnet-4-20250514"
}
```

Das System entscheidet autonom über Zeit- und Budgetgrenzen:

- **Bekanntes Themenfeld:** Limits werden aus historischen Messwerten abgeleitet — optimiert, aber nie höher als 50 Minuten / 50 €.
- **Unbekanntes Themenfeld:** Konservative Defaults greifen — 50 Minuten, 50 €.

Die Session läuft, bis einer von drei Fällen eintritt:

1. **Client beendet aktiv** — ruft `POST /v1/session/{id}/complete` mit Erfolgs-/Misserfolgsmeldung auf.
2. **Zeitlimit erreicht** — System revoked automatisch.
3. **Budgetlimit erreicht** — System revoked automatisch.

Nach jeder abgeschlossenen Session fließen die tatsächlich verbrauchten Werte (Zeit, Kosten) als Messpunkt in das Lernmodell für das jeweilige Themenfeld zurück.

## 3. Adaptiver Algorithmus

### 3.1 Datengrundlage

Für jedes Themenfeld speichert das System eine Historie abgeschlossener Sessions:

```
topic_history:{topic} → [
  { duration_min: 12.3, cost_usd: 4.20, success: true,  model: "claude-sonnet-4-..." },
  { duration_min: 8.7,  cost_usd: 2.90, success: true,  model: "claude-sonnet-4-..." },
  { duration_min: 45.0, cost_usd: 48.50, success: false, model: "claude-sonnet-4-..." },
  ...
]
```

### 3.2 Berechnung der Limits

Die Berechnung erfolgt in drei Stufen:

**Stufe 1 — Unbekanntes Thema (0 Messpunkte)**

Keine historischen Daten vorhanden. Das System setzt die Höchstwerte:

- Zeitlimit: 50 Minuten
- Budgetlimit: 50 €

**Stufe 2 — Wenige Messpunkte (1–4 abgeschlossene Sessions)**

Noch nicht genug Daten für statistische Sicherheit. Das System verwendet den Maximalwert der bisherigen erfolgreichen Sessions plus 10 % Sicherheitsmarge, gedeckelt auf 50:

```
limit = min( max(bisherige_werte) × 1.10,  50 )
```

**Stufe 3 — Ausreichend Messpunkte (≥ 5 abgeschlossene Sessions)**

Das System berechnet das 90. Perzentil (P90) der erfolgreichen Sessions. P90 bedeutet: 90 % aller bisherigen Sessions lagen unter diesem Wert. Darauf werden 10 % Sicherheitsmarge addiert:

```
limit = min( P90(erfolgreiche_werte) × 1.10,  50 )
```

### 3.3 Rechenbeispiel

Themenfeld "kundensupport-zusammenfassung" hat 8 erfolgreiche Sessions mit folgenden Kosten in USD:

```
Messwerte (sortiert): [1.20, 1.80, 2.10, 2.50, 3.00, 3.40, 4.80, 12.50]
```

Berechnung:

```
P90-Index    = ⌈8 × 0.90⌉ = 8  →  P90 = 4.80 USD
                (der Ausreißer 12.50 wird ignoriert)
Sicherheit   = 4.80 × 1.10 = 5.28 USD
Deckelung    = min(5.28, 50) = 5.28 USD
```

Das nächste Mal, wenn ein Client "kundensupport-zusammenfassung" anfragt, bekommt er automatisch ein Budgetlimit von 5.28 € statt 50 €. Gleiches Verfahren für die Zeitdimension.

### 3.4 Sonderregeln

- **Nur erfolgreiche Sessions fließen ein.** Fehlgeschlagene Sessions (Client meldet Misserfolg oder System-Timeout) werden zwar gespeichert, aber nicht für die Limit-Berechnung verwendet. Grund: Ein Timeout bei 50 Minuten sagt nichts über den tatsächlichen Bedarf aus.
- **Nie automatisch über 50.** Egal was die Datenlage sagt — das System setzt nie eigenständig mehr als 50 Minuten oder 50 € an. Höhere Limits erfordern einen manuellen Admin-Override.
- **Monoton fallend im Idealfall.** Wenn genügend Daten vorliegen, konvergieren die Limits nach unten. Das System wird mit jeder Session "sparsamer", solange die Use Cases konsistent bleiben.
- **Neue Muster werden erkannt.** Wenn ein Themenfeld plötzlich deutlich mehr Ressourcen braucht (z.B. weil der Prompt komplexer wurde), steigt P90 natürlich — aber nie über 50. Das ist die automatische Anpassung nach oben.
- **Modellspezifisch.** Die Historie wird pro Kombination aus Themenfeld + Modell geführt. "kundensupport-zusammenfassung" mit Sonnet hat andere Kosten als mit Opus.

## 4. Session-Lifecycle

### 4.1 Session eröffnen

```
POST /v1/session
{
  "topic": "kundensupport-zusammenfassung",
  "model": "claude-sonnet-4-20250514"
}
```

Response:

```json
{
  "session_id": "ses_x8k2m7a3f9",
  "token": "ptk_a8f3x9k2m7",
  "model": "claude-sonnet-4-20250514",
  "limits": {
    "max_duration_min": 5.8,
    "max_budget_usd": 5.28,
    "source": "adaptive_p90",
    "datapoints": 8,
    "safety_margin": 0.10
  },
  "expires_at": "2026-03-29T15:05:48Z"
}
```

Der Client erhält sofort seinen Proxy-Token und die berechneten Limits. Er sieht transparent, wie die Limits zustande kamen (Quelle, Datenbasis, Marge).

### 4.2 Requests senden

Der Client nutzt den Token wie bisher:

```
POST /v1/chat
Authorization: Bearer ptk_a8f3x9k2m7
{
  "model": "claude-sonnet-4-20250514",
  "messages": [...]
}
```

Beliebig viele Requests innerhalb einer Session, solange Zeit und Budget nicht aufgebraucht sind.

### 4.3 Session aktiv beenden

```
POST /v1/session/{session_id}/complete
Authorization: Bearer ptk_a8f3x9k2m7
{
  "success": true,
  "notes": "Zusammenfassung erstellt, 3 Tickets verarbeitet"
}
```

Bei Aufruf passiert:

1. Token wird revoked (keine weiteren Requests möglich).
2. Tatsächlicher Verbrauch (Zeit, Kosten) wird als Messpunkt in die Topic-Historie geschrieben.
3. Limits für das Themenfeld werden neu berechnet (für die nächste Session).

### 4.4 Automatische Terminierung

Wenn der Client sich nicht meldet, greift das bisherige Auto-Revoke:

- Zeitlimit überschritten → Revoke mit Grund `duration_exceeded`
- Budgetlimit überschritten → Revoke mit Grund `budget_exceeded`

Diese Sessions werden als "nicht aktiv beendet" markiert und fließen **nicht** in die adaptive Berechnung ein.

## 5. Datenmodell-Erweiterung

### 5.1 Neue Entität: Topic-Profil

Pro Kombination Themenfeld + Modell ein Dokument:

```json
{
  "topic": "kundensupport-zusammenfassung",
  "model": "claude-sonnet-4-20250514",
  "datapoints": 8,
  "current_limits": {
    "max_duration_min": 5.8,
    "max_budget_usd": 5.28
  },
  "history": [
    {
      "session_id": "ses_abc123",
      "duration_min": 4.2,
      "cost_usd": 2.10,
      "success": true,
      "completed_at": "2026-03-28T14:00:00Z"
    }
  ],
  "updated_at": "2026-03-28T14:00:00Z"
}
```

### 5.2 Speicherort pro Plattform

| Plattform | Speicher | Key / Pfad |
|---|---|---|
| GCP Cloud Run | Firestore | `topics/{topic}:{model}` |
| Cloudflare Workers | KV | `topic:{topic}:{model}` |
| AWS Lambda | DynamoDB | `pk: TOPIC#{topic}:{model}, sk: PROFILE` |

### 5.3 Session-Erweiterung am Token

Jeder Token bekommt zusätzliche Felder:

```json
{
  "session_id": "ses_x8k2m7a3f9",
  "topic": "kundensupport-zusammenfassung",
  "session_started_at": "2026-03-29T15:00:00Z",
  "limits_source": "adaptive_p90"
}
```

## 6. Implementierungsvorschlag

### 6.1 Neuer Endpunkt: Session-Management

Zwei neue Routen in allen drei Plattform-Varianten:

```
POST /v1/session              → Session eröffnen (Topic + Modell)
POST /v1/session/{id}/complete → Session aktiv beenden
```

### 6.2 Neue Komponente: Topic-Profiler

Ein Modul (`src/services/topic-profiler.ts`), das:

1. **Limits berechnet** — Nimmt Topic + Modell entgegen, liest die Historie, berechnet P90 + Marge.
2. **Messpunkte aufnimmt** — Nach jeder erfolgreichen Session-Beendigung wird der Datenpunkt gespeichert und die Limits neu kalkuliert.
3. **Deckelung erzwingt** — Kein berechneter Wert überschreitet jemals 50.

### 6.3 Kernlogik (Pseudocode)

```typescript
function calculateLimits(topic: string, model: string): Limits {
  const profile = loadProfile(topic, model);

  // Stufe 1: Unbekannt
  if (!profile || profile.datapoints === 0) {
    return { max_duration_min: 50, max_budget_usd: 50, source: "default" };
  }

  const successfulSessions = profile.history.filter(s => s.success);

  // Stufe 2: Wenige Daten
  if (successfulSessions.length < 5) {
    const maxDuration = Math.max(...successfulSessions.map(s => s.duration_min));
    const maxCost = Math.max(...successfulSessions.map(s => s.cost_usd));
    return {
      max_duration_min: Math.min(maxDuration * 1.10, 50),
      max_budget_usd:   Math.min(maxCost * 1.10, 50),
      source: "adaptive_max",
    };
  }

  // Stufe 3: P90
  const durations = successfulSessions.map(s => s.duration_min).sort((a, b) => a - b);
  const costs = successfulSessions.map(s => s.cost_usd).sort((a, b) => a - b);

  const p90Index = Math.ceil(durations.length * 0.90) - 1;
  const p90Duration = durations[p90Index];
  const p90Cost = costs[p90Index];

  return {
    max_duration_min: Math.min(p90Duration * 1.10, 50),
    max_budget_usd:   Math.min(p90Cost * 1.10, 50),
    source: "adaptive_p90",
  };
}
```

### 6.4 Änderungen am bestehenden Code

| Bereich | Änderung |
|---|---|
| Token-Erstellung | Wird jetzt indirekt über `/v1/session` ausgelöst, nicht mehr direkt über `/admin/tokens` |
| Token-Daten | Neue Felder: `session_id`, `topic`, `session_started_at` |
| Revoke-Logik | Bei aktivem Complete: Messpunkt speichern, Limits neu berechnen |
| Admin-API | Neuer Endpoint `GET /admin/topics` zum Einsehen aller Topic-Profile |
| Admin-API | Neuer Endpoint `PATCH /admin/topics/{topic}` für manuelle Limit-Overrides (über 50) |

### 6.5 Aufwand pro Plattform

| Plattform | Neue Dateien | Geänderte Dateien | Geschätzter Aufwand |
|---|---|---|---|
| GCP Cloud Run | `src/services/topic-profiler.ts`, `src/routes/session.ts` | `index.ts`, `firestore.ts` | ~200 Zeilen |
| Cloudflare Workers | `src/handlers/session.ts`, `src/topic-profiler.ts` | `index.ts`, `admin.ts` | ~180 Zeilen |
| AWS Lambda | `src/services/topic-profiler.ts`, `src/utils/dynamodb.ts` erweitern | `handlers/index.ts` | ~200 Zeilen |

## 7. Zusammenfassung

Das System lernt aus jeder abgeschlossenen Session, welche Ressourcen ein Themenfeld tatsächlich benötigt. Es wird mit der Zeit automatisch sparsamer, ohne dass ein Mensch eingreifen muss. Die Deckelung bei 50 verhindert, dass das System jemals unkontrolliert eskaliert. Der Client muss sich um nichts kümmern außer: "Was will ich tun, mit welchem Modell?"
