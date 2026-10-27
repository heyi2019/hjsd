#!/usr/bin/env bash
# 一键升版本号：一次改齐三处，避免前后端漂移。
#
#   backend/app/version.py       ← 唯一事实源（deploy.sh 从这里解析镜像 tag）
#   frontend/package.json        ← 前端包版本
#   frontend/package-lock.json   ← 根包版本（漏改会让 npm ci 结果与 package.json 不符）
#
# 用法：
#   scripts/ops/bump_version.sh --check         只校验三处是否一致（CI 可用，不写文件）
#   scripts/ops/bump_version.sh patch           1.1.0 → 1.1.1（修 bug）
#   scripts/ops/bump_version.sh minor           1.1.0 → 1.2.0（加功能，向后兼容）
#   scripts/ops/bump_version.sh major           1.1.0 → 2.0.0（不兼容变更）
#   scripts/ops/bump_version.sh 1.2.3           直接指定目标版本
#   加 --dry-run 只打印将要做的改动，不落盘；
#   加 --tag     改完后自动打 annotated tag（v 前缀），tag 已存在则报错退出。
#
# 本脚本只改版本号与 tag，不 commit、不写 RELEASE.md —— 发布说明需要人写。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || { echo "✗ 需要 python3（可用 PYTHON=... 指定）" >&2; exit 1; }

MODE=""
TARGET=""
DRY_RUN="0"
MAKE_TAG="0"
CHECK_ONLY="0"

for arg in "$@"; do
  case "$arg" in
    --check)   MODE="check"; CHECK_ONLY="1" ;;
    --dry-run) DRY_RUN="1" ;;
    --tag)     MAKE_TAG="1" ;;
    major|minor|patch) MODE="$arg" ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    [0-9]*.[0-9]*.[0-9]*) MODE="set"; TARGET="$arg" ;;
    *) echo "✗ 未知参数：${arg}（--help 看用法）" >&2; exit 2 ;;
  esac
done

[ -n "$MODE" ] || { echo "✗ 缺少参数：patch|minor|major|x.y.z|--check" >&2; exit 2; }

ROOT="$ROOT" MODE="$MODE" TARGET="$TARGET" DRY_RUN="$DRY_RUN" "$PY" - <<'PY'
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

root = Path(os.environ["ROOT"])
mode = os.environ["MODE"]
target = os.environ["TARGET"]
dry = os.environ["DRY_RUN"] == "1"

version_py = root / "backend" / "app" / "version.py"
pkg_path = root / "frontend" / "package.json"
lock_path = root / "frontend" / "package-lock.json"

for p in (version_py, pkg_path, lock_path):
    if not p.is_file():
        sys.exit(f"✗ 缺少文件：{p}")

SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def read_version_py() -> str:
    m = re.search(r'^__version__ = "(.+)"$', version_py.read_text("utf-8"), re.M)
    if not m:
        sys.exit(f'✗ {version_py} 里找不到 __version__ = "x.y.z"')
    return m.group(1)


def read_json_versions() -> tuple[str, str]:
    pkg = json.loads(pkg_path.read_text("utf-8"))["version"]
    lock = json.loads(lock_path.read_text("utf-8"))
    return pkg, lock["packages"][""]["version"]


current = read_version_py()
pkg_v, lock_v = read_json_versions()

if mode == "check":
    ok = pkg_v == current and lock_v == current
    print(f"  backend/app/version.py      {current}")
    print(f"  frontend/package.json       {pkg_v}")
    print(f"  frontend/package-lock.json  {lock_v}")
    if not ok:
        print("✗ 版本不一致，请运行 scripts/ops/bump_version.sh <patch|minor|major|x.y.z>", file=sys.stderr)
        sys.exit(1)
    print("✓ 三处一致")
    sys.exit(0)

if not SEMVER.fullmatch(current):
    sys.exit(f"✗ 当前版本 {current!r} 不是 x.y.z 形式，先手工修正")

major, minor, patch = (int(x) for x in current.split("."))
if mode == "major":
    new = f"{major + 1}.0.0"
elif mode == "minor":
    new = f"{major}.{minor + 1}.0"
