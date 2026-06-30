#!/bin/bash
set -e

SERVER="fes@192.168.150.34"
REMOTE_DIR="/home/fes/oowsp"
PASSWORD="Fes.123$"

echo "=== Building project ==="
cd "$(dirname "$0")/.."
npm run build -w server
npm run build -w client

echo "=== Syncing files to server ==="
sshpass -p "$PASSWORD" rsync -avz --delete \
    server/dist/ \
    client/dist/ \
    server/package.json \
    server/package-lock.json \
    "$SERVER:$REMOTE_DIR/"

echo "=== Installing server deps ==="
sshpass -p "$PASSWORD" ssh "$SERVER" "cd $REMOTE_DIR && npm install --omit=dev"

echo "=== Restarting server ==="
sshpass -p "$PASSWORD" ssh "$SERVER" "pm2 restart oowsp || pm2 start dist/server/src/index.js --name oowsp && pm2 save"

echo "=== Deploy complete ==="
