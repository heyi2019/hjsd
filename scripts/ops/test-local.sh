#!/bin/sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
python3 "$ROOT_DIR/backend/scripts/setup_test_environment.py" --check
export PYTHONPATH="$ROOT_DIR/dependencies/python313-runtime:$ROOT_DIR/backend${PYTHONPATH:+:$PYTHONPATH}"
export TEST_REDIS_URL="${TEST_REDIS_URL:-redis://127.0.0.1:6389/0}"

# 收集及明确的「not db」通道无需创建临时库；遇到并行、自定义配置、环境附加选项或
# 含糊的标记表达式则保留原入口。离线通道覆盖两个 URL，防止意外连接开发库。
. "$ROOT_DIR/scripts/ops/test-local-mode.sh"
if heijin_is_offline "$@"; then
  export DATABASE_URL='postgresql+psycopg://offline:offline@/heijin_erp_dev?host=/dev/null'
  export TEST_DATABASE_URL='postgresql+psycopg://offline:offline@/heijin_erp_test?host=/dev/null'
  exec /Users/aries/Applications/Python_3.13/bin/python3 -m pytest "$@"
fi
exec /Users/aries/Applications/Python_3.13/bin/python3 "$ROOT_DIR/backend/scripts/ephemeral_test_db.py" test -- /Users/aries/Applications/Python_3.13/bin/python3 -m pytest "$@"
