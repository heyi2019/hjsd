#!/usr/bin/env bash
# 离线镜像导出：在任意能联网的机器上交叉构建 linux/amd64 镜像，打包成可 scp 的 tar.gz。
#
# 为什么需要它：ECS 上 `docker compose build` 隐含四个外部依赖——Docker Hub（基础镜像）、
# alpine 源（apk add）、pypi（pip install）、npm（npm ci）。任一条不通，构建就断在
# Dockerfile 的某一行，而报错位置看起来总像代码问题。离线包把它们压成一次 docker load。
#
# 用法：
#   bash deploy/scripts/export_images.sh                    # 构建 + 导出到 ~/Desktop
#   bash deploy/scripts/export_images.sh --no-build         # 只导出本地已有镜像
#   bash deploy/scripts/export_images.sh --out-dir /tmp/imgs
#
# 产物（ECS 侧用法见 --help 末尾）：
#   heijin-images-<VERSION>-amd64.tar.gz          约 90-120 MB
#   heijin-images-<VERSION>-amd64.tar.gz.sha256
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

OUT_DIR="$HOME/Desktop"
DO_BUILD=1
PLATFORM="linux/amd64"

usage() { sed -n '2,20p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) OUT_DIR="${2:?--out-dir 需要目录参数}"; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    --platform) PLATFORM="${2:?--platform 需要平台参数}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ 未知参数：${1}" >&2; usage >&2; exit 2 ;;
  esac
done

VERSION="$(tr -d '\r\n' < VERSION)"
if [ -z "$VERSION" ]; then
  echo "✗ 无法从 VERSION 读取项目版本" >&2
  exit 1
fi
echo "==> 发布版本 V${VERSION}，目标平台 ${PLATFORM}"

mkdir -p "$OUT_DIR"

if [ "$DO_BUILD" = "1" ]; then
  echo "==> 交叉构建后端镜像"
  docker buildx build --platform "$PLATFORM" -f backend/Dockerfile . \
    -t "heijin-backend:${VERSION}" --load
  echo "==> 交叉构建前端镜像"
  # 前端构建上下文是仓库根（需读取 backend/app/enums.py 做枚举对齐校验）
  docker buildx build --platform "$PLATFORM" -f frontend/Dockerfile . \
    -t "heijin-frontend:${VERSION}" --load
fi

for svc in backend frontend; do
  img="heijin-${svc}:${VERSION}"
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "✗ 本机不存在 ${img}，去掉 --no-build 让脚本构建" >&2
    exit 1
  fi
  # 导出前再确认一次架构：arm64 的包传到 ECS 只会得到 exec format error
  arch="$(docker image inspect "$img" --format '{{.Architecture}}')"
  case "$PLATFORM" in
    *amd64) [ "$arch" = "amd64" ] || { echo "✗ ${img} 是 ${arch}，与目标 ${PLATFORM} 不符" >&2; exit 1; } ;;
    *arm64) [ "$arch" = "arm64" ] || { echo "✗ ${img} 是 ${arch}，与目标 ${PLATFORM} 不符" >&2; exit 1; } ;;
  esac
  echo "  ✓ ${img} (${arch})"
done

ARCH_SUFFIX="$(echo "$PLATFORM" | sed 's#.*/##')"
PKG="heijin-images-${VERSION}-${ARCH_SUFFIX}.tar.gz"
echo "==> 导出到 ${OUT_DIR}/${PKG}（压缩中，约 1-3 分钟）"
docker save "heijin-backend:${VERSION}" "heijin-frontend:${VERSION}" | gzip -9 > "${OUT_DIR}/${PKG}"

# macOS 只有 shasum，Linux 只有 sha256sum；两边都试，都不在则跳过校验文件而不是失败
cd "$OUT_DIR"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$PKG" > "${PKG}.sha256"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$PKG" > "${PKG}.sha256"
else
  echo "⚠ 未找到 sha256sum / shasum，跳过校验文件" >&2
fi

SIZE="$(du -h "${OUT_DIR}/${PKG}" | awk '{print $1}')"
echo
echo "✓ 导出完成：${OUT_DIR}/${PKG}  (${SIZE})"
echo
echo "ECS 上导入并部署（不需要能访问 Docker Hub / pypi / npm）："
echo "  scp ${OUT_DIR}/${PKG}* root@<ECS_IP>:/opt/heijin/"
echo "  ssh root@<ECS_IP>"
echo "  cd /opt/heijin"
echo "  sha256sum -c ${PKG}.sha256        # 可选但建议，确认传输未损坏"
echo "  gunzip -c ${PKG} | docker load"
echo "  cd deploy && export ADMIN_PASSWORD='<强密码>' && ERP_SKIP_BUILD=1 bash scripts/deploy.sh"
