#!/usr/bin/env bash
# Write a fresh random salt for today. Run nightly at UTC midnight (launchd) and
# kickstart PocketBase so it picks the new salt up — yesterday's anon hashes then
# become irreversible. The salt lives only in SALT_DIR (a RAM disk).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
: "${SALT_DIR:?set SALT_DIR in .env}"
mkdir -p "$SALT_DIR"
openssl rand -hex 32 > "$SALT_DIR/salt-today"
chmod 600 "$SALT_DIR/salt-today"
echo "salt rotated -> $SALT_DIR/salt-today"
# if PocketBase runs under launchd, pick up the new salt:
launchctl kickstart -k gui/"$(id -u)"/com.neonswarm.pocketbase 2>/dev/null || true
