#!/usr/bin/env python3
"""Select the one approved V1.0.0 database reset from a release commit trailer."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True, check=check)


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit("用法：release_reset_requested.py <base> <head> <version>")
    base, head, version = sys.argv[1:]
    if git("rev-parse", "--verify", f"{head}^{{commit}}", check=False).returncode:
        sys.exit("无法读取发布提交")
    if git("rev-parse", "--verify", f"{base}^{{commit}}", check=False).returncode:
        base = git("rev-parse", f"{head}^", check=False).stdout.strip()
    if not base:
        base = git("hash-object", "-t", "tree", "/dev/null").stdout.strip()
    messages = git("log", f"{base}..{head}", "--no-merges", "--format=%B").stdout
    markers = re.findall(r"^Reset-Production-Database:[ \t]*(.*?)[ \t]*$", messages, re.MULTILINE)
    if not markers:
        if version == "1.0.0":
            sys.exit("V1.0.0 已确定空库重建；发布提交缺少重建标记")
        print("false")
        return
    if markers != ["empty"] or version != "1.0.0":
        sys.exit("数据库重建标记无效：仅 V1.0.0 可使用一次 Reset-Production-Database: empty")
    print("true")


if __name__ == "__main__":
    main()
