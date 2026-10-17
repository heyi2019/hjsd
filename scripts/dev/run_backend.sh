#!/bin/bash
# 黑金时代 ERP 后端常驻启动脚本（由 launchd 调用）
# 与 docs/ERP_本地开发与联调指南_v1.0.md 保持一致：本地 8123，0.0.0.0 绑定。
set -euo pipefail

PROJECT_ROOT="/Users/aries/黑金时代"
BACKEND_DIR="$PROJECT_ROOT/backend"
VENV_PY="$BACKEND_DIR/.venv/bin/python3"
LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

cd "$BACKEND_DIR"
exec "$VENV_PY" -m uvicorn app.main:app --host 0.0.0.0 --port 8123
