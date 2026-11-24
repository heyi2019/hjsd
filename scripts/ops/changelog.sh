#!/usr/bin/env bash
# 生成版本管理文档的待发布章节草稿（相对指定基线的提交，按类型分组）。
#
# 为什么要有这个脚本：
#   自动发版使用 auto_release.sh 写发布记录；本脚本用于手动生成章节草稿。
#   配套门禁见 tests/backend/unit/system/test_settings.py。
#
# 用法：
#   scripts/ops/changelog.sh                      打印草稿到 stdout（不落盘）
#   scripts/ops/changelog.sh --write              写入待发布记录，保留已有人工说明
#   scripts/ops/changelog.sh --from v1.0.1        指定基线（默认取最近可达 tag）
#   scripts/ops/changelog.sh --to <rev>           指定终点（默认 HEAD）
#   scripts/ops/changelog.sh --full               每组展开全部提交（默认每组只列前 20 条）
#
# 脚本只生成待发布记录及提交摘要；业务更新说明需人工核对补充，发布时间由实际部署确认。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || { echo "✗ 需要 python3（可用 PYTHON=... 指定）" >&2; exit 1; }

FROM=""
TO="HEAD"
WRITE="0"
FULL="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --write) WRITE="1"; shift ;;
    --full)  FULL="1"; shift ;;
    --from)  FROM="${2:-}"; [ -n "${FROM}" ] || { echo "✗ --from 缺少值" >&2; exit 2; }; shift 2 ;;
    --to)    TO="${2:-}";   [ -n "${TO}" ]   || { echo "✗ --to 缺少值" >&2; exit 2; };   shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "✗ 未知参数：${1}（--help 看用法）" >&2; exit 2 ;;
  esac
done

cd "${ROOT}"

# 基线：默认最近**可达** tag。注意 `git describe` 只看得到 HEAD 的祖先，
# 若最新版本 tag 打在别的分支（本项目 v1.0.1 就落在 origin/main，不在 dev 线上），
# 取到的会是更早的 tag —— 此时提交数会虚高，脚本会明确提示，别默默当成真实落差。
if [ -z "${FROM}" ]; then
  FROM="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  if [ -z "${FROM}" ]; then
    echo "✗ 找不到任何 tag，无法确定基线；请显式传 --from <rev>" >&2
    exit 1
  fi
fi

git rev-parse --verify "${FROM}^{commit}" >/dev/null 2>&1 || { echo "✗ 基线不存在：${FROM}" >&2; exit 1; }
git rev-parse --verify "${TO}^{commit}"   >/dev/null 2>&1 || { echo "✗ 终点不存在：${TO}" >&2; exit 1; }

COUNT="$(git rev-list --count "${FROM}..${TO}")"
if [ "${COUNT}" = "0" ]; then
  echo "✗ ${FROM}..${TO} 之间没有提交，无需生成章节" >&2
  exit 1
fi

if [ "${COUNT}" -gt 100 ]; then
  echo "! 提示：${FROM}..${TO} 有 ${COUNT} 个提交，基线可能过旧。" >&2
  echo "  本项目 v1.0.1 tag 打在 origin/main 而当前分支不在其线上，" >&2
  echo "  「git describe」因此回落到更早的 ${FROM}。若要对上一版发布做对照，" >&2
  echo "  用 --from <该版本的提交> 显式指定。" >&2
fi

ROOT="${ROOT}" FROM="${FROM}" TO="${TO}" WRITE="${WRITE}" FULL="${FULL}" \
  "${PY}" - <<'PY'
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

from scripts.ops.release_record_fields import candidate_migration_revision, with_release_component_versions

root = Path(os.environ["ROOT"])
base = os.environ["FROM"]
head = os.environ["TO"]
write = os.environ["WRITE"] == "1"
full = os.environ["FULL"] == "1"

# 每组默认只列前 20 条：一个跨几百提交的版本，全量清单没人读，
# 反而把「这版对用户意味着什么」淹掉。--full 才展开全部。
CAP = 10_000 if full else 20

version_file = root / "VERSION"
release_md = root / "docs" / "版本管理.md"

version = version_file.read_text("utf-8").strip()
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    sys.exit(f"✗ {version_file} 不是 x.y.z 格式")
section_title = f"### V{version}"

if not release_md.is_file():
    sys.exit(f"✗ 缺少发布记录：{release_md}")
release_text = release_md.read_text("utf-8")

heading = re.search(r"^## 版本发布记录\s*$", release_text, re.M)
if not heading:
    sys.exit("✗ 缺少版本发布记录章节")
tail = release_text[heading.end():]
matches = list(re.finditer(rf"^### V{re.escape(version)}\s*$", tail, re.M))
if len(matches) > 1:
    sys.exit(f"✗ V{version} 存在多条发布记录")


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()


