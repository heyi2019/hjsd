#!/usr/bin/env bash
# check_baseline.sh —— 基线一致性门禁：alembic upgrade head 建出的库必须与 ORM 元数据零差异。
#
# 为什么需要：「改 ORM 即改基线」策略的静默失败模式——ORM 加了列、alembic 基线忘了改，
# 测试库（create_all）全绿，生产（alembic）缺列，上线当天 500。本脚本建临时 drill 库、
# 跑 alembic、再与 Base.metadata 比对（等价于比对 create_all），差异非空即失败。
#
# 用法：
#   本地：backend 目录下 bash scripts/check_baseline.sh
#         （BASE_URL 未指定时从根 .env 的 DATABASE_URL 取主机部分，库名不影响）
#   CI：  BASE_URL="postgresql+psycopg://erp_app:erp_app@127.0.0.1:5432" bash scripts/check_baseline.sh
#
# 退出码：0 一致 / 1 有差异 / 2 环境错误。只建/删临时库（heijin_erp_drill_ 前缀），不碰业务库。
set -euo pipefail
cd "$(dirname "$0")/.."   # backend/

PY="${PYTHON:-.venv/bin/python3}"
REPO_ROOT="$(cd .. && pwd)"

BASE_URL="${BASE_URL:-$("$PY" -c "from app.core.settings import get_settings; print(get_settings().database_url.rsplit('/', 1)[0])")}"
DB="${BASELINE_DB:-heijin_erp_drill_$(date +%Y%m%d_%H%M%S)}"
DSN="$BASE_URL/$DB"

cleanup() {
  "$PY" - "$BASE_URL" "$DB" <<'PYEOF' || true
import sys, psycopg
base_url, db = sys.argv[1], sys.argv[2]
dsn = base_url.replace("postgresql+psycopg://", "postgresql://") + "/postgres"
conn = psycopg.connect(dsn)
conn.autocommit = True
conn.execute(f'DROP DATABASE IF EXISTS "{db}" WITH (FORCE)')
conn.close()
print(f"临时库已清理：{db}")
PYEOF
}
trap cleanup EXIT

"$PY" - "$BASE_URL" "$DB" <<'PYEOF'
import sys, psycopg
base_url, db = sys.argv[1], sys.argv[2]
dsn = base_url.replace("postgresql+psycopg://", "postgresql://") + "/postgres"
conn = psycopg.connect(dsn)
conn.autocommit = True
conn.execute(f'DROP DATABASE IF EXISTS "{db}" WITH (FORCE)')
conn.execute(f'CREATE DATABASE "{db}"')
conn.close()
print(f"临时库已创建：{db}")
PYEOF

echo "=== alembic upgrade head -> $DB ==="
DATABASE_URL="$DSN" "$PY" -m alembic upgrade head

echo "=== schema_diff：$DB vs ORM 元数据 ==="
DATABASE_URL="$DSN" "$PY" "$REPO_ROOT/deploy/scripts/schema_diff.py" "$DB"

echo "基线一致性校验通过：alembic upgrade head == ORM 元数据（即 create_all）"
