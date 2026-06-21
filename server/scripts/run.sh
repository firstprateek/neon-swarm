#!/usr/bin/env bash
# Start PocketBase bound to localhost (the Cloudflare Tunnel makes it public).
# Loads .env, reads today's salt from the RAM disk into SALT_TODAY for the hooks.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
: "${SALT_DIR:?set SALT_DIR in .env}"
export SALT_TODAY="$(cat "$SALT_DIR/salt-today" 2>/dev/null || echo unsalted-dev)"
exec pb/pocketbase serve \
  --http=127.0.0.1:8090 \
  --dir=pb/pb_data \
  --hooksDir=pb/pb_hooks \
  --migrationsDir=pb/pb_migrations