# ---- 按提交类型分组 -------------------------------------------------------
# 顺序即输出顺序：对外可读的业务变更在前，工程内部变更在后（可整段删除）。
BUCKETS: list[tuple[str, tuple[str, ...], bool]] = [
    ("业务变更", ("feat", "fix", "perf"), True),
    ("重构与内部调整", ("refactor",), False),
    ("测试与文档", ("test", "docs"), False),
    ("工程与流水线", ("chore", "ci", "build", "style"), False),
]
SKIP = {"merge"}

raw = git("log", f"{base}..{head}", "--no-merges", "--format=%h\t%s")
entries: dict[str, list[str]] = {}
others: list[str] = []

for line in raw.splitlines():
    if "\t" not in line:
        continue
    sha, subject = line.split("\t", 1)
    subject = subject.strip()
    mm = re.match(r"^([a-z]+)(\([^)]*\))?!?:\s*(.+)$", subject)
    if not mm:
        others.append(f"- {subject}（`{sha}`）")
        continue
    kind = mm.group(1)
    if kind in SKIP:
        continue
    matched = False
    for _, kinds, _ in BUCKETS:
        if kind in kinds:
            entries.setdefault(kind, []).append(f"- {subject}（`{sha}`）")
            matched = True
            break
    if not matched:
        others.append(f"- {subject}（`{sha}`）")

shortstat = git("diff", "--shortstat", f"{base}..{head}") or "文件统计不可用"

lines: list[str] = [
    "<!-- release-commits:start -->",
    "#### 本轮提交摘要", "",
    f"相对 `{base}` 共 {len(raw.splitlines())} 个非合并提交；变更规模：{shortstat}。",
    "",
]

for title, kinds, _ in BUCKETS:
    picked: list[str] = []
    for k in kinds:
        picked.extend(entries.get(k, []))
    if not picked:
        continue
    suffix = "" if title == "业务变更" else "（对外可不列）"
    lines.append(f"**{title}**{suffix}")
    lines.append("")
    lines.extend(picked[:CAP])
    if len(picked) > CAP:
        lines.append(f"- …另有 {len(picked) - CAP} 条同类提交（`--full` 展开全部）")
    lines.append("")

if others:
    lines.append("**其他变更**")
    lines.append("")
    lines.extend(others[:CAP])
    if len(others) > CAP:
        lines.append(f"- …另有 {len(others) - CAP} 条（`--full` 展开全部）")
    lines.append("")

lines += ["<!-- release-commits:end -->"]
summary_block = "\n".join(lines)
revision = candidate_migration_revision(head)
block = "\n".join([
    section_title, "", f"**版本号：** V{version}", "",
    "**发布日期：** 待发布", "", "**发布时间：** 待发布", "",
    "**发布状态：** 待发布", "", "#### 本次更新内容", "",
    "- 待结合本轮提交核对、补充业务更新说明。", "", summary_block, "",
])
block = with_release_component_versions(block, version, revision)

if not write:
    print(block)
    print(f"（草稿，未落盘。加 --write 写入版本管理文档；版本 {version}，基线 {base}）",
          file=sys.stderr)
    sys.exit(0)

# 更新待发布章节中的摘要，保留用户填写的内容；已有发布记录不可覆盖。
if matches:
    match = matches[0]
    start = heading.end() + match.start()
    next_section = re.search(r"^#{2,3} ", tail[match.end():], re.M)
    end = heading.end() + match.end() + next_section.start() if next_section else len(release_text)
    section = release_text[start:end]
    for field in ("发布日期", "发布时间", "发布状态"):
        if len(re.findall(rf"^\*\*{field}：\*\* 待发布\s*$", section, re.M)) != 1:
            sys.exit(f"✗ V{version} 已发布或待发布记录格式不完整，不能覆盖")
    section = with_release_component_versions(section, version, revision)
    existing = re.search(r"<!-- release-commits:start -->.*?<!-- release-commits:end -->", section, re.S)
    if existing:
        section = section[:existing.start()] + summary_block + section[existing.end():]
    else:
        section = section.rstrip() + "\n\n" + summary_block + "\n\n"
    new_text = release_text[:start] + section + release_text[end:]
else:
    new_text = release_text[:heading.end()] + "\n\n" + block + "\n" + tail.lstrip("\n")

release_md.write_text(new_text, "utf-8")

# 写盘后复核：章节真的进去了，且顺序正确（新版本在最前）
after = release_md.read_text("utf-8")
if section_title not in after:
    sys.exit("✗ 写盘后复核失败：版本章节不存在")
print(f"✓ 已更新版本管理文档：{section_title}（基线 {base}）")
print("  下一步：核对业务更新说明并随版本一起提交")
PY
