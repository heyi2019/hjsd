#!/usr/bin/env bash
# 备份异地留存：把 ECS 上的正式库备份拉到本机（与库物理分离）
#
# 为什么需要：
#   backup_daily.sh 把 pg_dump 产物写在 ECS 宿主机的 ${ERP_PG_BACKUP_DIR}
#   （默认 /opt/heijin/backups），已在 docker 卷之外，但仍与库同处一台机器——
#   磁盘故障、误删机器、欠费停机都会让「库 + 备份」一起消失。本脚本把备份拉到
#   另一台机器，形成真正的异地留存。
#
# 安全语义：先落到 $DEST/.incoming 暂存区，SHA256 + 归档魔数全部通过后才原子搬到
#           $DEST。校验失败则本地目录一字不改，坏备份留在暂存区供排查。
#
# 跑在「备份实际所在的那台机器」之外即可，不依赖 ECS 上有 docker/镜像：
#   backup_daily.sh 的产物是普通文件，这里只用 ssh + tar。
#
# 用法（在本机执行）：
#   bash deploy/scripts/pull_backup.sh --host root@1.2.3.4                  # 拉到 ~/heijin_backups
#   bash deploy/scripts/pull_backup.sh --host root@1.2.3.4 --dest /Volumes/bak
#   bash deploy/scripts/pull_backup.sh --host root@1.2.3.4 --keep 14
#   bash deploy/scripts/pull_backup.sh --local-dir /opt/heijin/backups --dest /tmp/t  # 本机自测
#
# 参数：
#   --host USER@HOST    ECS 登录地址（需免密 SSH）；与 --local-dir 二选一
#   --local-dir DIR     直接从本机已有目录读（自测/同机留存用）
#   --remote-dir DIR    ECS 上的备份目录，默认 /opt/heijin/backups
#   --dest DIR          本地存放目录，默认 $HOME/heijin_backups（可用 ERP_BACKUP_DEST 覆盖）
#   --keep N            本地保留最近 N 份，默认 7（可用 ERP_BACKUP_KEEP 覆盖）
set -euo pipefail

HOST=""
LOCAL_DIR=""
REMOTE_DIR="${ERP_PG_BACKUP_DIR:-/opt/heijin/backups}"
DEST="${ERP_BACKUP_DEST:-$HOME/heijin_backups}"
KEEP="${ERP_BACKUP_KEEP:-7}"
PREFIX="heijin_erp_pg"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o LogLevel=ERROR)

usage() { sed -n '2,28p' "$0"; }

die() { echo "✗ $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host|-H)      HOST="${2:?--host 缺少值}"; shift 2 ;;
    --local-dir)    LOCAL_DIR="${2:?--local-dir 缺少值}"; shift 2 ;;
    --remote-dir)   REMOTE_DIR="${2:?--remote-dir 缺少值}"; shift 2 ;;
    --dest)         DEST="${2:?--dest 缺少值}"; shift 2 ;;
    --keep)         KEEP="${2:?--keep 缺少值}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

[ -n "$HOST" ] || [ -n "$LOCAL_DIR" ] || die "必须指定 --host user@ecs-ip 或 --local-dir DIR"
[ -z "$LOCAL_DIR" ] || [ -d "$LOCAL_DIR" ] || die "本地源目录不存在：$LOCAL_DIR"

mkdir -p "$DEST"
STAGE="$DEST/.incoming"
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "==> 拉取备份：${LOCAL_DIR:-$HOST:$REMOTE_DIR} → ${DEST}（暂存校验）"

# ---------- 1) 拉取到暂存区：远端目录 → tar 流 → $STAGE ----------
if [ -n "$LOCAL_DIR" ]; then
  tar -C "$LOCAL_DIR" -cf - . | tar -C "$STAGE" -xf - \
    || die "读取 $LOCAL_DIR 失败"
