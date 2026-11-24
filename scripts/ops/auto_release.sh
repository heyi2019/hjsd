#!/usr/bin/env bash
# main 自动发版：按提交类型递增项目版本，并生成本轮提交摘要。
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
selected_version="$(printf '%s\n' "$subjects" | sed -n 's/^Release-Version:[[:space:]]*//p' | sed -n '1{s/[[:space:]]*$//;p;}')"
if printf '%s\n' "$subjects" | grep -Eq 'BREAKING CHANGE|^[a-z]+(\([^)]*\))?!:'; then
  BUMP_MODE="major"
elif printf '%s\n' "$subjects" | grep -Eq '^feat(\([^)]*\))?:'; then
  BUMP_MODE="minor"
fi

base_version="$(git show "${BASE}:VERSION" 2>/dev/null | tr -d '\r\n' || true)"
if [ -z "$base_version" ]; then
  # 首次引入 VERSION 时，旧基线仍从历史版 version.py 读取，避免误判为手动指定。
  base_version="$(git show "${BASE}:backend/app/version.py" 2>/dev/null | sed -n 's/^__version__ = "\(.*\)"$/\1/p' | head -1 || true)"
fi
head_version="$(git show "${HEAD}:VERSION" 2>/dev/null | tr -d '\r\n' || true)"
current_version="$(tr -d '\r\n' < VERSION)"
if [ -n "$head_version" ] && [ "$head_version" != "$current_version" ]; then
  echo "✗ VERSION 与发版提交不一致，无法生成发布记录" >&2
  exit 1
fi

if printf '%s\n' "$subjects" | grep -q '^Release-Version:'; then
  [ "$selected_version" = "$current_version" ] || {
    echo "✗ Release-Version 与项目 VERSION 不一致" >&2
    exit 1
  }
  scripts/ops/bump_version.sh --check >/dev/null
  NEW_VERSION="$selected_version"
  BUMP_MODE="manual"
  version_output="==> 使用指定项目版本 ${NEW_VERSION}"
elif [ -n "$base_version" ] && [ -n "$head_version" ] && [ "$base_version" != "$head_version" ]; then
  scripts/ops/bump_version.sh --check >/dev/null
  NEW_VERSION="$head_version"
  BUMP_MODE="manual"
  version_output="==> 使用指定项目版本 ${base_version} → ${NEW_VERSION}"
else
  version_preview="$(scripts/ops/bump_version.sh "$BUMP_MODE" --dry-run)"
  NEW_VERSION="$(printf '%s\n' "$version_preview" | sed -n 's/^==> 版本 .* → \([0-9][0-9.]*\).*/\1/p' | tail -1)"
  [ -n "$NEW_VERSION" ] || {
    echo "✗ 无法解析自动生成的版本号" >&2
    printf '%s\n' "$version_preview" >&2
    exit 1
  }
fi

if git rev-parse -q --verify "refs/tags/v${NEW_VERSION}" >/dev/null; then
  echo "✗ tag v${NEW_VERSION} 已存在，不能覆盖已有发布版本" >&2
  exit 1
fi
migration_revision="$(python3 - "$NEW_VERSION" "$HEAD" <<'PY'
import re
import sys
from pathlib import Path

from scripts.ops.release_record_fields import candidate_migration_revision

path = Path("docs/版本管理.md")
if not path.is_file():
    sys.exit("✗ 缺少 docs/版本管理.md")
text = path.read_text(encoding="utf-8")
heading = re.search(r"^## 版本发布记录\s*$", text, re.M)
if not heading:
    sys.exit("✗ 缺少版本发布记录章节")
records = list(re.finditer(r"^### V(\d+\.\d+\.\d+)\s*$", text[heading.end():], re.M))
matches = [record for record in records if record.group(1) == sys.argv[1]]
if len(matches) > 1:
    sys.exit("✗ 同一版本存在多条记录")
