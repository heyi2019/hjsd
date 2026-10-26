#!/bin/bash
# 黑金时代 ERP 后端常驻启动脚本（由 launchd 调用）
# 与 docs/ERP_本地开发与联调指南_v1.0.md 保持一致：本地 8123，0.0.0.0 绑定。
#
# --reload 仅在 app/ 内生效（--reload-dir app）：
#   不加则改代码后进程仍跑旧代码，症状是「部分接口 500（引用已删的列或表）」
#   而非整体不可用，极易误判为连不上后端。
#   显式限定 watch 范围，避免把 .venv（数千文件）与 data/*.db 写入纳入监听。
# ⚠️ 纯迁库（只改 DB、不改 app/ 代码）不会触发 reload，仍需手动：
#      launchctl kickstart -k gui/$(id -u)/com.heijin-erp.backend
set -euo pipefail

PROJECT_ROOT="/Users/aries/黑金时代"
BACKEND_DIR="$PROJECT_ROOT/backend"
VENV_PY="$BACKEND_DIR/.venv/bin/python3"
LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

cd "$BACKEND_DIR"
exec "$VENV_PY" -m uvicorn app.main:app \
  --host 0.0.0.0 --port 8123 \
  --reload --reload-dir app
