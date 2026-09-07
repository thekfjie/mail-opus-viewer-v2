#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "V2 工作区存在未提交修改，拒绝发布。请先提交当前版本。" >&2
  exit 1
fi
if [[ -f dist/release-manifest.json && "${ALLOW_RELEASE_ROLLBACK:-0}" != "1" ]]; then
  PREVIOUS_COMMIT="$(node -e 'try{process.stdout.write(String(require("./dist/release-manifest.json").gitCommit||""))}catch{}')"
  if [[ -n "$PREVIOUS_COMMIT" ]] && ! git merge-base --is-ancestor "$PREVIOUS_COMMIT" HEAD; then
    echo "V2 当前提交早于或偏离线上版本，拒绝回滚发布。确需回滚时显式设置 ALLOW_RELEASE_ROLLBACK=1。" >&2
    exit 1
  fi
fi

# V2 serves compiled output from dist/.  A source edit is not a release until
# the server and browser bundles are rebuilt and the running process is
# restarted.  Keeping those operations together prevents source/dist drift.
npm run build
sudo -n systemctl restart mail-opus-viewer-v2.service
sudo -n systemctl is-active --quiet mail-opus-viewer-v2.service

curl --fail --silent --show-error --retry 15 --retry-delay 1 --retry-connrefused --max-time 5 http://127.0.0.1:8790/health >/dev/null
echo "Opus Mail V2 release deployed from $ROOT"
