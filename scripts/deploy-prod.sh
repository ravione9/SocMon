#!/usr/bin/env bash
# Prod deploy on mon-itinfra — run from repo root (/opt/SocMon).
# Manual equivalent (what we used to run by hand):
#   git pull
#   cd client && npm run build:prod && cd ..
#   docker compose -f docker-compose.prod.yml up -d --build --force-recreate --no-deps server nginx
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pull latest"
git pull origin main

echo "==> Install client deps + build SPA (nginx serves ./client/dist)"
cd client && npm run build:prod && cd ..

echo "==> Recreate API + nginx"
docker compose -f docker-compose.prod.yml up -d --build --force-recreate --no-deps server nginx

echo "==> Done. Hard-refresh the browser (Ctrl+Shift+R) if the UI looks stale."
