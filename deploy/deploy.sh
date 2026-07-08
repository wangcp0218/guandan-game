#!/bin/bash
set -e

SERVER="${SERVER:-fes@192.168.150.34}"
REMOTE_DIR="${REMOTE_DIR:-/home/fes/oowsp}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/oowsp_deploy_ed25519}"
SSH_OPTS="-i $SSH_KEY_PATH -o BatchMode=yes"

if [ ! -f "$SSH_KEY_PATH" ]; then
  echo "SSH key not found: $SSH_KEY_PATH"
  echo "Set SSH_KEY_PATH to your private key path and try again."
  exit 1
fi

echo "=== Building project ==="
cd "$(dirname "$0")/.."
npm run build -w server
npm run build -w client

echo "=== Preparing remote directories ==="
ssh $SSH_OPTS "$SERVER" "mkdir -p $REMOTE_DIR/server $REMOTE_DIR/client"

echo "=== Syncing files to server ==="
ssh $SSH_OPTS "$SERVER" "rm -rf $REMOTE_DIR/server/dist $REMOTE_DIR/client/dist"
tar -C server -cf - dist | ssh $SSH_OPTS "$SERVER" "mkdir -p $REMOTE_DIR/server && tar -xf - -C $REMOTE_DIR/server"
tar -C client -cf - dist | ssh $SSH_OPTS "$SERVER" "mkdir -p $REMOTE_DIR/client && tar -xf - -C $REMOTE_DIR/client"
cat server/package.json | ssh $SSH_OPTS "$SERVER" "cat > $REMOTE_DIR/server/package.json"

echo "=== Installing server deps ==="
ssh $SSH_OPTS "$SERVER" "cd $REMOTE_DIR/server && npm install --omit=dev"

echo "=== Restarting server ==="
ssh $SSH_OPTS "$SERVER" "cd $REMOTE_DIR/server && mkdir -p ~/.local/bin ~/.local/lib && PATH=\$HOME/.local/bin:\$PATH && if ! command -v pm2 >/dev/null 2>&1; then npm install -g --prefix ~/.local pm2; fi && (pm2 restart oowsp || pm2 start dist/server/src/index.js --name oowsp) && pm2 save"

echo "=== Deploy complete ==="
