#!/usr/bin/env bash
# Download the pinned PocketBase (macOS arm64) into server/pb/. Migrations in
# pb/pb_migrations apply automatically on the first `serve`.
set -euo pipefail
PB_VER="0.22.21"   # pin — the JS hooks target this JSVM API
cd "$(dirname "$0")/.."
echo "$PB_VER" > .pbver

if [ ! -x pb/pocketbase ]; then
  arch="$(uname -m)"; [ "$arch" = "arm64" ] && arch="arm64" || arch="amd64"
  url="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VER}/pocketbase_${PB_VER}_darwin_${arch}.zip"
  echo "Downloading PocketBase ${PB_VER} (${arch})..."
  curl -fsSL "$url" -o /tmp/ns-pb.zip
  mkdir -p pb && unzip -o /tmp/ns-pb.zip -d pb pocketbase >/dev/null
  chmod +x pb/pocketbase
fi

echo "Ready. Now: cp .env.example .env && edit it, then:"
echo "  ./scripts/salt-rotate.sh        # seed today's salt"
echo "  ./scripts/run.sh                # serve on 127.0.0.1:8090 (localhost only; the tunnel exposes it)"
echo "First run will create an admin — open http://127.0.0.1:8090/_/ to set credentials."
