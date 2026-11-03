#!/usr/bin/env bash
# E2E 后端启动器：把后端指向**独立的 E2E 库** heijin_erp_e2e，绝不写入 dev/test/release。
#
# 流程：
#   1) 解析 E2E 库地址（E2E_DATABASE_URL 优先；否则从 .env 的 DATABASE_URL 仅替换库名 → heijin_erp_e2e，
#      保留 host/port/凭据）。库名含 `e2e` 的强制校验在 e2e_db.py 内完成，误指业务库即拒绝。
#   2) export DATABASE_URL / E2E_DATABASE_URL 指向 E2E 库（env var 覆盖 .env，已验证）。
#   3) 跑 e2e_db.py：建库（若不存在）→ create_all → TRUNCATE 全表 → 重播种子 + 夹具（用完就丢）。
#   4) 起 uvicorn，独占 ERP_E2E_BACKEND_PORT（默认 8124，绕开 8123 的常驻 dev 后端）。
#
# 被 frontend/playwright.config.ts 的 webServer 调起；CI 通过 E2E_DATABASE_URL 注入服务库地址。
set -eo pipefail
cd "$(dirname "$0")/.."   # -> backend/

PY="${ERP_E2E_PYTHON:-$PWD/.venv/bin/python}"
if [[ ! -x "$PY" ]]; then
  PY="python3"
fi
PORT="${ERP_E2E_BACKEND_PORT:-8124}"

E2E_URL="${E2E_DATABASE_URL:-}"
if [[ -z "$E2E_URL" && -f .env ]]; then
  # 从 .env 取业务库地址，仅替换库名为 heijin_erp_e2e（绝不手动拼凭据）。
  BASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
  E2E_URL="${BASE_URL%/*}/heijin_erp_e2e"
fi
if [[ -z "$E2E_URL" ]]; then
  echo "[e2e-backend] 无法解析 E2E 库地址（E2E_DATABASE_URL 未设且 .env 无 DATABASE_URL）" >&2
  exit 1
fi

export DATABASE_URL="$E2E_URL"
export E2E_DATABASE_URL="$E2E_URL"

echo "[e2e-backend] 重置并播种 E2E 库：$E2E_URL"
"$PY" scripts/e2e_db.py

echo "[e2e-backend] 启动 uvicorn @ ${PORT}（DATABASE_URL=$E2E_URL）"
exec "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
