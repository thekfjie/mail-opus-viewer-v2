#!/usr/bin/env bash
set -euo pipefail

BACKUP_LINK="/var/backups/mail-opus-cutover/pre-v2-current"
if [[ ! -e "$BACKUP_LINK/cloud.nginx.conf" || ! -e "$BACKUP_LINK/mail.nginx.conf" ]]; then
  echo "V1 rollback snapshot is missing" >&2
  exit 1
fi

sudo systemctl start mail-opus-viewer.service
curl --fail --silent --show-error --retry 10 --retry-delay 1 http://127.0.0.1:8789/health >/dev/null
sudo cp -a "$BACKUP_LINK/cloud.nginx.conf" /etc/nginx/conf.d/00-cloud-opus-disabled.conf
sudo cp -a "$BACKUP_LINK/mail.nginx.conf" /etc/nginx/sites-available/mail.example.com
sudo nginx -t
sudo systemctl reload nginx
curl --fail --silent --show-error --retry 10 --retry-delay 1 https://legacy-mail.example.com/ >/dev/null
echo "V1 public entry restored; V2 remains available on loopback for diagnosis"
