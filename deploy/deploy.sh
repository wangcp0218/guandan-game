#!/usr/bin/env bash
set -Eeuo pipefail

# Production deployment helper. Authentication is provided by ssh-agent or
# SSH_KEY_PATH; this file intentionally contains no password or API key.
SERVER="${SERVER:-fes@192.168.150.34}"
REMOTE_DIR="${REMOTE_DIR:-/home/fes/oowsp}"
REMOTE_ARCHIVE="${REMOTE_ARCHIVE:-/home/fes/oowsp-src.tar.gz}"
SERVICE_NAME="${SERVICE_NAME:-oowsp}"
SSH_KEY_PATH="${SSH_KEY_PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_ARCHIVE="$(mktemp -t oowsp-src.XXXXXX.tar.gz)"
trap 'rm -f "$LOCAL_ARCHIVE"' EXIT

SSH_OPTIONS=(-o BatchMode=yes)
if [[ -n "$SSH_KEY_PATH" ]]; then
  if [[ ! -f "$SSH_KEY_PATH" ]]; then
    echo "SSH key not found: $SSH_KEY_PATH" >&2
    exit 1
  fi
  SSH_OPTIONS+=(-i "$SSH_KEY_PATH" -o IdentitiesOnly=yes)
fi

echo "=== Preflight ==="
git -C "$PROJECT_DIR" diff --check
if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes before deployment." >&2
  exit 1
fi

echo "=== Building server ==="
npm --prefix "$PROJECT_DIR" run build -w server

echo "=== Building client ==="
npm --prefix "$PROJECT_DIR" run build -w client

echo "=== Packaging source ==="
COPYFILE_DISABLE=1 tar czf "$LOCAL_ARCHIVE" \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='data' \
  -C "$PROJECT_DIR" .

echo "=== Uploading source ==="
scp "${SSH_OPTIONS[@]}" "$LOCAL_ARCHIVE" "$SERVER:$REMOTE_ARCHIVE"

echo "=== Building and restarting on server ==="
ssh "${SSH_OPTIONS[@]}" "$SERVER" \
  "set -e; mkdir -p '$REMOTE_DIR'; cd '$REMOTE_DIR'; tar xzf '$REMOTE_ARCHIVE'; rm -f '$REMOTE_ARCHIVE'; npm install; npm run build -w server; npm run build -w client; sudo systemctl restart '$SERVICE_NAME'"

echo "=== Verifying deployment ==="
ssh "${SSH_OPTIONS[@]}" "$SERVER" \
  "systemctl is-active '$SERVICE_NAME'; curl -fsS -o /dev/null -w 'HTTP %{http_code}\\n' http://127.0.0.1/"

echo "=== Deployment complete ==="
