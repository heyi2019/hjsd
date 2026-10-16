"""备份/恢复演练（P0：验证“不只会备份，还能实际恢复”）。

不依赖生产库：在临时库上造数 → 调脚本逻辑备份 → 恢复 → 断言行数一致 + 关键查询可用 + 校验和回放。
直接 import scripts/*.py 的业务函数，保证测试与运维脚本是同一套逻辑。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine, insert, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.domain import foundation, parties, trade  # noqa: F401  注册全部 v1 表

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
import importlib.util


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


backup_mod = _load("backup_db")
restore_mod = _load("restore_db")


def _seed(engine) -> dict[str, int]:
    Base.metadata.create_all(bind=engine)
    with Session(engine) as s:
        # 造若干跨表数据：池 + 客户 + 订单 + 事件 + 现金流
        from app.domain.foundation import Pool
        from app.domain.parties import Customer
        from app.domain.trade import Order, OrderEvent, Cashflow
        from app.domain.users import User
        from app.domain.enums import CapitalType, OrderStatus, EventType, Nature, Direction

        # 迁移 0008 后 orders.owner_id 指向 users，占位用户 1 必须先存在
        s.add(User(
            id=1, username="seeduser1", display_name="种子用户1",
            password_hash="seed-not-real", role="ADMIN", owner_scope="ALL",
            pool_ids=[], team_ids=[], is_active=True,
        ))
        s.flush()
        pool = Pool(code="TEST", name="测试池", ownership="OWNED", status="ACTIVE")
        s.add(pool)
        s.flush()
        cust = Customer(customer_no="CUST0001", display_name="测试客户", status="ACTIVE")
        s.add(cust)
        s.flush()
        order = Order(
            order_no="TEST0001", order_type="HS", capital_type=CapitalType.STOCK.value,
            trade_date=__import__("datetime").date.today(), status=OrderStatus.ACTIVE.value,
            owner_id=1,
        )
        s.add(order)
        s.flush()
        ev = OrderEvent(
            event_no="EVT0001", order_id=order.id, event_type=EventType.BUY.value,
            amount="100.00", portion="PRINCIPAL", occurred_on=__import__("datetime").date.today(),
            pool_id=pool.id, is_posted=True,
        )
        s.add(ev)
        s.flush()
        s.add(Cashflow(
            flow_no="FLOW0001", pool_id=pool.id, occurred_on=__import__("datetime").date.today(),
            nature=Nature.BUSINESS_IN.value, category="BUY", direction=Direction.IN.value,
            amount="100.00", order_event_id=ev.id,
        ))
        s.commit()
        counts = {
            "pools": s.scalar(select(__import__("sqlalchemy").func.count()).select_from(Pool)),
            "customers": s.scalar(select(__import__("sqlalchemy").func.count()).select_from(Customer)),
            "orders": s.scalar(select(__import__("sqlalchemy").func.count()).select_from(Order)),
            "order_events": s.scalar(select(__import__("sqlalchemy").func.count()).select_from(OrderEvent)),
            "cashflow": s.scalar(select(__import__("sqlalchemy").func.count()).select_from(Cashflow)),
        }
        return counts


def test_backup_then_restore_roundtrip(tmp_path: Path) -> None:
    src = tmp_path / "src.db"
    engine = create_engine(f"sqlite:///{src}", future=True)
    counts = _seed(engine)

    # 备份
    out_dir = tmp_path / "bak"
    dest = backup_mod.backup_database(src, out_dir, keep=30)
    assert dest.exists()
    sidecar = dest.with_suffix(".db.sha256")
    assert sidecar.exists()
    backed_digest = sidecar.read_text().split()[0]

    # 恢复到一个全新文件
    restored = tmp_path / "restored.db"
    got_digest = restore_mod.restore(dest, restored, force=True)
    assert got_digest == backed_digest

    # 恢复后行数一致 + 关键查询可用
    reng = create_engine(f"sqlite:///{restored}", future=True)
    with Session(reng) as s:
        for table, expected in [("pools", counts["pools"]), ("orders", counts["orders"]),
                                ("cashflow", counts["cashflow"])]:
            actual = s.scalar(select(__import__("sqlalchemy").func.count()).select_from(
                Base.metadata.tables[table]))
            assert actual == expected, f"{table} 行数不符：{actual} != {expected}"
        # 金额链路仍在：现金流合计 == 事件金额
        from app.domain.trade import Cashflow as Cf, OrderEvent as Oe
        total_flow = s.scalar(select(__import__("sqlalchemy").func.coalesce(
            __import__("sqlalchemy").func.sum(Cf.amount), 0)))
        total_ev = s.scalar(select(__import__("sqlalchemy").func.coalesce(
            __import__("sqlalchemy").func.sum(Oe.amount), 0)))
        assert float(total_flow) == float(total_ev) == 100.0


def test_restore_rejects_corrupted_backup(tmp_path: Path) -> None:
    src = tmp_path / "src.db"
    engine = create_engine(f"sqlite:///{src}", future=True)
    _seed(engine)
    out_dir = tmp_path / "bak"
    dest = backup_mod.backup_database(src, out_dir, keep=30)

    # 篡改备份内容
    raw = bytearray(dest.read_bytes())
    raw[0] ^= 0xFF
    dest.write_bytes(raw)

    restored = tmp_path / "restored.db"
    with pytest.raises(SystemExit):
        restore_mod.restore(dest, restored, force=True)
    assert not restored.exists() or restored.stat().st_size == 0
