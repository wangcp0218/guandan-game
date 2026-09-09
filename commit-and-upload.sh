#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
commit_message="${1:-}"
deploy_host="fes@192.168.150.34"
deploy_archive="oowsp-src.tar.gz"
local_archive="/tmp/${deploy_archive}"

if [[ -z "$commit_message" ]]; then
  echo "用法: $0 \"提交说明\""
  exit 1
fi

cd "$project_dir"

branch_name="$(git branch --show-current)"
if [[ -z "$branch_name" ]]; then
  branch_name="main"
  push_source="HEAD"
  echo "当前是 Codex 独立工作树，本次提交将同步到远端 main。"
else
  push_source="$branch_name"
fi

echo "[1/6] 构建服务端"
npm run build -w server

echo "[2/6] 构建客户端"
npm run build -w client

echo "[3/6] 提交代码"
git add -A
if git diff --cached --quiet; then
  echo "没有需要提交的改动，继续同步现有提交。"
else
  git commit -m "$commit_message"
fi

echo "[4/6] 推送 GitHub: origin/${branch_name}"
git push origin "${push_source}:${branch_name}"

echo "[5/6] 推送 Codeup: codeup/${branch_name}"
git push codeup "${push_source}:${branch_name}"

echo "[6/6] 打包并上传服务器"
git rev-parse --short=6 HEAD > .build-version
tar czf "$local_archive" \
  --exclude='./node_modules' \
  --exclude='./client/node_modules' \
  --exclude='./server/node_modules' \
  --exclude='./dist' \
  --exclude='./client/dist' \
  --exclude='./server/dist' \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./data' \
  .
scp "$local_archive" "${deploy_host}:/home/fes/${deploy_archive}"

echo "完成：代码已提交并同步，部署包已上传。"
echo "下一步请登录服务器并执行: ~/deploy-oowsp.sh"
