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

# 首次部署前正式库尚不存在：跳过而非失败，避免 cron 每天报错。
if ! docker compose run --rm --no-deps backend test -f "$DB" >/dev/null 2>&1; then
  echo "[backup-daily] 正式库不存在，跳过（首次部署前属正常）"
  exit 0
fi

docker compose run --rm --no-deps backend \
  python /app/scripts/backup_db.py --db "$DB" --out-dir "$OUT" --keep "$KEEP"
