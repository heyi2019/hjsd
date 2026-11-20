"""读取项目统一发布版本，供 API 与健康检查使用。"""

from __future__ import annotations

import re
from pathlib import Path

_version_file = Path(__file__).resolve().parents[2] / "VERSION"
__version__ = _version_file.read_text(encoding="utf-8").strip()
if not re.fullmatch(r"\d+\.\d+\.\d+", __version__):
    raise ValueError(f"项目版本格式无效：{_version_file}")

__all__ = ["__version__"]
