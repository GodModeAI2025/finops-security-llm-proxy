# LLM Proxy Client — Electron PoC

Testanwendung für den LLM API Proxy. Verbindet sich mit jedem der drei Backend-Varianten (GCP, Cloudflare, AWS Lambda) und testet den vollständigen Session-Lifecycle.

## Setup

```bash
npm install
npm start
```

## Ablauf

1. **Konfigurieren** — Backend-Typ wählen, Proxy-URL und Admin-Key eingeben, Verbindung testen.
2. **Session starten** — Themenfeld eingeben. Das System berechnet automatisch Zeit-/Budgetlimits.
3. **Chatten** — Prompts senden. Timer und Budget werden live angezeigt. Bei TTL-Ablauf oder Budget-Überschreitung wird der Request serverseitig abgelehnt.
4. **Session beenden** — "Bist du fertig?" → Erfolg oder Misserfolg melden. Der Messpunkt fließt in die adaptive Limitberechnung ein.
5. **Stats** — Alle Themenfelder mit Min/Max/Durchschnitt/Median/P90 ansehen.

## Was getestet wird

- Token-Erstellung über `/v1/session`
- Adaptive Limits (P90-Berechnung, Sicherheitsmarge, Deckelung bei 50)
- Proxy-Forwarding über `/v1/chat` mit echtem LLM-Request
- TTL-Enforcement: Timer zeigt Countdown, nach Ablauf werden Requests mit 403 abgelehnt
- Budget-Enforcement: Kosten werden live aus `X-Proxy-Usage` Header gelesen
- Session-Completion mit Messpunkt-Recording
- Statistik-Dashboard über `/admin/topics`
- Fehlerbehandlung (Rate-Limit, Revocation, Netzwerkfehler)

## TTL-Validierung im Detail

Der Client zeigt einen Timer, aber die **echte Enforcement passiert serverseitig**:
- Jeder Request prüft `ttl_expires_at < now()` BEVOR er an den LLM-Provider geht
- Bei Ablauf: Token wird automatisch revoked, Client bekommt 403
- Zusätzlich: Cron-Job alle 5 Min räumt abgelaufene Tokens proaktiv auf
- Auch wenn der Client sich nie wieder meldet → Token ist nach TTL tot
