# LLM Proxy — AWS Lambda

## Setup

```bash
# 1. Dependencies
npm install

# 2. Secrets in AWS Secrets Manager anlegen
aws secretsmanager create-secret --name llm-proxy/anthropic-key --secret-string "sk-ant-..."
aws secretsmanager create-secret --name llm-proxy/openai-key --secret-string "sk-proj-..."
aws secretsmanager create-secret --name llm-proxy/admin-key --secret-string "dein-admin-key"

# 3. Deploy via CDK
npx cdk bootstrap   # nur beim ersten Mal
npx cdk deploy

# 4. Testen
curl https://<api-id>.execute-api.eu-central-1.amazonaws.com/health
```

## Token erstellen

```bash
curl -X POST https://<api-url>/admin/tokens \
  -H "Authorization: Bearer <ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-bot",
    "owner": "team-alpha",
    "rules": { "max_budget_usd": 10 }
  }'
```

## Request über Proxy

```bash
curl -X POST https://<api-url>/v1/chat \
  -H "Authorization: Bearer ptk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Hinweis: Streaming

API Gateway v2 unterstützt kein Response-Streaming. Der Proxy erzwingt `stream: false`.
Für Streaming: Lambda Function URLs mit Response Streaming nutzen (separates Setup).

## Kosten

- Lambda: 1M Requests/Mo free, dann $0.20/1M
- DynamoDB: 25 GB free, On-Demand $1.25/1M Writes
- Secrets Manager: $0.40/Secret/Mo
- API Gateway: 1M Requests/Mo free, dann $1/1M
- EventBridge: free
