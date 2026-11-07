"""向 **dev 沙盒库** 补齐「全覆盖订单矩阵」夹具（与 E2E 库同源，便于浏览器手测任何情况）。

与 e2e_db.py 的区别：
  - 本脚本**只认业务沙盒库**（默认 `DATABASE_URL`，或 `DEV_DATABASE_URL`）；
  - 拒绝 prod / release / e2e / test 等库名，避免误灌生产；
  - **只追加、绝不清数据**：订单用 `E2E-` 前缀、账号用 `KU_90000+` 段，与沙盒既有数据
    不撞号；幂等守卫按 order_no 跳过已存在整单，可重复执行。

用法：
    python3 scripts/seed_dev_orders.py            # 向 dev 库追加订单矩阵
    DEV_DATABASE_URL=postgresql+psycopg://... python3 scripts/seed_dev_orders.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.database import Base  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
# 导入即注册 ORM 表，create_all 才不会静默漏表。
from app.domain import (  # noqa: E402,F401
    attachments,
    foundation,
    lists,
    notifications,
    options,
    parties,
    quality,
    trade,
    users,
)
from app.legacy_imports import models as imports  # noqa: E402,F401
from app.foundation.seeds import seed_foundation  # noqa: E402
from app.foundation.catalog_seed import seed_catalog  # noqa: E402
from app.foundation.seed_orders import seed_order_matrix  # noqa: E402

__all__ = [
    "attachments", "foundation", "imports", "lists", "notifications",
    "options", "parties", "quality", "trade", "users",
]

_DENIED = ("prod", "production", "release", "e2e", "test", "live", "rehearsal")


def _dev_database_url() -> str:
    settings = get_settings()
    url = os.environ.get("DEV_DATABASE_URL") or settings.database_url
    if not url:
        raise SystemExit("未配置 dev 库：请在 .env 设置 DATABASE_URL 或环境变量 DEV_DATABASE_URL。")
    if not url.startswith("postgresql"):
        raise SystemExit("dev 种子要求 PostgreSQL。")
    database = url.rsplit("/", 1)[-1]
    lowered = database.lower()
    hit = [w for w in _DENIED if w in lowered]
    if hit:
        raise SystemExit(
            f"拒绝向库 `{database}` 灌入订单夹具（命中黑名单 {hit}）。"
            "本脚本只用于 dev 沙盒库，避免误污染生产/测试库。"
        )
    return url


def main() -> int:
    url = _dev_database_url()
    print(f"[seed-dev] 目标 dev 库: {url.rsplit('@', 1)[-1]}")
    engine = create_engine(url, future=True, pool_pre_ping=True)
    Base.metadata.create_all(bind=engine)  # 幂等补表
    with Session(bind=engine) as db:
        seed_foundation(db, actor="seed-dev")
        seed_catalog(db, actor="seed-dev")
        db.flush()
        seed_order_matrix(db, actor="seed-dev")
        db.commit()

    with engine.connect() as c:
        orders = c.execute(text("SELECT count(*) FROM orders WHERE order_no LIKE 'E2E-%'")).scalar()
        linked = c.execute(
            text("SELECT count(*) FROM orders WHERE order_no LIKE 'E2E-%' AND account_id IS NOT NULL")
        ).scalar()
        accounts = c.execute(text("SELECT count(*) FROM stocks WHERE stock_no LIKE 'KU_90%'")).scalar()
    print(f"[seed-dev] 已就绪：订单 {orders}（关联 {linked}）/ 专用账号 {accounts}（均为幂等追加，未清空既有数据）")
    engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
