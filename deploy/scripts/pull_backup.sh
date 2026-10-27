#!/usr/bin/env bash
# 备份异地留存：把 ECS 上正式库的备份拉到本机（与库物理分离）
#
# 为什么需要：
#   deploy.sh / backup_daily.sh 的备份写在容器 /app/data/backups，与正式库同处一个
#   Docker 卷。`docker compose down -v`、卷损坏或磁盘故障会让「库 + 备份」一起消失，
#   只能防部署失败，不能算灾备。本脚本把备份流式拉到另一台机器，形成真正的异地留存。
#
# 安全语义：先落到 $DEST/.incoming 暂存区，SHA256 + integrity_check 全部通过后
#          才原子替换到 $DEST。校验失败则本地目录一字不改，坏备份留在暂存区供排查。
#
# 用法（在本机执行，不依赖 ECS 上的 tar/python）：
#   bash deploy/scripts/pull_backup.sh --host root@1.2.3.4                    # 拉到 ~/heijin_backups
#   bash deploy/scripts/pull_backup.sh --host root@1.2.3.4 --dest /Volumes/bak
#   bash deploy/scripts/pull_backup.sh --host root@1.2.3.4 --keep 14
#   bash deploy/scripts/pull_backup.sh --local-volume deploy_erp_db --dest /tmp/t   # 本机自测
#
# 参数：
#   --host USER@HOST   ECS 登录地址（需免密 SSH）；与 --local-volume 二选一
#   --local-volume N   直接从本机同名 Docker 卷读（本机自测/同机留存用）
#   --volume NAME      ECS 上的卷名，默认 ${COMPOSE_PROJECT_NAME:-deploy}_erp_db
#   --dest DIR         本地存放目录，默认 $HOME/heijin_backups（可用 ERP_BACKUP_DEST 覆盖）
#   --keep N           本地保留最近 N 份，默认 30（可用 ERP_BACKUP_KEEP 覆盖）
set -euo pipefail

HOST=""
LOCAL_VOLUME=""
DEST="${ERP_BACKUP_DEST:-$HOME/heijin_backups}"
VOLUME="${COMPOSE_PROJECT_NAME:-deploy}_erp_db"
KEEP="${ERP_BACKUP_KEEP:-30}"
IMAGE="${ERP_BACKUP_IMAGE:-}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o LogLevel=ERROR)

usage() { sed -n '2,23p' "$0"; }

die() { echo "✗ $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host|-H)      HOST="${2:?--host 缺少值}"; shift 2 ;;
    --local-volume) LOCAL_VOLUME="${2:?--local-volume 缺少值}"; shift 2 ;;
    --volume)       VOLUME="${2:?--volume 缺少值}"; shift 2 ;;
    --dest)         DEST="${2:?--dest 缺少值}"; shift 2 ;;
    --keep)         KEEP="${2:?--keep 缺少值}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

[ -n "$HOST" ] || [ -n "$LOCAL_VOLUME" ] || die "必须指定 --host user@ecs-ip 或 --local-volume NAME"
command -v docker >/dev/null 2>&1 || die "本机未安装 docker"

mkdir -p "$DEST"
STAGE="$DEST/.incoming"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# ---------- 1) 拉取到暂存区：远端卷 → tar 流 → $STAGE ----------
# 用容器挂卷打包，避免依赖 ECS 宿主机的 tar 与卷路径知识。
#
# 镜像不能写死 alpine:3.20：国内 ECS 普遍拉不动 Docker Hub（报
# `failed to decode referrers index` / TLS timeout），而备份脚本恰恰只在无法联网时最需要。
# heijin-backend 自身就基于 alpine:3.20，含 sh/tar，可等价代替读卷镜像——
# 它必然已在机器上（否则服务根本起不来）。故按「显式指定 → alpine → 已部署后端镜像」探测。
resolve_image() {
  local cands
  if [ -n "$LOCAL_VOLUME" ]; then
    for cand in alpine:3.20 $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^heijin-backend:' | head -1); do
      if docker image inspect "$cand" >/dev/null 2>&1; then echo "$cand"; return 0; fi
    done
    return 1
  fi
  ssh "${SSH_OPTS[@]}" "$HOST" 'for cand in alpine:3.20 $(docker images --format "{{.Repository}}:{{.Tag}}" | grep -E "^heijin-backend:" | head -1); do if docker image inspect "$cand" >/dev/null 2>&1; then echo "$cand"; exit 0; fi; done; exit 1'
}

if [ -z "$IMAGE" ]; then
  if ! IMAGE="$(resolve_image)"; then
    die "找不到可用于读卷的镜像（既无 alpine:3.20 也无 heijin-backend）
  可显式指定：ERP_BACKUP_IMAGE=<镜像> bash $0 ..."
  fi
fi
echo "==> 读卷镜像：${IMAGE}"

