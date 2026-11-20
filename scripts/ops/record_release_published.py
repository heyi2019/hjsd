#!/usr/bin/env python3
"""Record a verified production deployment in the project release history."""
from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import re
import sys
from zoneinfo import ZoneInfo


def main() -> None:
    parser = argparse.ArgumentParser(description="记录已验证上线的实际日期和时间")
    parser.add_argument("version", help="项目版本，例如 1.0.0")
    parser.add_argument("--file", type=Path, default=Path(__file__).resolve().parents[2] / "docs" / "版本管理.md")
    parser.add_argument("--at", help="部署健康检查成功时的 ISO 8601 时间，必须包含时区")
    args = parser.parse_args()

    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        sys.exit("项目版本必须是 x.y.z 格式")
    try:
        published_at = datetime.fromisoformat(args.at) if args.at else datetime.now(ZoneInfo("Asia/Shanghai"))
        if published_at.utcoffset() is None:
            raise ValueError("时间缺少时区")
        published_at = published_at.astimezone(ZoneInfo("Asia/Shanghai"))
        text = args.file.read_text(encoding="utf-8")
    except (ValueError, OSError) as exc:
        sys.exit(f"读取发布记录或时间失败：{exc}")

    heading = re.search(r"^## 版本发布记录\s*$", text, re.M)
    if not heading:
        sys.exit("缺少版本发布记录章节")
    tail = text[heading.end():]
    matches = list(re.finditer(rf"^### V{re.escape(args.version)}\s*$", tail, re.M))
    if len(matches) != 1:
        sys.exit(f"V{args.version} 的发布记录不存在或重复")
    match = matches[0]
    start = heading.end() + match.start()
    next_section = re.search(r"^#{2,3} ", tail[match.end():], re.M)
    end = heading.end() + match.end() + next_section.start() if next_section else len(text)
    section = text[start:end]

    def value(field: str) -> str:
        found = re.findall(rf"^\*\*{field}：\*\* ([^\n]+)$", section, re.M)
        if len(found) != 1:
            sys.exit(f"V{args.version} 的{field}缺失或重复")
        return found[0].strip()

    status = value("发布状态")
    if status == "已发布":
        print(f"V{args.version} 已有发布时间，保持原记录")
        return
    if status != "待发布" or value("发布日期") != "待发布" or value("发布时间") != "待发布":
        sys.exit(f"V{args.version} 的待发布记录格式不完整")

    replacements = {
        "发布日期": published_at.strftime("%Y-%m-%d"),
        "发布时间": published_at.strftime("%H:%M:%S") + "（北京时间）",
        "发布状态": "已发布",
    }
    for field, replacement in replacements.items():
        section = section.replace(f"**{field}：** 待发布", f"**{field}：** {replacement}", 1)
    args.file.write_text(text[:start] + section + text[end:], encoding="utf-8")
    print(f"已记录 V{args.version} 的发布时间：{published_at.isoformat()}")


if __name__ == "__main__":
    main()
