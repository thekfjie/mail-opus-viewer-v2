#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/var/backups/mail-opus-cutover/${STAMP}"

curl --fail --silent --show-error http://127.0.0.1:8789/health >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8790/health >/dev/null

sudo install -d -m 0700 -o root -g root "$BACKUP_DIR"
sudo cp -a /etc/nginx/conf.d/00-cloud-opus-disabled.conf "$BACKUP_DIR/cloud.nginx.conf"
sudo cp -a /etc/nginx/sites-available/mail.example.com "$BACKUP_DIR/mail.nginx.conf"
sudo cp -a /opt/mail-opus-viewer/access-config.json "$BACKUP_DIR/v1-access-config.json"
sudo cp -a /var/lib/mail-opus-v2/mail-opus-v2.sqlite "$BACKUP_DIR/v2.sqlite"
sudo ln -sfn "$BACKUP_DIR" /var/backups/mail-opus-cutover/pre-v2-current

restore_on_error() {
  sudo cp -a "$BACKUP_DIR/cloud.nginx.conf" /etc/nginx/conf.d/00-cloud-opus-disabled.conf
  sudo cp -a "$BACKUP_DIR/mail.nginx.conf" /etc/nginx/sites-available/mail.example.com
  sudo nginx -t >/dev/null && sudo systemctl reload nginx
}
trap restore_on_error ERR

sudo install -m 0644 "$ROOT/deploy/mail-opus-viewer-v2-cutover.nginx.conf" /etc/nginx/conf.d/00-cloud-opus-disabled.conf
sudo install -m 0644 "$ROOT/deploy/mail-opus-viewer-v2.nginx.conf" /etc/nginx/sites-available/mail.example.com
sudo nginx -t
sudo systemctl reload nginx

curl --fail --silent --show-error --retry 10 --retry-delay 1 https://mail.example.com/ >/dev/null
trap - ERR
printf 'V2 public cutover complete; rollback snapshot: %s\n' "$BACKUP_DIR"
printf 'Rollback command: sudo %s/deploy/rollback-to-v1.sh\n' "$ROOT"
