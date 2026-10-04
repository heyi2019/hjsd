"""T03 / BAS-02-04：编号分配（分业务独立递增、不可复用、超限报错）。"""
from __future__ import annotations

import pytest

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
        (SequenceKey.ORDER_DFQ, "DFQ"),
    ):
        ensure_sequence(db, key, prefix, 4)
    db.commit()
    assert allocate_number(db, SequenceKey.ORDER_HS) == "HS0001"
    assert allocate_number(db, SequenceKey.ORDER_TH) == "TH0001"
    assert allocate_number(db, SequenceKey.ORDER_DG) == "DG0001"
    assert allocate_number(db, SequenceKey.ORDER_DFQ) == "DFQ0001"


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
