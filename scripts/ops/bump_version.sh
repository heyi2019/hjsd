#!/usr/bin/env bash
# 管理项目统一版本（VERSION）；发布记录由 auto_release.sh 或 changelog.sh 生成。
#
# 用法：
#   scripts/ops/bump_version.sh --check          检查项目版本格式
#   scripts/ops/bump_version.sh patch|minor|major 递增对应版本号
#   scripts/ops/bump_version.sh 1.2.3            指定项目版本
#   scripts/ops/bump_version.sh --tag            为已提交的当前版本打标签
#   加 --dry-run 仅预览，不修改版本或标签
set -euo pipefail

VERSION_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION_PYTHON="${PYTHON:-python3}"
command -v "$VERSION_PYTHON" >/dev/null 2>&1 || { echo "✗ 需要 python3" >&2; exit 1; }

VERSION_BUMP_MODE=""
VERSION_BUMP_TARGET=""
VERSION_DRY_RUN="0"
VERSION_MAKE_TAG="0"
for arg in "$@"; do
  case "$arg" in
    --check) VERSION_BUMP_MODE="check" ;;
    --dry-run) VERSION_DRY_RUN="1" ;;
    --tag) VERSION_MAKE_TAG="1" ;;
    major|minor|patch) VERSION_BUMP_MODE="$arg" ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    [0-9]*.[0-9]*.[0-9]*) VERSION_BUMP_MODE="set"; VERSION_BUMP_TARGET="$arg" ;;
    *) echo "✗ 未知参数：${arg}（--help 看用法）" >&2; exit 2 ;;
  esac
done

if [ "$VERSION_MAKE_TAG" = "1" ]; then
  [ -z "$VERSION_BUMP_MODE" ] || { echo "✗ 请先升版并提交，再单独运行 --tag" >&2; exit 2; }
  VERSION_BUMP_MODE="tag"
fi
[ -n "$VERSION_BUMP_MODE" ] || { echo "✗ 缺少参数：patch|minor|major|x.y.z|--check|--tag" >&2; exit 2; }

VERSION_REPO_ROOT="$VERSION_REPO_ROOT" VERSION_BUMP_MODE="$VERSION_BUMP_MODE" \
VERSION_BUMP_TARGET="$VERSION_BUMP_TARGET" VERSION_DRY_RUN="$VERSION_DRY_RUN" "$VERSION_PYTHON" - <<'PY'
import os
import re
import sys
from pathlib import Path

path = Path(os.environ["VERSION_REPO_ROOT"]) / "VERSION"
if not path.is_file():
    sys.exit(f"✗ 缺少项目版本文件：{path}")
current = path.read_text(encoding="utf-8").strip()
if not re.fullmatch(r"\d+\.\d+\.\d+", current):
    sys.exit(f"✗ 项目版本 {current!r} 必须是 x.y.z 格式")

mode = os.environ["VERSION_BUMP_MODE"]
if mode == "check":
    print(f"✓ 项目版本：{current}")
    sys.exit(0)
if mode == "tag":
    sys.exit(0)

major, minor, patch = (int(part) for part in current.split("."))
if mode == "major":
    new = f"{major + 1}.0.0"
elif mode == "minor":
    new = f"{major}.{minor + 1}.0"
elif mode == "patch":
    new = f"{major}.{minor}.{patch + 1}"
else:
    new = os.environ["VERSION_BUMP_TARGET"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", new):
        sys.exit(f"✗ 目标版本 {new!r} 必须是 x.y.z 格式")
if new == current:
    sys.exit(f"! 目标版本与当前相同（{current}），未做任何改动")

dry = os.environ["VERSION_DRY_RUN"] == "1"
print(f"==> 版本 {current} → {new}" + ("（dry-run，未写文件）" if dry else ""))
if not dry:
    path.write_text(f"{new}\n", encoding="utf-8")
    print(f"✓ 项目版本已更新为 {new}")
PY

if [ "$VERSION_BUMP_MODE" = "tag" ]; then
  VERSION_CURRENT="$(tr -d '\r\n' < "$VERSION_REPO_ROOT/VERSION")"
  VERSION_COMMITTED="$(git -C "$VERSION_REPO_ROOT" show HEAD:VERSION 2>/dev/null | tr -d '\r\n' || true)"
  [ "$VERSION_CURRENT" = "$VERSION_COMMITTED" ] || { echo "✗ 请先提交当前 VERSION，再打标签" >&2; exit 1; }
  if git -C "$VERSION_REPO_ROOT" rev-parse -q --verify "refs/tags/v${VERSION_CURRENT}" >/dev/null; then
    echo "✗ tag v${VERSION_CURRENT} 已存在，未重复创建" >&2
    exit 1
  fi
  if [ "$VERSION_DRY_RUN" = "1" ]; then
    echo "==> 将为当前提交创建 tag v${VERSION_CURRENT}（dry-run）"
  else
    git -C "$VERSION_REPO_ROOT" tag -a "v${VERSION_CURRENT}" -m "V${VERSION_CURRENT}"
    echo "✓ 已创建 tag v${VERSION_CURRENT}"
  fi
fi
