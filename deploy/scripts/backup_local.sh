#!/usr/bin/env bash
# 本地开发库 / 发布库每日备份（macOS 宿主机，PostgreSQL 跑在 docker 容器里）
#
# 与 backup_daily.sh 的分工：
#   - backup_daily.sh 面向 ECS 生产（docker compose 的 db 服务 + deploy/.env）；
#   - 本脚本面向本机自建的 heijin-db-1 容器（dev / release 两库），归属本仓库的
#     deploy/container/compose.yaml。
#   两者产物格式一致（pg_dump -Fc + .sha256 sidecar），可互相用 restore_pg.sh 恢复。
#
# 契约：
#   1) pg_dump 必须在容器内跑：宿主机没有 PG 客户端。
#   2) 产物落宿主机磁盘（默认 backups/local/），不放 docker 卷——卷损坏不会把库和备份一起带走。
#   3) 每份备份都做**表数闸门**：归档里的 TABLE DATA 条数必须等于源库 public 表数，
#      不等直接失败。防的是「备份出来是半套或空库，但文件看着正常」。
#   4) 任何一步失败非零退出，cron 日志要能看见；滚动保留最近 N 份/库。
#   5) 末尾顺带执行 WAL 归档巡检与保留清理（原为独立的每小时 cron，11-04 并入，
#      原因见脚本末尾注释）。"BACKUP_OK" 只在两段都成功时出现，它仍是整体健康信号。
#
# 用法：
#   bash deploy/scripts/backup_local.sh
#   ERP_LOCAL_BACKUP_DBS="heijin_erp_dev" bash deploy/scripts/backup_local.sh   # 只备一个库
#   ERP_BACKUP_KEEP=30 bash deploy/scripts/backup_local.sh
#
# crontab（2026-11-03 01:20 已安装，每日 04:10，错开 ECS 的 03:20）：
#   PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
#   10 4 * * * /bin/bash /Users/aries/黑金时代/deploy/scripts/backup_local.sh >> /tmp/heijin_local_backup.log 2>&1
# 注意 PATH 那一行不能省：cron 默认只有 /usr/bin:/bin，找不到 homebrew 的 docker，
# 会变成「每天准时失败但没人看日志」。脚本内已自设 PATH 兜底，crontab 是第二道。
set -euo pipefail

# cron / launchd 的默认 PATH 只有 /usr/bin:/bin，找不到 homebrew 的 docker。
# 这里自设 PATH，保证「任何调用方（手动 / cron / launchd）」跑出来行为一致。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LANG="${LANG:-en_US.UTF-8}"

cd "$(dirname "$0")/../.."   # -> 仓库根

CONTAINER="${ERP_PG_CONTAINER:-heijin-db-1}"
DB_USER="${ERP_PG_USER:-erp_app}"
DBS="${ERP_LOCAL_BACKUP_DBS:-heijin_erp_dev heijin_erp_release}"
KEEP="${ERP_BACKUP_KEEP:-14}"
OUT="${ERP_LOCAL_BACKUP_DIR:-backups/local}"

die() { echo "✗ $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 \
  || die "PATH 里找不到 docker（当前 PATH=${PATH}）"

docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" \
  || die "容器 ${CONTAINER} 未运行，无法备份"

mkdir -p "$OUT"
STAMP="$(date +%Y%m%d_%H%M%S)"
OK=0

for DB in $DBS; do
  FILE="$OUT/${DB}_${STAMP}.dump"
  TMP="${FILE}.partial"

  # 源库表数（闸门基准）
  SRC_TABLES="$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -tAc \
    "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$SRC_TABLES" ] || die "${DB}：读不到源库表数（库是否存在 / 用户是否有权限）"
  [ "$SRC_TABLES" -gt 0 ] || die "${DB}：源库 public 下 0 张表，拒绝产出空备份"

  rm -f "$TMP"
  # -Fc 自定义格式：可选择性恢复、可 pg_restore -l 校验
  if ! docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB" -Fc > "$TMP" 2>"${TMP}.err"; then
    echo "✗ ${DB}：pg_dump 失败" >&2
    cat "${TMP}.err" >&2 || true
    rm -f "$TMP" "${TMP}.err"
    exit 1
  fi
  rm -f "${TMP}.err"

  # 表数闸门：归档内 TABLE DATA 条数 == 源库表数
  ARC_TABLES="$(docker exec -i "$CONTAINER" pg_restore -l < "$TMP" 2>/dev/null \
    | grep -c '^[0-9;].*TABLE DATA' || true)"
  if [ "$ARC_TABLES" != "$SRC_TABLES" ]; then
    echo "✗ ${DB}：备份表数不一致（源库 ${SRC_TABLES} / 归档 ${ARC_TABLES}），拒绝保留" >&2
    rm -f "$TMP"
    exit 1
  fi

  SIZE="$(wc -c < "$TMP" | tr -d '[:space:]')"
  [ "$SIZE" -gt 0 ] || { rm -f "$TMP"; die "${DB}：备份文件 0 字节"; }

  mv "$TMP" "$FILE"
  ( cd "$OUT" && shasum -a 256 "$(basename "$FILE")" > "$(basename "$FILE").sha256" )
  echo "✓ ${DB} → ${FILE}（${SIZE} B，${ARC_TABLES} 表）"
  OK=$((OK + 1))

  # 滚动保留：同库只留最近 KEEP 份（按文件名时间戳排序，删旧）
  ls -1t "$OUT/${DB}_"*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old" "$old.sha256"
    echo "  ↳ 清理旧备份 $(basename "${old}")"
  done
done

[ "$OK" -gt 0 ] || die "没有任何库被备份"

# ── WAL 归档巡检 + 保留清理（2026-11-04 并入） ───────────────────────────────
# 原先由 crontab 的 `20 * * * *` 独立执行，但那条在 macOS 上不可靠：实测 11-03
# 14:20 后停摆 14.5 小时无人察觉，期间归档堆到 6.3 GB 无任何清理，而日志里最后
# 一行还写着「✅ 归档正常」——不可靠的调度单元比没有更危险，因为它是虚假安全。
# 本脚本每天 04:10 已被连续验证；保留策略按 -mtime 整日粒度算，每天跑一次与每
# 小时跑一次效果等价，因此并入此处，不再单独占用一个 cron 条目。
#
# 保留天数维持 14 天（ERP_WAL_KEEP_DAYS）不缩短：基备每周日一份、保留 2 份 =
# 覆盖 14 天，WAL 保留期必须 ≥ 这个周期，否则最老那份基备会因所需 WAL 被删而
# 失去 PITR 能力。要缩短保留必须先缩基备周期，两者是绑定的。
echo "--- WAL 归档巡检（PITR）---"
PITR_RC=0
bash deploy/scripts/pg_pitr_backup.sh wal || PITR_RC=$?
[ "$PITR_RC" -eq 0 ] || die "WAL 归档巡检失败（rc=${PITR_RC}）：归档器异常会让 WAL 堆到爆盘，见上方输出"

echo "BACKUP_OK $(date '+%Y-%m-%d %H:%M:%S') 共 ${OK} 个库 → $(cd "$OUT" && pwd)；WAL 归档正常"