else
  # 远端目录不存在时 tar 会返回非零，这里显式转成可读的提示。
  ssh "${SSH_OPTS[@]}" "$HOST" "test -d '$REMOTE_DIR'" \
    || die "ECS 上没有 ${REMOTE_DIR}：可能还没跑过 backup_daily.sh"
  ssh "${SSH_OPTS[@]}" "$HOST" "tar -C '$REMOTE_DIR' -cf - ." | tar -C "$STAGE" -xf - \
    || die "拉取失败：检查 SSH 免密与 $REMOTE_DIR 读权限"
fi

# ---------- 2) 校验暂存区：SHA256 sidecar + pg_dump 归档魔数 ----------
shopt -s nullglob
staged=("$STAGE"/${PREFIX}_*.dump)
if [ ${#staged[@]} -eq 0 ]; then
  die "拉取成功但无 ${PREFIX}_*.dump：ECS 上可能还没跑过 backup_daily.sh"
fi

sha_ok=0; sha_bad=0; magic_bad=0
for f in "${staged[@]}"; do
  side="${f}.sha256"
  if [ -f "$side" ]; then
    expect="$(awk '{print $1}' "$side")"
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$f" | awk '{print $1}')"
    else
      actual="$(shasum -a 256 "$f" | awk '{print $1}')"
    fi
    if [ "$expect" = "$actual" ]; then
      sha_ok=$((sha_ok + 1))
    else
      echo "✗ SHA256 不匹配：$(basename "$f")" >&2
      sha_bad=$((sha_bad + 1))
    fi
  else
    echo "⚠ 缺少校验文件：$(basename "$side")" >&2
    sha_bad=$((sha_bad + 1))
  fi

  # pg_dump -Fc 的归档以 PGDMP 开头；这条能挡住「拉回来的是错误页/半截文件」。
  magic="$(head -c 5 "$f" 2>/dev/null || true)"
  if [ "$magic" != "PGDMP" ]; then
    echo "✗ 不是 pg_dump 自定义格式：$(basename "$f") → ${magic:-空}" >&2
    magic_bad=$((magic_bad + 1))
  fi
done

echo "==> 校验：SHA256 通过 ${sha_ok} 份 / 异常 ${sha_bad} 份；归档魔数异常 ${magic_bad} 份"
if [ "$sha_bad" -ne 0 ] || [ "$magic_bad" -ne 0 ]; then
  die "校验失败：本地 $DEST 未被改动；坏备份保留在 $STAGE 供排查，ECS 原始备份请勿删除"
fi

# ---------- 3) 原子提升：暂存区 → 正式目录 ----------
count=0
for f in "$STAGE"/*.dump "$STAGE"/*.sha256; do
  [ -e "$f" ] || continue
  mv -f "$f" "$DEST"/
  count=$((count + 1))
done
rm -rf "$STAGE"
echo "==> 已同步 ${count} 个文件到 $DEST"

# ---------- 4) 本地滚动保留 ----------
total="$(ls -1 "$DEST"/${PREFIX}_*.dump 2>/dev/null | wc -l | tr -d ' ')"
if [ "$total" -gt "$KEEP" ]; then
  drop=$((total - KEEP))
  # 文件名含 YYYYmmdd_HHMMSS，字典序即时间序；删最旧的 drop 份及其 sidecar
  ls -1 "$DEST"/${PREFIX}_*.dump | sort | head -n "$drop" | while read -r old; do
    rm -f "$old" "$old.sha256"
    echo "   清理旧备份 $(basename "$old")"
  done
fi

kept="$(ls -1 "$DEST"/${PREFIX}_*.dump 2>/dev/null | wc -l | tr -d ' ')"
latest="$(ls -1 "$DEST"/${PREFIX}_*.dump 2>/dev/null | sort | tail -1 || true)"
echo "==> 完成：本地共 ${kept} 份（keep=${KEEP}），最新 $(basename "${latest:-无}")"
echo "    目录：$DEST"
