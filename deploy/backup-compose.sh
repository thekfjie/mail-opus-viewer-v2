#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p .state/backups
backup=".state/backups/opusmail.$(date -u +%Y%m%dT%H%M%SZ).$$.sql.gz"
trap 'test ! -f "$backup.tmp" || unlink "$backup.tmp"' EXIT
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump -uopusmail --single-transaction --quick --no-tablespaces --set-gtid-purged=OFF --column-statistics=0 --hex-blob --default-character-set=utf8mb4 opusmail' | gzip > "$backup.tmp"
gzip -t "$backup.tmp"
mv "$backup.tmp" "$backup"
printf '%s\n' "$backup"
