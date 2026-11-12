#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测试记录脚本共用：读取当前仓库 HEAD 短哈希。"""
from __future__ import annotations

import subprocess
from pathlib import Path


def git_commit(repo: Path) -> str:
    """返回 HEAD 短哈希；git 不可用或不在仓库中时回退 "unknown"，不阻断结果入库。"""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=repo,
            capture_output=True,
            text=True,
            check=False,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return "unknown"