echo "==> 拉取备份：${LOCAL_VOLUME:+local 卷 $LOCAL_VOLUME}${HOST:+$HOST 卷 $VOLUME} → ${DEST}（暂存校验）"

read_remote() {
  if [ -n "$LOCAL_VOLUME" ]; then
    docker run --rm -v "${LOCAL_VOLUME}:/d:ro" "$IMAGE" \
      sh -c 'test -d /d/backups && tar -C /d/backups -cf - . || { echo "NO_BACKUP_DIR" >&2; exit 3; }'
  else
    ssh "${SSH_OPTS[@]}" "$HOST" \
      "docker run --rm -v ${VOLUME}:/d:ro ${IMAGE} sh -c 'test -d /d/backups && tar -C /d/backups -cf - . || { echo NO_BACKUP_DIR >&2; exit 3; }'"
  fi
}

if ! read_remote | tar -C "$STAGE" -xf -; then
  die "拉取失败：检查 SSH 免密、卷名 ${VOLUME} 是否存在、ECS 上是否已有备份"
fi

# ---------- 2) 校验暂存区：SHA256 sidecar + SQLite integrity_check ----------
shopt -s nullglob
staged=("$STAGE"/heijin_erp_v1_*.db)
if [ ${#staged[@]} -eq 0 ]; then
  die "拉取成功但无 heijin_erp_v1_*.db：ECS 上可能还没跑过 backup_daily.sh"
fi

sha_ok=0; sha_bad=0; integ_bad=0
for db in "${staged[@]}"; do
  side="${db}.sha256"
  if [ -f "$side" ]; then
    expect="$(awk '{print $1}' "$side")"
    actual="$( (command -v shasum >/dev/null && shasum -a 256 "$db") || sha256sum "$db" )"
    actual="${actual%% *}"
    if [ "$expect" = "$actual" ]; then
      sha_ok=$((sha_ok + 1))
    else
      echo "✗ SHA256 不匹配：$(basename "$db")" >&2
      sha_bad=$((sha_bad + 1))
    fi
  else
    echo "⚠ 缺少校验文件：$(basename "$side")" >&2
    sha_bad=$((sha_bad + 1))
  fi

  if command -v sqlite3 >/dev/null 2>&1; then
    res="$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1 | head -1 || true)"
    [ "$res" = "ok" ] || { echo "✗ integrity_check 异常：$(basename "$db") → $res" >&2; integ_bad=$((integ_bad + 1)); }
  fi
done

echo "==> 校验：SHA256 通过 ${sha_ok} 份 / 异常 ${sha_bad} 份；integrity 异常 ${integ_bad} 份"
if [ "$sha_bad" -ne 0 ] || [ "$integ_bad" -ne 0 ]; then
  die "校验失败：本地 $DEST 未被改动；坏备份保留在 $STAGE 供排查，ECS 原始备份请勿删除"
fi

# ---------- 3) 原子提升：暂存区 → 正式目录 ----------
# 只搬 .db 与 .sha256。历史上的备份可能带 -wal/-shm 影子文件（旧版 backup_db.py 遗留），
# 单带主文件才安全：主文件 + sidecar 是自洽单元，混入 -wal 反而会掩盖「主文件不全」。
count=0
for f in "$STAGE"/*.db "$STAGE"/*.sha256; do
  [ -e "$f" ] || continue
  mv -f "$f" "$DEST"/
  count=$((count + 1))
done
shadows=("$STAGE"/*-wal "$STAGE"/*-shm)
if [ ${#shadows[@]} -gt 0 ]; then
  echo "⚠ 丢弃 WAL 影子文件 ${#shadows[@]} 个（备份应为单文件；ECS 上备份工具建议升级）"
fi
rm -rf "$STAGE"
echo "==> 已同步 ${count} 个文件到 $DEST"

# ---------- 4) 本地滚动保留 ----------
total=$(ls -1 "$DEST"/heijin_erp_v1_*.db 2>/dev/null | wc -l | tr -d ' ')
if [ "$total" -gt "$KEEP" ]; then
  drop=$((total - KEEP))
  # 文件名含 YYYYmmdd_HHMMSS，字典序即时间序；删最旧的 drop 份及其 sidecar
  ls -1 "$DEST"/heijin_erp_v1_*.db | sort | head -n "$drop" | while read -r old; do
    rm -f "$old" "${old}.sha256"
    echo "   清理旧备份 $(basename "$old")"
  done
fi

kept=$(ls -1 "$DEST"/heijin_erp_v1_*.db 2>/dev/null | wc -l | tr -d ' ')
latest=$(ls -1 "$DEST"/heijin_erp_v1_*.db 2>/dev/null | sort | tail -1 || true)
echo "==> 完成：本地共 ${kept} 份（keep=${KEEP}），最新 $(basename "${latest:-无}")"
echo "    目录：$DEST"
