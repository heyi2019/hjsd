#!/bin/bash
# 黑金时代 ERP 前端常驻启动脚本（由 launchd 调用）
# 端口 5188；vite.config.ts 的 proxy 已将 /api/v1 指向 127.0.0.1:8123 后端。
set -euo pipefail

FRONTEND_DIR="/Users/aries/黑金时代/frontend"
VITE_BIN="$FRONTEND_DIR/node_modules/.bin/vite"
LOG_DIR="/Users/aries/黑金时代/logs"
mkdir -p "$LOG_DIR"

cd "$FRONTEND_DIR"
exec node "$VITE_BIN" --host 0.0.0.0 --port 5188
