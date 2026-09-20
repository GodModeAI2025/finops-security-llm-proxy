#EXPERIMENTAL STATUS

# LLM API Proxy — Gesamtprojekt

Ein selbstlernendes API-Gateway, das die echten API-Keys von LLM-Providern (Anthropic, OpenAI, Google) kapselt, eigene Proxy-Tokens vergibt und diese automatisch auf Basis von Budget, Laufzeit und Fehlerquote revoziert. Das System lernt aus jeder Session, welche Ressourcen ein Themenfeld tatsächlich benötigt, und optimiert die Limits über Zeit.

## Projektstruktur

```
llm-proxy-complete/
│
├── docs/                              Dokumentation
│   ├── architektur.md                 Komplettes Architektur-Dokument
│   ├── architektur-diagram.png        GCP-Architekturdiagramm (2400×3000px)
│   └── adaptive-token-konzept.md      Konzept: Selbstlernende Budgets
│
├── diagrams/                          Mermaid-Diagramme
│   ├── 01-gcp-cloud-run.mermaid       GCP Cloud Run Architektur
│   ├── 02-cloudflare-workers.mermaid  Cloudflare Workers Architektur
│   ├── 03-aws-lambda.mermaid          AWS Lambda Architektur
│   ├── 04-gesamtsystem.mermaid        Zusammenspiel aller Komponenten
│   └── 05-session-lifecycle.mermaid   Sequenzdiagramm Session-Ablauf
│
├── backends/                          Drei Plattform-Implementierungen
│   ├── gcp-cloud-run/                 Google Cloud Run + Firestore
│   │   ├── src/
│   │   │   ├── index.ts               Express-Server + Routing
│   │   │   ├── types.ts               TypeScript-Interfaces
│   │   │   ├── routes/
│   │   │   │   ├── proxy.ts           POST /v1/chat — Proxy-Logik
│   │   │   │   ├── admin.ts           /admin/* — Token-CRUD, Usage
│   │   │   │   └── session.ts         /v1/session — Adaptive Sessions
│   │   │   ├── services/
│   │   │   │   ├── topic-profiler.ts  P90-Berechnung, Stats, Historie
│   │   │   │   ├── request-guards.ts  max_tokens-Limit + Agent-Loop-Breaker
│   │   │   │   ├── stream-usage.ts    Usage-Erfassung aus SSE-Streams
│   │   │   │   └── provider-request.ts Ziel-URL + Forward-Body je Provider
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts            Proxy + Admin Authentifizierung
│   │   │   │   └── rate-limiter.ts    In-Memory Rate Limiter
│   │   │   ├── utils/
│   │   │   │   ├── firestore.ts       Firestore CRUD + Transactions
│   │   │   │   └── secrets.ts         Secret Manager Client
│   │   │   └── providers/
│   │   │       └── index.ts           Anthropic/OpenAI/Google Adapter
│   │   ├── Dockerfile                 Multi-stage Build
│   │   ├── deploy.sh                  One-Click GCP Deploy
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── cloudflare-workers/            Cloudflare Workers + KV + DO
│   │   ├── src/
│   │   │   ├── index.ts               Worker Entry + Cron Handler
│   │   │   ├── types.ts               Env Bindings + Interfaces
│   │   │   ├── providers.ts           Provider-Adapter + Pricing
│   │   │   ├── usage-counter.ts       Durable Object (atomare Zähler)
│   │   │   ├── topic-profiler.ts      Adaptive Limits + Stats (KV)
│   │   │   ├── request-guards.ts      max_tokens-Limit + Agent-Loop-Breaker
│   │   │   ├── stream-usage.ts        Usage-Erfassung aus SSE-Streams
│   │   │   ├── provider-request.ts    Ziel-URL + Forward-Body je Provider
│   │   │   └── handlers/
│   │   │       ├── proxy.ts           Proxy mit TransformStream
│   │   │       ├── admin.ts           Admin-API
│   │   │       └── session.ts         Session + Topic-Management
│   │   ├── wrangler.toml              Cloudflare Konfiguration
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── aws-lambda/                    AWS Lambda + DynamoDB + CDK
│       ├── src/
│       │   ├── types.ts               DynamoDB Items + API Types
│       │   ├── handlers/
│       │   │   └── index.ts           Alle Routen in einem Handler
│       │   ├── services/
│       │   │   ├── topic-profiler.ts  Adaptive Limits (DynamoDB)
│       │   │   ├── request-guards.ts  max_tokens-Limit + Agent-Loop-Breaker
│       │   │   └── provider-request.ts Ziel-URL + Forward-Body je Provider
│       │   ├── providers/
│       │   │   └── index.ts           Provider-Adapter + Pricing
│       │   └── utils/
│       │       ├── dynamodb.ts        Single-Table CRUD + Atomics
│       │       └── secrets.ts         AWS Secrets Manager Client
│       ├── cdk-stack.ts               CDK Infrastructure-as-Code
│       ├── package.json
│       └── tsconfig.json
│
└── client/                            PoC Test-Client
    └── electron-app/
        ├── src/
        │   ├── main.js                Electron Main Process
        │   └── renderer.html          Komplette UI (923 Zeilen)
        ├── package.json
        └── README.md
```

