#!/usr/bin/env bash
# 正式库恢复（PostgreSQL / pg_restore），与 backup_daily.sh 配套。
#
# 安全语义（按重要性递增）：
#   1) 校验和先行：有 .sha256 sidecar 时必须匹配，不匹配直接拒收（防篡改/截断）。
#   2) 目录可解析：pg_restore --list 必须读出 TOC 且含 schema 对象，否则拒收。
#   3) 恢复前自动再备份一份当前库：误恢复本身也是一次事故，需要「退回去」的路径。
#   4) --single-transaction：恢复要么整体成功、要么库保持原样，不会留下半套表。
#   5) 恢复期间停 backend：库里有活跃连接时 DROP/建表会互相阻塞。
#
# 为什么先把 dump 拷进 db 容器：pg_restore 恢复自定义格式需要可寻址输入，
# 从 stdin/管道读会报 `could not seek in file`。列表（--list）可以走 stdin，恢复不行。
#
# 用法（在 ECS 的 deploy 目录或任意目录）：
#   bash deploy/scripts/restore_pg.sh --backup /opt/heijin/backups/heijin_erp_pg_20261102_032000.dump --yes
#   bash deploy/scripts/restore_pg.sh --backup xx.dump --yes --no-pre-backup
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

BACKUP=""
CONFIRMED=0
PRE_BACKUP=1
SERVICE="db"
BACKUP_SERVICE="backend"

die() { echo "✗ $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --backup|-b)       BACKUP="${2:?--backup 缺少值}"; shift 2 ;;
    --yes|-y)          CONFIRMED=1; shift ;;
    --no-pre-backup)   PRE_BACKUP=0; shift ;;
    -h|--help)         sed -n '2,22p' "$0"; exit 0 ;;
    *)                 die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

[ -n "$BACKUP" ] || die "必须指定 --backup <备份文件>"
[ -f "$BACKUP" ] || die "备份文件不存在：$BACKUP"
[ "$CONFIRMED" -eq 1 ] || die "恢复会覆盖正式库现有全部数据，请显式加 --yes 确认"
[ -f .env ] || die "缺少 deploy/.env（本脚本需与 docker compose 使用同一份部署配置）"

if ! docker compose ps --status running --services 2>/dev/null | grep -qx "$SERVICE"; then
  die "db 容器未运行（先 docker compose up -d db）"
fi

# ---------- 1) 校验和 ----------
SIDECAR="${BACKUP}.sha256"
if [ -f "$SIDECAR" ]; then
  EXPECT="$(awk '{print $1}' "$SIDECAR")"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$BACKUP" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$BACKUP" | awk '{print $1}')"
  else
    die "既无 sha256sum 也无 shasum，无法校验备份完整性"
  fi
  [ "$EXPECT" = "$ACTUAL" ] || die "校验和不匹配：期望 ${EXPECT}，实得 ${ACTUAL}（备份可能损坏，拒绝恢复）"
  echo "==> 校验和通过：$ACTUAL"
else
  echo "⚠ 未找到 ${SIDECAR##*/}，跳过校验和比对（仅做归档解析校验）" >&2
fi

# ---------- 2) 归档可解析 ----------
TMP_TOC="$(mktemp)"
if ! docker compose exec -T "$SERVICE" pg_restore --list < "$BACKUP" > "$TMP_TOC" 2>/dev/null; then
  rm -f "$TMP_TOC"
  die "备份归档无法被 pg_restore 解析（文件可能截断或格式不对）"
fi
if ! grep -qE '^[0-9]+; .* (TABLE|SEQUENCE|TYPE|SCHEMA) ' "$TMP_TOC"; then
  rm -f "$TMP_TOC"
  die "备份归档中没有任何 schema 对象，疑似空备份，拒绝恢复"
fi
OBJECTS="$(grep -cE '^[0-9]+; ' "$TMP_TOC" || true)"
rm -f "$TMP_TOC"
echo "==> 归档可解析：$OBJECTS 个对象"

# ---------- 3) 恢复前再备份当前库 ----------
if [ "$PRE_BACKUP" -eq 1 ]; then
  echo "==> 恢复前先备份当前库（失败则中止，避免失去退回路径）"
  bash scripts/backup_daily.sh || die "恢复前备份失败，已中止恢复（当前库未被改动）"
fi

# ---------- 4) 停 backend → 拷入 dump → 单事务恢复 ----------
CID="$(docker compose ps -q "$SERVICE" 2>/dev/null | head -1)"
[ -n "$CID" ] || die "取不到 db 容器 ID，无法注入备份文件"
INNER="/tmp/erp_restore_$$.dump"

BACKEND_STOPPED=0
cleanup() {
  docker exec "$CID" rm -f "$INNER" >/dev/null 2>&1 || true
  if [ "$BACKEND_STOPPED" -eq 1 ]; then
    echo "==> 重新启动 backend"
    docker compose start "$BACKUP_SERVICE" >/dev/null 2>&1 \
      || echo "⚠ backend 未能自动启动，请手动 docker compose up -d backend" >&2
  fi
}
trap cleanup EXIT

echo "==> 停止 backend（避免恢复期间活跃连接阻塞 DROP/建表）"
if docker compose ps --status running --services 2>/dev/null | grep -qx "$BACKUP_SERVICE"; then
  docker compose stop "$BACKUP_SERVICE" >/dev/null
  BACKEND_STOPPED=1
fi

echo "==> 拷贝备份进 db 容器：$INNER"
docker cp "$BACKUP" "$CID:$INNER" >/dev/null

echo "==> pg_restore（--clean --if-exists --single-transaction）"
docker compose exec -T "$SERVICE" sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges --single-transaction "'"$INNER"'"' \
  || die "pg_restore 失败：--single-transaction 已回滚，库保持恢复前状态"

echo "RESTORE_OK target=postgresql source=${BACKUP##*/} objects=$OBJECTS"
echo "    迁移版本随备份回滚；如备份来自旧版本，请再执行 alembic upgrade head"
