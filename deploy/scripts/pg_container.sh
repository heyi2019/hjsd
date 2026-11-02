#!/usr/bin/env bash
# pg_container.sh —— 黑金本机数据库容器的唯一入口。
#
# 为什么不让人直接 docker compose up：密码、用户、归档路径都在仓库根 `.env` 里，
# 不走 --env-file 的话 compose 会因变量缺失报错，或者更糟——用占位值起一个新卷。
#
# 用法：
#   bash deploy/scripts/pg_container.sh up       # 启动（幂等）
#   bash deploy/scripts/pg_container.sh down     # 停止（保留数据卷）
#   bash deploy/scripts/pg_container.sh status   # 容器 + 归档器 + 三库连接状态
#   bash deploy/scripts/pg_container.sh logs     # 跟踪日志
#   bash deploy/scripts/pg_container.sh psql <db>  # 进 psql
#
# 退出码：0 正常 / 2 环境或参数错误。

set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
ENV_FILE="${REPO_ROOT}/.env"
COMPOSE_FILE="${REPO_ROOT}/deploy/container/compose.yaml"
CONTAINER="${ERP_PG_CONTAINER:-heijin-db-1}"
PGUSER="${ERP_PG_USER:-erp_app}"
PORT="${ERP_PG_PORT:-5433}"

die() { echo "✗ $*" >&2; exit 2; }
[ -f "${ENV_FILE}" ] || die "找不到 ${ENV_FILE}（ERP_PG_USER / ERP_PG_PASSWORD / ERP_PG_ARCHIVE_HOST 在这里）"
[ -f "${COMPOSE_FILE}" ] || die "找不到 ${COMPOSE_FILE}"

compose() {
  docker compose --env-file "${ENV_FILE}" -p heijin -f "${COMPOSE_FILE}" "$@"
}

case "${1:-}" in
  up)
    compose up -d
    echo -n "等待就绪"
    for _ in $(seq 1 30); do
      if docker exec "${CONTAINER}" pg_isready -U "${PGUSER}" -d postgres >/dev/null 2>&1; then
        echo " ✅ ${CONTAINER} 127.0.0.1:${PORT}"
        exit 0
      fi
      echo -n "."
      sleep 1
    done
    echo " ✗ 超时"
    compose logs --tail 20 db >&2
    exit 2
    ;;
  down)
    compose down
    echo "（数据卷 heijin_pg_data 保留；要删请显式 compose down -v）"
    ;;
  status)
    echo "=== 容器 ==="
    docker ps -a --filter "name=${CONTAINER}" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo "=== 归档器 ==="
    docker exec "${CONTAINER}" psql -U "${PGUSER}" -d postgres -tAc \
      "select 'archive_mode='||(select setting from pg_settings where name='archive_mode')
        ||' archived='||archived_count||' failed='||failed_count
        ||' last='||coalesce(last_archived_wal,'-') from pg_stat_archiver;" 2>/dev/null || echo "容器未运行"
    echo "=== 三库 ==="
    docker exec "${CONTAINER}" psql -U "${PGUSER}" -d postgres -tAc \
      "select '  '||datname||' '||pg_size_pretty(pg_database_size(datname))
       from pg_database where datname like 'heijin%' order by 1;" 2>/dev/null || true
    ;;
  logs)
    compose logs -f --tail 50 db
    ;;
  psql)
    TARGET="${2:-postgres}"
    docker exec -it "${CONTAINER}" psql -U "${PGUSER}" -d "${TARGET}"
    ;;
  *)
    die "用法：pg_container.sh up|down|status|logs|psql <db>"
    ;;
esac
