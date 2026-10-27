#!/usr/bin/env bash
# 正式库每日在线备份（在 ECS 上由 cron 调用，也可手动执行）
#
# 背景：deploy.sh 的备份只在「部署前」触发，日常运行期间不产生任何备份快照。
#       本脚本补上日常快照，与 pull_backup.sh（本机异地留存）配套使用。
#
# 用法（在 ECS 上）：
#   bash /opt/heijin/deploy/scripts/backup_daily.sh
#   ERP_BACKUP_KEEP=14 bash deploy/scripts/backup_daily.sh      # 覆盖保留份数
#
# crontab（每日 03:20）：
#   20 3 * * * /bin/bash /opt/heijin/deploy/scripts/backup_daily.sh >> /var/log/heijin_backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

KEEP="${ERP_BACKUP_KEEP:-30}"
DB=/app/data/heijin_erp_v1.db
OUT=/app/data/backups

if [ ! -f .env ]; then
  echo "✗ 缺少 deploy/.env（本脚本需与 docker compose 使用同一份部署配置）" >&2
  exit 1
fi

# compose 里镜像 tag 是 ${APP_VERSION:-latest}，而 APP_VERSION 只由 deploy.sh 在运行时导出。
# cron 直接调本脚本时没有该变量，会回落到 heijin-backend:latest——这个 tag 从不构建，
# compose run 因此失败；若不加区分，失败会被下面的「库不存在」分支吞掉，
# 表现成「每天 03:20 正常跳过」，备份永远不产生。故这里自行解析，与 deploy.sh 同源。
APP_VERSION="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' ../backend/app/version.py 2>/dev/null | head -1 || true)"
APP_VERSION="${APP_VERSION:-latest}"
export APP_VERSION

# 镜像缺失必须显式失败：cron 日志要能看见，不能伪装成「库还没建」。
if ! docker image inspect "heijin-backend:${APP_VERSION}" >/dev/null 2>&1; then
  echo "✗ 镜像 heijin-backend:${APP_VERSION} 不存在，无法备份" >&2
  echo "  先执行 deploy.sh，或 docker load 导入离线镜像包" >&2
  exit 1
fi

# 首次部署前正式库尚不存在：跳过而非失败，避免 cron 每天报错。
if ! docker compose run --rm -T --no-deps backend test -f "$DB" </dev/null >/dev/null 2>&1; then
  echo "[backup-daily] 正式库不存在，跳过（首次部署前属正常）"
  exit 0
fi

# -T + </dev/null 缺一不可：cron/无 TTY 环境下 compose run 会 attach stdin 并永久等待，
# 表现为备份「卡住无输出」，且 cron 会堆叠出多个僵尸进程。deploy.sh 里同样位置需保持一致。
docker compose run --rm -T --no-deps backend \
  python /app/scripts/backup_db.py --db "$DB" --out-dir "$OUT" --keep "$KEEP" </dev/null
