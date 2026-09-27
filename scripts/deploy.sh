#!/usr/bin/env bash
# Manual deploy (no GitHub link): stamps the local commit SHA, uploads, waits for health.
set -euo pipefail
cd "$(dirname "$0")/.."
SERVICE=neqiwha-backend
SHA=$(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain)" ] && echo "-dirty" || true)
railway variable set -s "$SERVICE" --skip-deploys "BUILD_SHA=$SHA" >/dev/null
railway up -s "$SERVICE" --ci
echo "Deploying $SERVICE @ $SHA"
