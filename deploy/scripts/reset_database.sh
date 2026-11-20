#!/usr/bin/env bash
# 一次性重建生产 PostgreSQL 数据库；保留其他数据库及附件数据卷。
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "✗ $*" >&2; exit 1; }
requested_version="${APP_VERSION:-}"
[ "${RESET_DATABASE:-false}" = "true" ] || die "未明确启用 RESET_DATABASE"
[[ "$requested_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "发布版本格式不正确"
[ "$requested_version" = "1.0.0" ] || die "本次数据库重建只适用于 V1.0.0"
[ -f .env ] || die "缺少 deploy/.env"
set -a
# 与 deploy.sh 一致，从服务器维护的环境文件读取管理员配置，不输出密码。
. ./.env
set +a
APP_VERSION="$requested_version"
export APP_VERSION
if [ -z "${ADMIN_PASSWORD:-}" ] || [ "${#ADMIN_PASSWORD}" -lt 8 ]; then
  die "ADMIN_PASSWORD 未配置或少于 8 位"
fi

state_root="../release-state"
marker="${state_root}/database-reset-v${APP_VERSION}"
[ ! -e "$marker" ] || die "V${APP_VERSION} 已开始过数据库重建，请检查现场，不得重复清库"

# 仅允许重建约定的生产库，禁止误指 dev/test/release 或 postgres 系统库。
if ! docker compose exec -T db sh -c \
  '[ "${POSTGRES_DB:-}" = "heijin_erp" ] && [ -n "${POSTGRES_USER:-}" ]' </dev/null; then
  die "数据库目标不是 heijin_erp，或数据库服务不可用"
fi

restore_services=1
reset_started=0
on_exit() {
  result=$?
  if [ "$result" -ne 0 ]; then
    if [ "$reset_started" = "0" ] && [ "$restore_services" = "1" ]; then
      echo "重建尚未开始，尝试恢复原服务" >&2
      docker compose start backend frontend >/dev/null 2>&1 || true
    else
      echo "数据库重建已开始；保留备份与状态标记，请检查现场后处理" >&2
    fi
  fi
}
trap on_exit EXIT

echo "==> 停止前后端写入，准备重建数据库"
docker compose stop frontend backend
backup_dir="../backups/pre-reset-v${APP_VERSION}-$(date +%Y%m%d_%H%M%S)-$$"
if ! ERP_PG_BACKUP_DIR="$backup_dir" ERP_BACKUP_KEEP=1 bash scripts/backup_daily.sh; then
  die "重建前备份失败，未清空数据库"
fi

umask 077
mkdir -p "$state_root"
mkdir "$marker" || die "无法创建一次性重建标记"
printf '%s\n' "$backup_dir" > "$marker/backup-path"
reset_started=1
restore_services=0
echo "==> 已备份，重建 heijin_erp 数据库（其他数据卷保留）"
docker compose exec -T db sh -c \
  'exec dropdb --force --maintenance-db=postgres -U "$POSTGRES_USER" -- "$POSTGRES_DB"' </dev/null
docker compose exec -T db sh -c \
  'exec createdb --maintenance-db=postgres -U "$POSTGRES_USER" -O "$POSTGRES_USER" -- "$POSTGRES_DB"' </dev/null
echo "==> 数据库已重建，等待执行 0001 初始化"