if matches:
    record = matches[0]
    remaining = text[heading.end():]
    end = re.search(r"^#{2,3} ", remaining[record.end():], re.M)
    body = remaining[record.end():record.end() + end.start()] if end else remaining[record.end():]
    for field in ("发布日期", "发布时间", "发布状态"):
        if len(re.findall(rf"^\*\*{field}：\*\* 待发布\s*$", body, re.M)) != 1:
            sys.exit(f"✗ V{sys.argv[1]} 已发布或待发布记录格式不完整，不能覆盖")
print(candidate_migration_revision(sys.argv[2]))
PY
)"
if [ "$BUMP_MODE" != "manual" ]; then
  version_output="$(scripts/ops/bump_version.sh "$BUMP_MODE")"
fi

ROOT="$ROOT" BASE="$BASE" HEAD="$HEAD" RELEASE_VERSION="$NEW_VERSION" BUMP_MODE="$BUMP_MODE" \
  RELEASE_MIGRATION_REVISION="$migration_revision" python3 - <<'PY'
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from scripts.ops.release_record_fields import with_release_component_versions

root = Path(os.environ["ROOT"])
base = os.environ["BASE"]
head = os.environ["HEAD"]
version = os.environ["RELEASE_VERSION"]
revision = os.environ["RELEASE_MIGRATION_REVISION"]
release = root / "docs" / "版本管理.md"


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

shortstat = git("diff", "--shortstat", f"{base}..{head}") or "文件统计不可用"
lines = [
    "<!-- release-commits:start -->",
    "#### 本轮提交摘要", "",
    "本轮自动汇总以下提交，按 Bug 修复、功能更新和工程变更分类：", "",
    f"相对提交 `{base[:12]}`，共 {len(commits)} 个非合并提交；{shortstat}。", "",
]
if groups["fix"]:
    lines += ["**Bug 修复**", "", *groups["fix"], ""]
if groups["feat"]:
    lines += ["**功能更新**", "", *groups["feat"], ""]
if groups["其他"]:
    lines += ["**工程与其他变更**", "", *groups["其他"], ""]
lines += [
    f"- 自动版本：`V{version}`",
    f"- 更新级别：`{os.environ.get('BUMP_MODE', 'auto')}`",
    "<!-- release-commits:end -->",
]
summary_block = "\n".join(lines)
text = release.read_text("utf-8")
heading = re.search(r"^## 版本发布记录\s*$", text, re.M)
assert heading is not None
record = re.search(rf"^### V{re.escape(version)}\s*$", text[heading.end():], re.M)
if record:
    start = heading.end() + record.start()
    section_end = re.search(r"^#{2,3} ", text[heading.end() + record.end():], re.M)
    end = heading.end() + record.end() + section_end.start() if section_end else len(text)
    section = with_release_component_versions(text[start:end], version, revision)
    existing = re.search(r"<!-- release-commits:start -->.*?<!-- release-commits:end -->", section, re.S)
    if existing:
        section = section[:existing.start()] + summary_block + section[existing.end():]
    else:
        section = section.rstrip() + "\n\n" + summary_block + "\n\n"
    new_text = text[:start] + section + text[end:]
else:
    block = "\n".join([
        f"### V{version}", "", f"**版本号：** V{version}", "",
        "**发布日期：** 待发布", "", "**发布时间：** 待发布", "",
        "**发布状态：** 待发布", "", "#### 本次更新内容", "",
        "- 待结合本轮提交核对、补充业务更新说明。", "", summary_block, "",
    ])
    block = with_release_component_versions(block, version, revision)
    new_text = text[:heading.end()] + "\n\n" + block + "\n" + text[heading.end():].lstrip("\n")
release.write_text(new_text, encoding="utf-8")

summary = [
    f"### 自动发版 V{version}", "",
    f"- 更新级别：{os.environ.get('BUMP_MODE', 'auto')}",
    "- 发布状态：待部署及健康检查成功", f"- 基线：`{base}`",
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

printf '%s\n' "$version_output"
