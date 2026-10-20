#!/usr/bin/env bash
#
# 生成 / 更新 .env 配置文件。
# 用法：
#   bash scripts/setup.sh                                   # 交互式
#   ARGO_DOMAIN=node.example.com ARGO_AUTH=eyJ... bash scripts/setup.sh
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

gen_uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  elif command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    node -e "console.log(require('crypto').randomUUID())"
  fi
}

UUID="${UUID:-$(gen_uuid)}"
ARGO_DOMAIN="${ARGO_DOMAIN:-}"
ARGO_AUTH="${ARGO_AUTH:-}"
CFIP="${CFIP:-}"
CFPORT="${CFPORT:-443}"
NAME="${NAME:-US-Google_Cloud}"
# 3001 是 sing-box fallback 的固定目标，别改，否则隧道回源看不到网页/订阅
PORT="${PORT:-3001}"
ARGO_PORT="${ARGO_PORT:-8080}"
SUB_PATH="${SUB_PATH:-jl}"

if [ -z "$ARGO_DOMAIN" ] && [ -t 0 ]; then
  read -r -p "Cloudflare 隧道域名（如 node.example.com）: " ARGO_DOMAIN
fi
if [ -z "$ARGO_AUTH" ] && [ -t 0 ]; then
  read -r -s -p "Cloudflare Tunnel Token: " ARGO_AUTH
  echo
fi

[ -n "$ARGO_DOMAIN" ] || { echo "错误：ARGO_DOMAIN 不能为空" >&2; exit 1; }
[ -n "$ARGO_AUTH" ] || { echo "错误：ARGO_AUTH 不能为空（不要使用脚本内置的第三方 Token）" >&2; exit 1; }
CFIP="${CFIP:-$ARGO_DOMAIN}"

if [ -e "$ENV_FILE" ]; then
  backup="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$ENV_FILE" "$backup"
  echo "已备份原配置：$backup"
fi

umask 077
cat > "$ENV_FILE" <<EOF
# 由 scripts/setup.sh 生成于 $(date '+%Y-%m-%d %H:%M:%S')
UUID=$UUID
PORT=$PORT
ARGO_PORT=$ARGO_PORT
NAME=$NAME
ARGO_AUTH=$ARGO_AUTH
ARGO_DOMAIN=$ARGO_DOMAIN
CFIP=$CFIP
CFPORT=$CFPORT
SUB_PATH=$SUB_PATH
EOF
chmod 600 "$ENV_FILE"

cat <<EOF

已写入 $ENV_FILE

  UUID        : $UUID
  PORT        : $PORT
  ARGO_PORT   : $ARGO_PORT
  ARGO_DOMAIN : $ARGO_DOMAIN
  CFIP        : $CFIP:$CFPORT
  SUB_PATH    : /$SUB_PATH

下一步：
  docker compose up -d --build
  bash scripts/get-sub.sh
EOF
