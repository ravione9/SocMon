#!/bin/sh
set -e
cd /app

verify_deps() {
  node --input-type=module -e "await import('dotenv')" >/dev/null 2>&1
}

clear_node_modules_contents() {
  if [ ! -d node_modules ]; then
    return 0
  fi
  echo "server: clearing node_modules contents inside volume..."
  find node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} +
}

install_deps() {
  echo "server: running pnpm install --frozen-lockfile..."
  set +e
  pnpm install --frozen-lockfile
  ok=$?
  set -e
  if [ "$ok" != 0 ]; then
    echo "server: frozen-lockfile failed — pnpm install..."
    pnpm install
  fi
}

if verify_deps; then
  exec "$@"
fi

echo "server: imports failed — reinstalling dependencies (pnpm, avoids flaky npm ci in Docker)..."
install_deps

if ! verify_deps; then
  echo "server: still broken — clearing volume contents and retrying..."
  clear_node_modules_contents
  install_deps
fi

if ! verify_deps; then
  echo "server: dependency tree still broken. Reset the volume from the host:" >&2
  echo "  docker compose down && docker volume rm netpulse-dev_server_nm && docker compose up -d server" >&2
  exit 1
fi

exec "$@"
