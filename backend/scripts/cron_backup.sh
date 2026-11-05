#!/usr/bin/env bash
# 兼容壳：老的 crontab 条目（/opt/heijin/scripts/cron_backup.sh）仍会走通。
#
# 2026-11 起备份链已统一到 deploy/scripts/backup_daily.sh（pg_dump -Fc + sha256 +
# 完整性闸门 + 宿主机滚动保留）。本文件不再包含任何 SQLite 逻辑——SQLite 备份链
# （backup_db.py / heijin_erp_v1_*.db）已整体下线，留着它只会「成功」备份一份过期文件。
#
# 新机器请直接把 crontab 指到 backup_daily.sh：
#   20 3 * * * /bin/bash /opt/heijin/deploy/scripts/backup_daily.sh >> /var/log/heijin_backup.log 2>&1
set -euo pipefail

TARGET="${ERP_BACKUP_SCRIPT:-/opt/heijin/deploy/scripts/backup_daily.sh}"
if [ ! -f "$TARGET" ]; then
  echo "✗ 未找到 $TARGET" >&2
  echo "  备份已统一由 deploy/scripts/backup_daily.sh 负责，请检查部署目录是否完整" >&2
  exit 1
fi
exec /bin/bash "$TARGET" "$@"
