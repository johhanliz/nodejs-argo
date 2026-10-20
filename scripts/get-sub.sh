#!/usr/bin/env bash
#
# 从本地取回订阅内容（base64），解码后打印 vless / vmess / trojan 链接。
# 用法：
#   bash scripts/get-sub.sh            # 读取 .env 里的 PORT / SUB_PATH
#   PORT=3001 SUB_PATH=jl bash scripts/get-sub.sh
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/.env"
  set +a
fi

PORT="${PORT:-3001}"
SUB_PATH="${SUB_PATH:-jl}"
URL="http://127.0.0.1:${PORT}/${SUB_PATH}"

payload="$(curl -fsS --max-time 10 "$URL")"

if printf '%s' "$payload" | base64 -d >/dev/null 2>&1; then
  printf '%s' "$payload" | base64 -d
  echo
else
  printf '%s\n' "$payload"
fi
