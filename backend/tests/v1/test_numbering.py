"""T03 / BAS-02-04：编号分配（分业务独立递增、不可复用、超限报错）。"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.errors import AppError, ErrorCode
from app.core.numbering import MAX_SEQUENCE_VALUE, allocate_number, ensure_sequence, peek_number
from app.domain.enums import SequenceKey


def test_allocate_increments_within_sequence(db):
    ensure_sequence(db, SequenceKey.ORDER_HS, "HS", 4)
    ensure_sequence(db, SequenceKey.ORDER_TH, "TH", 4)
    db.commit()

    assert allocate_number(db, SequenceKey.ORDER_HS) == "HS0001"
    assert allocate_number(db, SequenceKey.ORDER_HS) == "HS0002"
    assert allocate_number(db, SequenceKey.ORDER_TH) == "TH0001"
    db.commit()


def test_business_sequences_are_independent(db):
    """HS0001 与 TH0001 允许并存（PRD §2.1.1）。"""
    for key, prefix in (
        (SequenceKey.ORDER_HS, "HS"),
        (SequenceKey.ORDER_TH, "TH"),
        (SequenceKey.ORDER_DG, "DG"),
    ):
        ensure_sequence(db, key, prefix, 4)
    db.commit()
    assert allocate_number(db, SequenceKey.ORDER_HS) == "HS0001"
    assert allocate_number(db, SequenceKey.ORDER_TH) == "TH0001"
    assert allocate_number(db, SequenceKey.ORDER_DG) == "DG0001"


def test_number_is_not_reused_after_rollback(db):
    """事务失败允许产生号段空洞，但绝不可复用已发出的编号。"""
    ensure_sequence(db, SequenceKey.ORDER_HS, "HS", 4)
    db.commit()
    assert allocate_number(db, SequenceKey.ORDER_HS) == "HS0001"
    db.rollback()

    assert allocate_number(db, SequenceKey.ORDER_HS) == "HS0001"  # 空洞：HS0001 未被回收


def test_sequence_exhausted_raises_instead_of_silent_overflow(db):
    ensure_sequence(db, SequenceKey.CUSTOMER, "CUS", 4)
    db.commit()
    sequence = ensure_sequence(db, SequenceKey.CUSTOMER, "CUS", 4)
    sequence.current_value = MAX_SEQUENCE_VALUE
    db.commit()

    with pytest.raises(AppError) as exc:
        allocate_number(db, SequenceKey.CUSTOMER)
    assert exc.value.code == ErrorCode.SEQUENCE_EXHAUSTED
    assert exc.value.http_status == 422


def test_peek_does_not_consume(db):
    ensure_sequence(db, SequenceKey.COUNTERPARTY, "CP", 4)
    db.commit()
    assert peek_number(db, SequenceKey.COUNTERPARTY) == "CP0001"
    assert peek_number(db, SequenceKey.COUNTERPARTY) == "CP0001"
    assert allocate_number(db, SequenceKey.COUNTERPARTY) == "CP0001"


def test_allocate_unknown_sequence_is_rejected(db):
    with pytest.raises(AppError) as exc:
        allocate_number(db, "ORDER_UNKNOWN")
    assert exc.value.code == ErrorCode.VALIDATION_ERROR


def test_concurrent_allocation_is_unique():
    """并发取号回归（2026-10-28 压测修复）：多会话全周期（取号→提交）编号绝不重复。

    旧实现「SELECT 读值 → Python +1 → UPDATE 绝对值写」在并发下会发出重复号，
    撞 orders.order_no 唯一约束产生 500（实测 10 并发建单 37/50 失败）。

    SQLite 已整体下线，本用例改为在独立的 PostgreSQL 临时探针库上验证：多连接并发
    取号，编号唯一且不重复。零触碰 dev/test/release/生产任何既有库。
    """
    import os
    import random
    from urllib.parse import urlparse

    from app.core.database import Base
    from app.core.settings import get_settings
    from app.domain.foundation import DocumentSequence

    base = get_settings().alembic_url
    parsed = urlparse(base)
    db_name = f"heijin_num_probe_{os.getpid()}_{random.randint(0, 9_999_999)}"
    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.exec_driver_sql(f'CREATE DATABASE "{db_name}"')
    finally:
        admin.dispose()

    target = base.replace(f"/{parsed.path.lstrip('/')}", f"/{db_name}")
    engine = create_engine(target)
    try:
        # 只建编号表，隔离且轻量
        Base.metadata.create_all(bind=engine, tables=[DocumentSequence.__table__])

        bootstrap = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)()
        ensure_sequence(bootstrap, SequenceKey.ORDER_HS, "HS", 4)
        bootstrap.commit()
        bootstrap.close()

        def worker(_worker_id: int) -> list[str]:
            session = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)()
            try:
                numbers = [allocate_number(session, SequenceKey.ORDER_HS) for _ in range(3)]
                session.commit()
                return numbers
            finally:
                session.close()

        with ThreadPoolExecutor(max_workers=8) as pool:
            batches = list(pool.map(worker, range(8)))
    finally:
        engine.dispose()
        admin2 = create_engine(base, isolation_level="AUTOCOMMIT")
        try:
            with admin2.connect() as conn:
                conn.exec_driver_sql(f'DROP DATABASE "{db_name}" WITH (FORCE)')
        finally:
            admin2.dispose()

    numbers = [n for batch in batches for n in batch]
    assert len(numbers) == 24
    assert len(set(numbers)) == 24, f"并发取号出现重复: {sorted(numbers)}"
    assert set(numbers) == {f"HS{i:04d}" for i in range(1, 25)}
