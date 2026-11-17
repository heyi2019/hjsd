#!/usr/bin/env python3
"""schema_diff.py —— 列级比对：某库的实际结构 vs 当前代码 ORM 元数据。

为什么需要：`restore_drill.sh` 原本只数表个数（40）和版本戳（0001）。表数对得上、
列却少一列的情况它查不出来——而「上线包是老代码打的、上线跑的是新代码」正是这种
事故：恢复完看着一切正常，上线后第一个读该列的请求 500。

用法（由 restore_drill.sh 调用，也可单独跑）：
    backend/.venv/bin/python3 deploy/scripts/schema_diff.py heijin_erp_drill_20261103_123456

退出码：0 无差异 / 1 有差异 / 2 环境或参数错误。
只读：不建表、不改表、不写任何行。
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from alembic.autogenerate import compare_metadata  # noqa: E402
from alembic.migration import MigrationContext  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402

import app.main  # noqa: E402,F401  导入以注册全部 ORM 到 Base.metadata
from app.domain.base import Base  # noqa: E402
from app.core.settings import get_settings  # noqa: E402

# 只允许比对演练临时库：防止手滑把参数写成 release / 生产库名后对着它跑比对。
REQUIRED_PREFIX = "heijin_erp_drill_"


def main() -> int:
    if len(sys.argv) != 2:
        print("用法: schema_diff.py <演练临时库名>", file=sys.stderr)
        return 2
    target = sys.argv[1]
    if not target.startswith(REQUIRED_PREFIX):
        print(f"拒绝比对 `{target}`：库名须以 {REQUIRED_PREFIX} 开头", file=sys.stderr)
        return 2

    base_url = get_settings().database_url.rsplit("/", 1)[0]
    try:
        engine = create_engine(f"{base_url}/{target}", future=True)
        with engine.connect() as conn:
            diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
        engine.dispose()
    except Exception as exc:  # noqa: BLE001  环境问题不该伪装成「结构有差异」
        print(f"结构比对无法运行：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    print(f"  ORM 表数 {len(Base.metadata.tables)} / 差异 {len(diff)} 条")
    for item in diff[:20]:
        print(f"    - {item}")
    if len(diff) > 20:
        print(f"    …另有 {len(diff) - 20} 条")
    return 0 if not diff else 1


if __name__ == "__main__":
    raise SystemExit(main())