elif mode == "patch":
    new = f"{major}.{minor}.{patch + 1}"
elif mode == "set":
    if not SEMVER.fullmatch(target):
        sys.exit(f"✗ 目标版本 {target!r} 必须是 x.y.z（不带 v 前缀）")
    new = target
else:
    sys.exit(f"✗ 未知模式 {mode}")

if new == current:
    sys.exit(f"! 目标版本与当前相同（{current}），未做任何改动")

# ---- 替换：version.py 单点；package.json 顶层首个；package-lock 根段前两处 ----
v_text = version_py.read_text("utf-8")
v_new, n_v = re.subn(r'^__version__ = ".*"$', f'__version__ = "{new}"', v_text, count=1, flags=re.M)
if n_v != 1:
    sys.exit("✗ version.py 替换失败（__version__ 行形态已变？）")

pkg_text = pkg_path.read_text("utf-8")
pkg_new, n_pkg = re.subn(r'"version": "[^"]*"', f'"version": "{new}"', pkg_text, count=1)
if n_pkg != 1:
    sys.exit("✗ package.json 替换失败")

lock_text = lock_path.read_text("utf-8")
lock_new, n_lock = re.subn(r'"version": "[^"]*"', f'"version": "{new}"', lock_text, count=2)
if n_lock != 2:
    sys.exit(f"✗ package-lock.json 期望替换 2 处（顶层 + 根包），实际 {n_lock} 处，已中止")

# ---- 落盘前先校验替换结果可解析且三处一致（防正则改坏 JSON）----
def verify(pkg_s: str, lock_s: str) -> None:
    got_pkg = json.loads(pkg_s)["version"]
    got_lock = json.loads(lock_s)
    assert got_pkg == new, f"package.json={got_pkg}"
    assert got_lock["version"] == new, f"lock 顶层={got_lock['version']}"
    assert got_lock["packages"][""]["version"] == new, "lock 根包未同步"

verify(pkg_new, lock_new)

print(f"==> 版本 {current} → {new}" + ("（dry-run，未写文件）" if dry else ""))
if dry:
    print("  backend/app/version.py / frontend/package.json / frontend/package-lock.json")
    sys.exit(0)

version_py.write_text(v_new, "utf-8")
pkg_path.write_text(pkg_new, "utf-8")
lock_path.write_text(lock_new, "utf-8")

# 读回复核（写盘后重新解析，不信任内存里的字符串）
pkg_v2, lock_v2 = read_json_versions()
if not (read_version_py() == pkg_v2 == lock_v2 == new):
    sys.exit("✗ 写盘后复核不一致，请检查工作区")
print("✓ 三处已同步为 " + new)
PY

if [ "$MAKE_TAG" = "1" ] && [ "$DRY_RUN" != "1" ]; then
  NEW_VERSION="$("$PY" -c "
import re,pathlib
p=pathlib.Path('$ROOT/backend/app/version.py')
print(re.search(r'^__version__ = \"(.+)\"$', p.read_text('utf-8'), re.M).group(1))
")"
  if git -C "$ROOT" rev-parse -q --verify "refs/tags/v${NEW_VERSION}" >/dev/null; then
    echo "✗ tag v${NEW_VERSION} 已存在，未重复创建" >&2
    exit 1
  fi
  git -C "$ROOT" tag -a "v${NEW_VERSION}" -m "V${NEW_VERSION}"
  echo "✓ 已创建 tag v${NEW_VERSION}（指向当前 HEAD，请确认改动已提交）"
fi

[ "$CHECK_ONLY" = "1" ] && exit 0

cat <<'TIP'

后续（脚本不代做）：
  1) 更新 RELEASE.md：新增 V<新版本> 章节，写清相对上一版的变更
  2) git add backend/app/version.py frontend/package.json frontend/package-lock.json RELEASE.md
     git commit -m "release: v<新版本> ..."
  3) scripts/ops/bump_version.sh --tag 可代打 tag；或手动 git tag -a v<新版本>
  4) 部署无需改配置：deploy.sh 从 version.py 解析，镜像 tag 与 /health 自动跟随
TIP
