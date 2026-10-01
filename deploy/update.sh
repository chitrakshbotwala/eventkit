#!/usr/bin/env bash
# Update a VPS install to the latest `server` branch.
# Run as the eventkit user:  /opt/eventkit/deploy/update.sh && sudo systemctl restart eventkit
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
pnpm install --frozen-lockfile
pnpm --filter @eventkit/admin build
pnpm --filter @eventkit/server build
# Applies schema changes. It refuses (and stops this script) if a change would lose data.
pnpm --filter @eventkit/server exec prisma db push

echo "Updated to $(git rev-parse --short HEAD). Restart with: sudo systemctl restart eventkit"