## Features

- Proxy-Tokens mit automatischer Revocation (Budget, TTL, Fehlerquote)
- Selbstlernende Budgets via P90 + 10% Sicherheitsmarge
- Vollständige Kostenanalyse pro Themenfeld (Min/Max/Ø/Median/P90)
- Server-seitige TTL-Durchsetzung bei jedem Request + proaktiver Cron-Cleanup
- Schutz vor unbegrenztem Verbrauch: `max_tokens_per_request` wird pro Request durchgesetzt, ein Agent-Loop-Breaker blockt identische Wiederholungs-Requests (429 `agent_loop_detected`)
- Streaming-Support (GCP + Cloudflare) — die Usage wird dabei über Chunk-Grenzen hinweg aus dem SSE-Stream gelesen, damit Budget und Auto-Revocation auch bei Streams greifen
- Google/Gemini-Routing: Modell wird in den Pfad eingesetzt, Streams gehen an `:streamGenerateContent?alt=sse`, Proxy-Felder (`model`, `stream`) werden aus dem Body entfernt. Requests im falschen Format werden mit 400 `google_body_format` abgelehnt, statt beim Provider zu scheitern
- Einheitliche API-Oberfläche über alle drei Backends
- Electron PoC-Client zum Testen aller Funktionen

## Quickstart

### 1. Backend deployen (z.B. GCP)

```bash
cd backends/gcp-cloud-run
npm install
chmod +x deploy.sh
./deploy.sh
```

### 2. Electron Client starten

```bash
cd client/electron-app
npm install
npm start
```

### 3. Testen

1. Proxy-URL und Admin-Key im Client eingeben
2. Themenfeld eingeben (z.B. "code-review")
3. Chat starten — Timer und Budget werden live angezeigt
4. Session beenden → Messpunkt wird gespeichert
5. Nächste Session → Limits werden adaptiv angepasst

## Plattformvergleich

| | GCP Cloud Run | Cloudflare Workers | AWS Lambda |
|---|---|---|---|
| Code | 1.734 Zeilen | 1.293 Zeilen | 1.065 Zeilen |
| Datenbank | Firestore | KV + Durable Objects | DynamoDB |
| Atomare Zähler | Firestore Transactions | Durable Objects | UpdateExpression |
| Secrets | Secret Manager | Wrangler Secrets | Secrets Manager |
| Cron | Cloud Scheduler | Cron Triggers | EventBridge |
| Deploy | deploy.sh | wrangler deploy | cdk deploy |
| Streaming | Ja | Ja (TransformStream) | Nein (API GW Limit) |
| Cold Start | ~200ms (min=1 eliminiert) | 0ms | ~300-800ms |
| Kosten/Monat | ~$16-20 | ~$5-10 | ~$5-15 |
