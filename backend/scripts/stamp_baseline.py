"""把已等价的旧库版本戳对齐到压平后的基线 0001。

背景：迁移已压平为单个 `0001_initial_schema.py`，旧的 0002~0023 不再存在。
因此 `alembic upgrade head` 在「版本戳仍是旧号」的库上会直接报
``Can't locate revision identified by '00xx'`` 并退出，容器起不来。

本脚本只在**库结构与 ORM 元数据完全等价**时才改写版本戳；结构有缺口就报错退出，
绝不把落后的库伪装成 0001（那会让后续真实迁移被永久跳过）。

用法（工作目录 backend）：
    python scripts/stamp_baseline.py            # 校验并 stamp
    python scripts/stamp_baseline.py --dry-run  # 只校验，不写库
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import Base  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain import (  # noqa: E402,F401  注册全部 v1 模型
    attachments,
    foundation,
    notifications,
    parties,
    quality,
    trade,
    users,
)

BASELINE_REVISION = "0001"


def _missing(engine) -> list[str]:
    """返回库结构相对 ORM 元数据的缺口清单；空列表表示等价。"""
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    gaps: list[str] = []

    for name, table in Base.metadata.tables.items():
        if name not in existing_tables:
            gaps.append(f"缺表: {name}")
            continue
        db_columns = {column["name"] for column in inspector.get_columns(name)}
        for column in table.columns:
            if column.name not in db_columns:
                gaps.append(f"缺列: {name}.{column.name}")
        db_indexes = {index["name"] for index in inspector.get_indexes(name)}
        for index in table.indexes:
            if index.name and index.name not in db_indexes:
                gaps.append(f"缺索引: {index.name}")
    return gaps


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="只校验，不改写版本戳")
    args = parser.parse_args()

    settings = get_settings()
    engine = create_engine(settings.alembic_url)
    try:
        gaps = _missing(engine)
        if gaps:
            print(f"[stamp_baseline] 拒绝 stamp：库结构与 ORM 不等价，共 {len(gaps)} 处缺口", file=sys.stderr)
            for gap in gaps[:50]:
                print(f"  - {gap}", file=sys.stderr)
            return 1

        with engine.begin() as connection:
            current = connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
            if current == BASELINE_REVISION:
                print(f"[stamp_baseline] 版本戳已是 {BASELINE_REVISION}，无需处理")
                return 0
            if args.dry_run:
                print(f"[stamp_baseline] 结构等价；当前版本戳={current}（dry-run，未改写）")
                return 0
            connection.execute(
                text("UPDATE alembic_version SET version_num = :rev"),
                {"rev": BASELINE_REVISION},
            )
        print(f"[stamp_baseline] 版本戳 {current} -> {BASELINE_REVISION} 已对齐")
        return 0
    finally:
        engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
