# LLM Proxy — Cloudflare Workers

## Setup

```bash
# 1. Dependencies
npm install

# 2. KV Namespace erstellen
wrangler kv:namespace create TOKENS
# → ID aus Output in wrangler.toml eintragen

# 3. Secrets setzen
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put ADMIN_KEY

# 4. Deploy
wrangler deploy

# 5. Testen
curl https://llm-proxy.<account>.workers.dev/health
```

## Token erstellen

```bash
curl -X POST https://llm-proxy.<account>.workers.dev/admin/tokens \
  -H "Authorization: Bearer <ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-bot",
    "owner": "team-alpha",
    "rules": { "max_budget_usd": 10, "ttl_expires_at": "2026-05-01T00:00:00Z" }
  }'
```

## Request über Proxy

```bash
curl -X POST https://llm-proxy.<account>.workers.dev/v1/chat \
  -H "Authorization: Bearer ptk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Kosten

- Workers Free: 100k Requests/Tag
- Workers Paid ($5/Mo): 10M Requests/Mo
- KV: 100k Reads/Tag free, dann $0.50/1M
- Durable Objects: $0.15/1M Requests
