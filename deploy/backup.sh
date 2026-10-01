#!/usr/bin/env bash
# Consistent SQLite backup plus the data directory. Example cron (as eventkit):
#   15 * * * * /opt/eventkit/deploy/backup.sh /var/lib/eventkit/backups
set -euo pipefail
dest="${1:-/var/lib/eventkit/backups}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$dest"
sqlite3 /var/lib/eventkit/eventkit.db ".backup '$dest/eventkit-$stamp.db'"
tar -czf "$dest/data-$stamp.tar.gz" --exclude=data/mirror -C /var/lib/eventkit data
# Keep the newest 48 of each.
ls -1t "$dest"/eventkit-*.db 2>/dev/null | tail -n +49 | xargs -r rm --
ls -1t "$dest"/data-*.tar.gz 2>/dev/null | tail -n +49 | xargs -r rm --
