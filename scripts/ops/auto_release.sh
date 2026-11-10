#!/usr/bin/env bash
# main 自动发版：递增 patch 版本，并生成本轮提交摘要。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="${1:-${RELEASE_BASE_SHA:-}}"
HEAD="${2:-${RELEASE_HEAD_SHA:-HEAD}}"
cd "$ROOT"

if [ -z "$BASE" ] || ! git rev-parse --verify "$BASE^{commit}" >/dev/null 2>&1; then
  BASE="$(git rev-parse "${HEAD}^" 2>/dev/null || true)"
fi
[ -n "$BASE" ] || BASE="$(git hash-object -t tree /dev/null)"
git rev-parse --verify "$HEAD^{commit}" >/dev/null 2>&1 || {
  echo "✗ 找不到发版终点：$HEAD" >&2
  exit 1
}

BUMP_MODE="patch"
subjects="$(git log "$BASE..$HEAD" --no-merges --format='%s%n%b')"
if printf '%s\n' "$subjects" | grep -Eq 'BREAKING CHANGE|^[a-z]+(\([^)]*\))?!:'; then
  BUMP_MODE="major"
elif printf '%s\n' "$subjects" | grep -Eq '^feat(\([^)]*\))?:'; then
  BUMP_MODE="minor"
fi

scripts/ops/bump_version.sh "$BUMP_MODE" >/tmp/heijin-auto-version.txt
NEW_VERSION="$(sed -n 's/^==> 版本 .* → \([0-9][0-9.]*\).*/\1/p' /tmp/heijin-auto-version.txt | tail -1)"
[ -n "$NEW_VERSION" ] || {
  echo "✗ 无法解析自动生成的版本号" >&2
  cat /tmp/heijin-auto-version.txt >&2
  exit 1
}

ROOT="$ROOT" BASE="$BASE" HEAD="$HEAD" VERSION="$NEW_VERSION" BUMP_MODE="$BUMP_MODE" python3 - <<'PY'
from __future__ import annotations

import datetime as dt
import os
import re
import subprocess
from pathlib import Path
from zoneinfo import ZoneInfo

root = Path(os.environ["ROOT"])
base = os.environ["BASE"]
head = os.environ["HEAD"]
version = os.environ["VERSION"]
release = root / "RELEASE.md"


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, text=True, capture_output=True, check=True
    ).stdout.strip()


raw = git("log", f"{base}..{head}", "--no-merges", "--format=%h\t%s")
commits: list[str] = []
groups = {"fix": [], "feat": [], "其他": []}
for line in raw.splitlines():
    if "\t" not in line:
        continue
    sha, subject = line.split("\t", 1)
    match = re.match(r"^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$", subject.strip())
    kind = match.group(1) if match else "其他"
    text = match.group(2) if match else subject.strip()
    item = f"- {text}（`{sha}`）"
    commits.append(item)
    groups[kind if kind in ("fix", "feat") else "其他"].append(item)

if not commits:
    commits = ["- 本轮无非合并提交，记录自动版本更新。"]

today = dt.datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S %Z")
shortstat = git("diff", "--shortstat", f"{base}..{head}") or "文件统计不可用"
lines = [
    f"## V{version}", "",
    f"**发布时间：** {today}（Asia/Shanghai）", "",
    "### 本轮提交", "",
    f"相对提交 `{base[:12]}`，共 {len(commits)} 个非合并提交；{shortstat}。", "",
]
if groups["fix"]:
    lines += ["### Bug 修复", "", *groups["fix"], ""]
if groups["feat"]:
    lines += ["### 功能更新", "", *groups["feat"], ""]
if groups["其他"]:
    lines += ["### 工程与其他变更", "", *groups["其他"], ""]
lines += [
    "### 发布结果", "",
    f"- 自动版本：`V{version}`",
    f"- 更新级别：`{os.environ.get('BUMP_MODE', 'auto')}`",
    "- CI 门禁：lint、前端构建/测试、后端核心测试",
    "- 部署：门禁全部通过后自动发布到 ECS", "", "---", "",
]
block = "\n".join(lines)
text = release.read_text("utf-8") if release.exists() else "# 发布记录\n\n"
first = re.search(r"^## V\d+\.\d+\.\d+", text, re.M)
new_text = text[: first.start()] + block + text[first.start():] if first else text.rstrip() + "\n\n" + block
release.write_text(new_text, encoding="utf-8")

summary = [
    f"### 自动发版 V{version}", "",
    f"- 更新级别：{os.environ.get('BUMP_MODE', 'auto')}",
    f"- 时间：{today}", f"- 基线：`{base}`",
    f"- 本轮提交：{len(commits)} 个", f"- 变更规模：{shortstat}", "",
]
if groups["fix"]:
    summary += ["**Bug 修复**", "", *groups["fix"], ""]
if groups["feat"]:
    summary += ["**功能更新**", "", *groups["feat"], ""]
if groups["其他"]:
    summary += ["**其他变更**", "", *groups["其他"][:20], ""]
print("\n".join(summary))
PY

cat /tmp/heijin-auto-version.txt
