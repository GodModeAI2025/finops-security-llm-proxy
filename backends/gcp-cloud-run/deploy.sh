#!/bin/bash
set -euo pipefail

# ============================================================
# LLM Proxy — GCP Deployment Script
# ============================================================
# Voraussetzungen:
#   - gcloud CLI installiert und authentifiziert
#   - GCP Projekt ausgewählt (gcloud config set project PROJECT_ID)
#   - APIs aktiviert: Cloud Run, Firestore, Secret Manager, Cloud Scheduler
# ============================================================

PROJECT_ID=$(gcloud config get-value project)
REGION="${REGION:-europe-west1}"
SERVICE_NAME="llm-proxy"

echo "=== LLM Proxy Deployment ==="
echo "Project:  $PROJECT_ID"
echo "Region:   $REGION"
echo "Service:  $SERVICE_NAME"
echo ""

# ── 1. APIs aktivieren ──────────────────────────────────────
echo ">>> Aktiviere APIs..."
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com

# ── 2. Firestore initialisieren (Native Mode) ──────────────
echo ">>> Firestore prüfen..."
gcloud firestore databases describe --database="(default)" 2>/dev/null || \
  gcloud firestore databases create --location="$REGION" --type=firestore-native

# ── 3. Secrets erstellen (falls nicht vorhanden) ────────────
echo ">>> Secrets erstellen..."
create_secret_if_missing() {
  local name=$1
  local prompt=$2
  if ! gcloud secrets describe "$name" &>/dev/null; then
    echo "  Secret '$name' nicht gefunden."
    read -sp "  $prompt: " value
    echo ""
    echo -n "$value" | gcloud secrets create "$name" --data-file=-
    echo "  ✓ Secret '$name' erstellt."
  else
    echo "  ✓ Secret '$name' existiert bereits."
  fi
}

create_secret_if_missing "llm-proxy-anthropic-key" "Anthropic API Key eingeben"
create_secret_if_missing "llm-proxy-openai-key" "OpenAI API Key eingeben"
create_secret_if_missing "llm-proxy-admin-key" "Admin Key für /admin/* eingeben (beliebiger String)"

# ── 4. Build & Deploy auf Cloud Run ─────────────────────────
echo ">>> Build & Deploy..."
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 10 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 300 \
  --set-env-vars "GCP_PROJECT_ID=$PROJECT_ID,NODE_ENV=production"

# ── 5. Service URL abrufen ──────────────────────────────────
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --format="value(status.url)")

echo ""
echo ">>> Service deployed: $SERVICE_URL"

# ── 6. IAM Berechtigungen für Secrets ───────────────────────
echo ">>> IAM Berechtigungen setzen..."
SA_EMAIL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --format="value(spec.template.spec.serviceAccountName)")

if [ -z "$SA_EMAIL" ]; then
  SA_EMAIL="${PROJECT_ID}@appspot.gserviceaccount.com"
fi

for secret in llm-proxy-anthropic-key llm-proxy-openai-key llm-proxy-admin-key; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet
done

# ── 7. Cloud Scheduler einrichten ───────────────────────────
echo ">>> Cloud Scheduler einrichten..."
ADMIN_KEY=$(gcloud secrets versions access latest --secret="llm-proxy-admin-key")

gcloud scheduler jobs create http llm-proxy-cleanup \
  --location="$REGION" \
  --schedule="*/5 * * * *" \
  --uri="${SERVICE_URL}/admin/cleanup" \
  --http-method=POST \
  --headers="Authorization=Bearer ${ADMIN_KEY},Content-Type=application/json" \
  --attempt-deadline=30s \
  2>/dev/null || \
  gcloud scheduler jobs update http llm-proxy-cleanup \
    --location="$REGION" \
    --schedule="*/5 * * * *" \
    --uri="${SERVICE_URL}/admin/cleanup" \
    --http-method=POST \
    --headers="Authorization=Bearer ${ADMIN_KEY},Content-Type=application/json" \
    --attempt-deadline=30s

# ── 8. Firestore Pricing Config anlegen ─────────────────────
echo ">>> Pricing Config anlegen..."
cat > /tmp/pricing.json << 'EOF'
{
  "claude-sonnet-4-20250514": { "input_per_1m": 3.0, "output_per_1m": 15.0 },
  "claude-opus-4-20250514": { "input_per_1m": 15.0, "output_per_1m": 75.0 },
  "claude-haiku-4-5-20251001": { "input_per_1m": 0.8, "output_per_1m": 4.0 },
  "gpt-4o": { "input_per_1m": 2.5, "output_per_1m": 10.0 },
  "gpt-4o-mini": { "input_per_1m": 0.15, "output_per_1m": 0.6 },
  "gemini-2.0-flash": { "input_per_1m": 0.1, "output_per_1m": 0.4 }
}
EOF

# Firestore config/pricing Dokument erstellen
# (Manuell über die Console oder Firebase CLI)
echo "  HINWEIS: Pricing-Config muss manuell in Firestore angelegt werden."
echo "  Collection: config, Document: pricing"
echo "  Inhalt: siehe /tmp/pricing.json"

# ── Fertig ──────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  Deployment abgeschlossen!"
echo "============================================"
echo ""
echo "  Service URL:  $SERVICE_URL"
echo ""
echo "  Proxy:        POST $SERVICE_URL/v1/chat"
echo "  Admin:        $SERVICE_URL/admin/*"
echo "  Health:       GET  $SERVICE_URL/health"
echo ""
echo "  Nächster Schritt:"
echo "  Token erstellen:"
echo "    curl -X POST $SERVICE_URL/admin/tokens \\"
echo "      -H 'Authorization: Bearer <ADMIN_KEY>' \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"name\": \"test\", \"owner\": \"me\", \"rules\": {\"max_budget_usd\": 10}}'"
echo ""
