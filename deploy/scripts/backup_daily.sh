#!/usr/bin/env bash
# 正式库每日在线备份（PostgreSQL / pg_dump 自定义格式，在 ECS 上由 cron 调用，也可手动执行）
#
# 背景与契约：
#   1) 正式库自 2026-11 起为 PostgreSQL（compose 的 db 服务）。历史上的 SQLite 备份链
#     （backup_db.py / heijin_erp_v1_*.db）已整体下线——继续用它只会「备份成功」一份
#      过期的 SQLite 文件，比没有备份更危险。
#   2) pg_dump 必须在 db 容器内执行：宿主与 backend 镜像（alpine）都没有 PG 客户端。
#      用户/库名直接取容器内 $POSTGRES_USER / $POSTGRES_DB，宿主机不 export 也能连对库。
#   3) 产物落在**宿主机磁盘** ${ERP_PG_BACKUP_DIR}（默认 deploy/../backups），不在 docker
#      卷里：`docker compose down -v` 或卷损坏不会把「库 + 备份」一起带走。
#   4) 每份备份 = 一个 .dump + 一个 .sha256 sidecar，滚动保留最近 N 份。
#   5) 任何一步失败必须非零退出：cron 日志要能看见，不能伪装成「今天没数据」。
#
# 用法（在 ECS 上）：
#   bash /opt/heijin/deploy/scripts/backup_daily.sh
#   ERP_BACKUP_KEEP=14 bash deploy/scripts/backup_daily.sh          # 覆盖保留份数
#   ERP_PG_BACKUP_DIR=/data/backups bash deploy/scripts/backup_daily.sh
#
# crontab（每日 03:20）：
#   20 3 * * * /bin/bash /opt/heijin/deploy/scripts/backup_daily.sh >> /var/log/heijin_backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

KEEP="${ERP_BACKUP_KEEP:-30}"
OUT="${ERP_PG_BACKUP_DIR:-../backups}"
PREFIX="heijin_erp_pg"
SERVICE="db"

die() { echo "✗ $*" >&2; exit 1; }

[ -f .env ] || die "缺少 deploy/.env（本脚本需与 docker compose 使用同一份部署配置）"

# db 服务必须已就绪：容器不在时 pg_dump 无从谈起，明确报错而不是产出空备份。
# 先把输出收进变量再判断：直接管道给 grep -qx 会在匹配首行后提前退出，上游
# docker compose 可能收到 SIGPIPE，在 set -o pipefail 下被误判成「db 未运行」。
running_services="$(docker compose ps --status running --services 2>/dev/null || true)"
if ! grep -qx "$SERVICE" <<< "$running_services"; then
  die "db 容器未运行，无法备份（先 docker compose up -d db，确认库已就绪）"
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUT"
FILE="$OUT/${PREFIX}_${STAMP}.dump"
TMP="${FILE}.partial"
TOC="${TMP}.toc"
rm -f "$TMP" "$TOC"

# 源库表数：作为「备份是否完整」的对照基准（见下面的 TOC 一致性闸门）。
# psql 随 postgres 镜像提供，走容器内 unix socket，无需宿主机凭证。
# 空库（首次部署、刚恢复前的空目标库）会返回 0，这是合法状态，不能当成失败。
SRC_TABLES="$(docker compose exec -T "$SERVICE" sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -f -' <<'SQL' | tr -dc '0-9'
select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema');
SQL
)"
[ -n "$SRC_TABLES" ] || die "无法读取源库表数（psql 失败），拒绝产出无法验证完整性的备份"

# -T + </dev/null 缺一不可：cron/无 TTY 环境下 compose exec 会 attach stdin 并永久等待，
# 表现为备份「卡住无输出」，且 cron 会堆叠出僵尸进程。
if ! docker compose exec -T "$SERVICE" sh -c \
     'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' </dev/null > "$TMP"; then
  rm -f "$TMP" "$TOC"
  die "pg_dump 失败，本次未产出备份（上一份备份保持不动）"
fi

# 完整性闸门：只比大小发现不了「pg_dump 中途被杀留下的半截归档」，故三重校验
# ①归档魔数 PGDMP ②TOC 能被 pg_restore 解析 ③归档内 TABLE 定义数 == 源库表数。
# 第 ③ 条是关键：截断/漏表的归档会在这一条暴露，而空库（0 == 0）能正常通过。
# pg_restore --list 只顺读文件头与目录，可以从 stdin 读取，无需把 dump 拷进容器。
MAGIC="$(head -c 5 "$TMP" 2>/dev/null || true)"
[ "$MAGIC" = "PGDMP" ] || { rm -f "$TMP" "$TOC"; die "产物不是 pg_dump 自定义格式（缺 PGDMP 魔数）：$MAGIC"; }

if ! docker compose exec -T "$SERVICE" pg_restore --list < "$TMP" > "$TOC" 2>/dev/null; then
  rm -f "$TMP" "$TOC"
  die "备份归档无法被 pg_restore 解析（文件可能截断），本次不保留"
fi
# TOC 里每张表有两条：`TABLE <schema> <name> <owner>` 与 `TABLE DATA <schema> <name> <owner>`。
# 只数前者（3 个字段结尾），后者字段多一个，自然不匹配。
DUMP_TABLES="$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ TABLE [^ ]+ [^ ]+ [^ ]+$' "$TOC" || true)"
OBJECTS="$(grep -cE '^[0-9]+; ' "$TOC" || true)"
if [ "$DUMP_TABLES" != "$SRC_TABLES" ]; then
  rm -f "$TMP" "$TOC"
  die "备份表数不一致：源库 ${SRC_TABLES} 张，归档仅 ${DUMP_TABLES} 张（疑似截断或连错库），本次不保留"
fi
[ "$SRC_TABLES" -eq 0 ] && echo "⚠ 源库当前是空库（0 张业务表），本次产出的是一份空备份" >&2
rm -f "$TOC"

mv -f "$TMP" "$FILE"
SIZE="$(wc -c < "$FILE" | tr -d ' ')"

# 校验和 sidecar：与 pull_backup.sh / restore_pg.sh 共用同一格式（sha256sum 标准两列）。
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$OUT" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256" )
elif command -v shasum >/dev/null 2>&1; then
  ( cd "$OUT" && shasum -a 256 "$(basename "$FILE")" > "$(basename "$FILE").sha256" )
else
  rm -f "$FILE"
  die "既无 sha256sum 也无 shasum，无法生成校验和 sidecar"
fi
DIGEST="$(awk '{print $1}' "$FILE.sha256")"

# 滚动保留：文件名含 YYYYmmdd_HHMMSS，字典序即时间序。先算要删多少份再删最旧，
# 避免依赖 GNU 专有的 `head -n -N`（macOS/BSD 不支持）。
TOTAL="$(ls -1 "$OUT"/${PREFIX}_*.dump 2>/dev/null | wc -l | tr -d ' ')"
if [ "$TOTAL" -gt "$KEEP" ]; then
  DROP=$((TOTAL - KEEP))
  ls -1 "$OUT"/${PREFIX}_*.dump | sort | head -n "$DROP" | while read -r old; do
    rm -f "$old" "$old.sha256"
    echo "   清理旧备份 $(basename "$old")"
  done
fi

echo "BACKUP_OK path=$FILE size=$SIZE objects=$OBJECTS sha256=$DIGEST keep=$KEEP"
