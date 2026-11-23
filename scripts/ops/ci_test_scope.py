#!/usr/bin/env python3
"""为 CI 解析完整提交范围；无法安全判断时要求全量验证。"""
from __future__ import annotations

import os
import re
import subprocess

_SHA = re.compile(r"^[0-9a-f]{40}$")
_MAX_PATHS_LENGTH = 16_000


def _full() -> dict[str, str]:
    return {"mode": "full", "groups": "ci", "changed_paths": "", "full_suite": "true"}


def _changed(paths: list[str]) -> dict[str, str]:
    if not paths:
        paths = ["VERSION"]  # 空提交仍执行 smoke + unit，不依赖工作区状态。
    if any(not path or any(char in path for char in (",", "\n", "\r", "\x00"))
           or path.startswith(("/", "./")) or ".." in path.split("/") for path in paths):
        return _full()
    joined = ",".join(paths)
    if len(joined.encode("utf-8")) > _MAX_PATHS_LENGTH:
        return _full()
    return {"mode": "changed", "groups": "", "changed_paths": joined, "full_suite": "false"}


def resolve_scope(env: dict[str, str]) -> dict[str, str]:
    full_suite = env.get("CI_FULL_SUITE", "false").lower()
    if full_suite != "false":
        return _full()
    injected = env.get("CI_CHANGED_PATHS", "")
    if injected:
        return _changed(injected.split(","))
    if env.get("CI_EVENT_NAME") not in {"push", "pull_request"}:
        return _full()
    base, head = env.get("CI_BASE_SHA", ""), env.get("CI_HEAD_SHA", "")
    if not _SHA.fullmatch(base) or not _SHA.fullmatch(head) or base == "0" * 40:
        return _full()
    try:
        result = subprocess.run(
            ["git", "-c", "core.quotepath=false", "diff", "--no-renames", "--name-only", "-z", base, head, "--"],
            check=True, capture_output=True,
        )
        paths = [item.decode("utf-8") for item in result.stdout.split(b"\0") if item]
    except (OSError, subprocess.CalledProcessError, UnicodeError):
        return _full()
    return _changed(paths)


def main() -> None:
    for key, value in resolve_scope(dict(os.environ)).items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
