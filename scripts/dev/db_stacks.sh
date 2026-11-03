#!/usr/bin/env bash
# 四库端口映射的唯一真相：一个库绑一套前端/后端，互不串库。
#
#   用途           前端   后端   库
#   本地使用(主)    5188   8123   heijin_erp_release   ← launchd 守护，本脚本只管不启
#   本地开发        5199   8125   heijin_erp_dev
#   pytest 测试     5200   8126   heijin_erp_test
#   Playwright E2E  5201   8127   heijin_erp_e2e
#
# 用法：
#   bash scripts/dev/db_stacks.sh status        # 四套端口 → 库的实际指向（默认）
#   bash scripts/dev/db_stacks.sh up dev        # 起 dev 一套（dev|test|e2e|all）
#   bash scripts/dev/db_stacks.sh down dev      # 停 dev 一套
#   bash scripts/dev/db_stacks.sh restart all
#
# 约定：
#   - release 由 launchd（com.heijin-erp.backend / .frontend）守护，脚本绝不 kill 它，
#     要重启用：launchctl kickstart -k gui/$(id -u)/com.heijin-erp.backend
#   - e2e 启动前先跑 e2e_db.py（默认 keep 模式：不删数据，只补表与种子）
#   - 后端一律用环境变量 DATABASE_URL 覆盖 .env，显式绑库，不依赖默认值
set -uo pipefail

PROJECT_ROOT="/Users/aries/黑金时代"
BACKEND_DIR="${PROJECT_ROOT}/backend"
FRONTEND_DIR="${PROJECT_ROOT}/frontend"
PY="${BACKEND_DIR}/.venv/bin/python3"
LOG_DIR="${PROJECT_ROOT}/logs"
mkdir -p "${LOG_DIR}"

if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "${PROJECT_ROOT}/.env"
  set +a
fi

PG_USER="${ERP_PG_USER:-erp_app}"
PG_PASS="${ERP_PG_PASSWORD:-}"
PG_PORT="${ERP_PG_PORT:-5433}"

dsn_for() {
  echo "postgresql+psycopg://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/$1"
}

db_of() {
  case "$1" in
    release) echo heijin_erp_release ;;
    dev)     echo heijin_erp_dev ;;
    test)    echo heijin_erp_test ;;
    e2e)     echo heijin_erp_e2e ;;
  esac
}

be_of() {
  case "$1" in
    release) echo 8123 ;;
    dev)     echo 8125 ;;
    test)    echo 8126 ;;
    e2e)     echo 8127 ;;
  esac
}

fe_of() {
  case "$1" in
    release) echo 5188 ;;
    dev)     echo 5199 ;;
    test)    echo 5200 ;;
    e2e)     echo 5201 ;;
  esac
}

port_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
}

actual_db() {
  # 经前端代理反查健康接口，拿到该入口真正连的库名
  local fe="$1"
  curl -s -m 3 "http://127.0.0.1:${fe}/api/v1/health" 2>/dev/null \
    | sed -E 's/.*"database":"[^"]*\/\/[^/]*\/([^"]+)".*/\1/'
}

label_of() {
  case "$1" in
    release) echo "本地使用" ;;
    dev)     echo "本地开发" ;;
    test)    echo "pytest" ;;
    e2e)     echo "E2E" ;;
  esac
}

start_backend() {
  local env_name="$1" be db
  be=$(be_of "${env_name}")
  db=$(db_of "${env_name}")
  if port_busy "${be}"; then
    echo "[${env_name}] 后端 ${be} 已在监听，跳过"
    return 0
  fi
  if [[ "${env_name}" == "e2e" ]]; then
    # keep 模式：不删数据，只补缺失表 + 幂等播种
    ( cd "${BACKEND_DIR}" && E2E_DATABASE_URL="$(dsn_for "${db}")" DATABASE_URL="$(dsn_for "${db}")" \
        "${PY}" scripts/e2e_db.py ) || return 1
  fi
  ( cd "${BACKEND_DIR}" && DATABASE_URL="$(dsn_for "${db}")" \
      nohup "${PY}" -m uvicorn app.main:app --host 0.0.0.0 --port "${be}" \
      > "${LOG_DIR}/backend-${env_name}.log" 2>&1 & echo $! > "${LOG_DIR}/backend-${env_name}.pid" )
  echo "[${env_name}] 后端 ${be} -> ${db} 已启动（pid $(cat "${LOG_DIR}/backend-${env_name}.pid")）"
}

start_frontend() {
  local env_name="$1" fe be
  fe=$(fe_of "${env_name}")
  be=$(be_of "${env_name}")
  if port_busy "${fe}"; then
    echo "[${env_name}] 前端 ${fe} 已在监听，跳过"
    return 0
  fi
  ( cd "${FRONTEND_DIR}" && VITE_BACKEND_PORT="${be}" \
      nohup npx vite --host 0.0.0.0 --port "${fe}" --strictPort \
      > "${LOG_DIR}/frontend-${env_name}.log" 2>&1 & echo $! > "${LOG_DIR}/frontend-${env_name}.pid" )
  echo "[${env_name}] 前端 ${fe} 已启动（代理 -> ${be}）"
}

stop_one() {
  local env_name="$1" be fe pidfile pid
  be=$(be_of "${env_name}")
  fe=$(fe_of "${env_name}")
  for port in "${be}" "${fe}"; do
    pid=$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | head -1)
    if [[ -n "${pid}" ]]; then
      kill "${pid}" 2>/dev/null
      echo "[${env_name}] 已停 ${port}（pid ${pid}）"
    fi
  done
  for pidfile in "${LOG_DIR}/backend-${env_name}.pid" "${LOG_DIR}/frontend-${env_name}.pid"; do
    [[ -f "${pidfile}" ]] && rm -f "${pidfile}"
  done
  return 0
}

do_status() {
  printf "%-10s %-6s %-6s %-8s %s\n" "用途" "前端" "后端" "页面" "实际库"
  local e fe be code db
  for e in release dev test e2e; do
    fe=$(fe_of "${e}")
    be=$(be_of "${e}")
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${fe}/" 2>/dev/null)
    db=$(actual_db "${fe}")
    [[ -z "${code}" ]] && code="DOWN"
    [[ -z "${db}" ]] && db="—"
    printf "%-10s %-6s %-6s %-8s %s\n" "$(label_of "${e}")" "${fe}" "${be}" "${code}" "${db}"
  done
}

do_up() {
  local target="$1" e
  if [[ "${target}" == "all" ]]; then
    for e in dev test e2e; do
      start_backend "${e}"
      start_frontend "${e}"
    done
    echo "提示：release（5188/8123）由 launchd 守护，不需要本脚本启动。"
  else
    start_backend "${target}"
    start_frontend "${target}"
  fi
}

do_down() {
  local target="$1" e
  if [[ "${target}" == "release" ]]; then
    echo "拒绝：release 由 launchd 守护，请用 launchctl 操作。" >&2
    return 1
  fi
  if [[ "${target}" == "all" ]]; then
    for e in dev test e2e; do stop_one "${e}"; done
  else
    stop_one "${target}"
  fi
}

cmd="${1:-status}"
target="${2:-all}"

case "${cmd}" in
  status)  do_status ;;
  up)      do_up "${target}" ;;
  down)    do_down "${target}" ;;
  restart) do_down "${target}" && sleep 1 && do_up "${target}" ;;
  *)
    echo "用法: bash scripts/dev/db_stacks.sh {status|up|down|restart} [release|dev|test|e2e|all]" >&2
    exit 1
    ;;
esac
