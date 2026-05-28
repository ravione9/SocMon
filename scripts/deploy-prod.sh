#!/usr/bin/env bash
# Rebuild the SPA and roll prod API + nginx. Run from the repo root on the prod host.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pull latest"
git pull origin main

echo "==> Build client (required — prod nginx serves ./client/dist, not dev HMR)"
npm run build

echo "==> Recreate API + nginx"
docker compose -f docker-compose.prod.yml up -d --build --force-recreate --no-deps server nginx

echo "==> Done. Hard-refresh the browser (Ctrl+Shift+R) if nav still looks stale."
