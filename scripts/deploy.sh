#!/usr/bin/env bash
# scripts/deploy.sh
#
# Builds a linux/amd64 production Docker image, pushes it to GCP Artifact
# Registry, and deploys it to Cloud Run.
#
# Usage:
#   ./scripts/deploy.sh
#   make deploy
#
# All variables below have defaults that target the production project. Override
# via environment variables to deploy to a different GCP project:
#
#   PROJECT=my-project REGION=us-central1 ./scripts/deploy.sh

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────

PROJECT="${PROJECT:-reversible-app}"
REGION="${REGION:-us-east4}"
REPOSITORY="${REPOSITORY:-gmail-organizer}"
SERVICE="${SERVICE:-gmail-organizer}"

REGISTRY="${REGION}-docker.pkg.dev/${PROJECT}/${REPOSITORY}/server"

# ── Tool detection ─────────────────────────────────────────────────────────────

# Find gcloud, checking PATH first, then common installation locations.
find_tool() {
  local name="$1"; shift
  if command -v "$name" &>/dev/null; then
    command -v "$name"
    return
  fi
  for candidate in "$@"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  echo ""
}

GCLOUD="$(find_tool gcloud \
  /opt/local/bin/gcloud \
  /usr/local/bin/gcloud \
  "$HOME/google-cloud-sdk/bin/gcloud" \
  "$HOME/.local/share/google-cloud-sdk/bin/gcloud")"

DOCKER="$(find_tool docker \
  /usr/local/bin/docker \
  /Applications/Docker.app/Contents/Resources/bin/docker)"

if [[ -z "$GCLOUD" ]]; then
  echo "error: gcloud not found. Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install" >&2
  exit 1
fi
if [[ -z "$DOCKER" ]]; then
  echo "error: docker not found. Install Docker Desktop: https://docs.docker.com/get-docker/" >&2
  exit 1
fi

# Find the gcloud SDK bin directory, which contains docker-credential-gcloud.
# This helper must be on PATH for 'docker push' to authenticate with Artifact Registry.
GCLOUD_SDK_BIN="$("$GCLOUD" info --format='value(installation.sdk_root)' 2>/dev/null)/bin"
if [[ ! -x "${GCLOUD_SDK_BIN}/docker-credential-gcloud" ]]; then
  # Fallback: the helper may live alongside the gcloud binary itself.
  GCLOUD_SDK_BIN="$(dirname "$GCLOUD")"
fi
export PATH="${GCLOUD_SDK_BIN}:${PATH}"

# ── Image tag ──────────────────────────────────────────────────────────────────

SHA="$(git rev-parse --short HEAD)"
FULL_IMAGE="${REGISTRY}:${SHA}"
LATEST_IMAGE="${REGISTRY}:latest"

# ── Build ──────────────────────────────────────────────────────────────────────

echo "==> Building ${FULL_IMAGE} (linux/amd64, production stage)..."
"$DOCKER" build \
  --platform linux/amd64 \
  --target production \
  -t "$FULL_IMAGE" \
  -t "$LATEST_IMAGE" \
  "$(cd "$(dirname "$0")/.." && pwd)"

# ── Auth ───────────────────────────────────────────────────────────────────────

echo "==> Authenticating Docker with Artifact Registry (${REGION}-docker.pkg.dev)..."
"$GCLOUD" auth configure-docker "${REGION}-docker.pkg.dev" --quiet
"$GCLOUD" auth print-access-token \
  | "$DOCKER" login -u oauth2accesstoken --password-stdin "https://${REGION}-docker.pkg.dev"

# ── Push ───────────────────────────────────────────────────────────────────────

echo "==> Pushing ${FULL_IMAGE}..."
"$DOCKER" push "$FULL_IMAGE"
"$DOCKER" push "$LATEST_IMAGE"

# ── Deploy ─────────────────────────────────────────────────────────────────────

echo "==> Deploying to Cloud Run service '${SERVICE}' (${PROJECT}/${REGION})..."
"$GCLOUD" run deploy "$SERVICE" \
  --image="$FULL_IMAGE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --quiet

# ── Sync Terraform state ────────────────────────────────────────────────────────

TFVARS="$(cd "$(dirname "$0")/.." && pwd)/terraform/terraform.tfvars"
if [[ -f "$TFVARS" ]]; then
  echo "==> Updating terraform/terraform.tfvars with deployed image tag..."
  # sed -i syntax differs between macOS (requires '') and Linux (no argument).
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|cloudrun_image = \".*\"|cloudrun_image = \"${FULL_IMAGE}\"|" "$TFVARS"
  else
    sed -i "s|cloudrun_image = \".*\"|cloudrun_image = \"${FULL_IMAGE}\"|" "$TFVARS"
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────

echo ""
echo "  Deployed:  ${FULL_IMAGE}"
SERVING="$("$GCLOUD" run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --format='value(status.traffic[0].revisionName)' 2>/dev/null || echo "unknown")"
echo "  Revision:  ${SERVING}"
echo "  URL:       https://${SERVICE_DOMAIN:-reversible.app}"
echo ""
echo "Done."
