#!/usr/bin/env bash
# 黑金时代 ERP 生产库定时备份包装脚本（由系统 cron 调用）。
#
# 职责：
#   1) 在 backend 容器内对在线库做一致性备份（sqlite3 backup API + WAL checkpoint + SHA256 sidecar），
#      写入容器卷 /app/data/backups/（随容器重启保留，滚动 30 份）。
#   2) 把卷内备份目录镜像到宿主机磁盘 /opt/heijin/db_backups/（docker 卷之外），
#      防卷误删导致备份与库同归于尽。
#   3) 宿主机侧同步滚动保留 30 份。
#
# 说明：真·异地（对象存储 OSS）需安装 ossutil 并提供桶凭证，当前环境缺失，
#      未激活；待补后追加 `ossutil cp` 一行即可。
set -euo pipefail

COMPOSE_FILE="/opt/heijin/deploy/docker-compose.yml"
SERVICE="backend"
VOL_BACKUP_DIR="/app/data/backups"
HOST_BACKUP_DIR="/opt/heijin/db_backups"
KEEP=30
TS="$(date +%Y%m%d_%H%M%S)"
LOG="/opt/heijin/scripts/cron_backup.log"

log() { echo "[$TS] $*" | tee -a "$LOG"; }

log "--- start ---"

# 1) 容器内在线备份
if ! /usr/bin/docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" python /app/scripts/backup_db.py \
     --db /app/data/heijin_erp_v1.db \
     --out-dir "$VOL_BACKUP_DIR" \
     --keep "$KEEP"; then
  log "FATAL: in-container backup failed"
  exit 1
fi

# 2) 镜像到宿主机磁盘（卷之外）。用 tar 流式导出（docker cp 对目录语义会嵌套，不可靠）
mkdir -p "$HOST_BACKUP_DIR"
if ! /usr/bin/docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" tar -czf - -C "$VOL_BACKUP_DIR" . \
     | tar -xzf - -C "$HOST_BACKUP_DIR"; then
  log "ERROR: host mirror (tar stream) failed — 卷内备份已成功，仅宿主机镜像缺失"
fi

# 3) 宿主机侧滚动保留
find "$HOST_BACKUP_DIR" -maxdepth 1 -name 'heijin_erp_v1_*.db'        | sort | head -n -"$KEEP" | xargs -r rm -f
find "$HOST_BACKUP_DIR" -maxdepth 1 -name 'heijin_erp_v1_*.db.sha256' | sort | head -n -"$KEEP" | xargs -r rm -f

log "--- done (host mirror count: $(find "$HOST_BACKUP_DIR" -maxdepth 1 -name 'heijin_erp_v1_*.db' | wc -l)) ---"
