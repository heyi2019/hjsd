"""API-01 业务操作人快照按统一接口契约读写。"""
from __future__ import annotations

import pytest

from app.core.errors import Validation
from app.shared.operation_operators import (
    get_operation_operators,
    list_operation_operators,
    list_operation_operators_bulk,
    upsert_operation_operators,
)


def test_operation_operators_default_to_current_actor_and_can_be_updated(seeded_db):
    row = upsert_operation_operators(
        seeded_db,
        entity_type="installment",
        entity_id="INST0001",
        operation_key="PAY:1",
        actor="seeduser1",
        operator_user_ids=None,
    )

    assert row.operator_user_ids == [1]

    updated = upsert_operation_operators(
        seeded_db,
        entity_type="installment",
        entity_id="INST0001",
        operation_key="PAY:1",
        actor="seeduser1",
        operator_user_ids=[1, 2],
    )

    assert updated.id == row.id
    assert get_operation_operators(
        seeded_db,
        entity_type="installment",
        entity_id="INST0001",
        operation_key="PAY:1",
    ).operator_user_ids == [1, 2]


def test_operation_operators_reject_duplicate_or_inactive_users(seeded_db):
    with pytest.raises(Validation, match="不能重复"):
        upsert_operation_operators(
            seeded_db,
            entity_type="installment",
            entity_id="INST0001",
            operation_key="PAY:2",
            actor="seeduser1",
            operator_user_ids=[1, 1],
        )

    with pytest.raises(Validation, match="不存在或已停用"):
        upsert_operation_operators(
            seeded_db,
            entity_type="installment",
            entity_id="INST0001",
            operation_key="PAY:3",
            actor="seeduser1",
            operator_user_ids=[999999],
        )


def test_operation_operators_list_is_scoped_and_stable(seeded_db):
    upsert_operation_operators(
        seeded_db,
        entity_type="installment",
        entity_id="INST0001",
        operation_key="CREATE",
        actor="seeduser1",
        operator_user_ids=None,
    )
    upsert_operation_operators(
        seeded_db,
        entity_type="installment",
        entity_id="INST0001",
        operation_key="PAY:1",
        actor="seeduser1",
        operator_user_ids=[1, 2],
    )
    upsert_operation_operators(
        seeded_db,
        entity_type="installment",
        entity_id="INST0002",
        operation_key="PAY:1",
        actor="seeduser1",
        operator_user_ids=[2],
    )

    rows = list_operation_operators(
        seeded_db,
        entity_type="installment",
        entity_id="INST0001",
    )

    assert [row.operation_key for row in rows] == ["CREATE", "PAY:1"]
    assert rows[1].operator_user_ids == [1, 2]


def test_operation_operators_reject_unknown_actor(seeded_db):
    """operator_user_ids 未传时按 actor 用户名解析；名字不存在必须明确报错。"""
    with pytest.raises(Validation, match="当前操作人不存在或已停用"):
        upsert_operation_operators(
            seeded_db,
            entity_type="installment",
            entity_id="INST0009",
            operation_key="PAY:9",
            actor="ghost-user",
            operator_user_ids=None,
        )


def test_operation_operators_reject_empty_selection(seeded_db):
    with pytest.raises(Validation, match="至少选择一名操作人"):
        upsert_operation_operators(
            seeded_db,
            entity_type="installment",
            entity_id="INST0009",
            operation_key="PAY:9",
            actor="seeduser1",
            operator_user_ids=[],
        )


def test_operation_operators_reject_blank_entity_keys(seeded_db):
    """entity_type / entity_id / operation_key 去空白后任一为空都拒收。"""
    for kwargs in (
        {"entity_type": "   ", "entity_id": "INST0009", "operation_key": "PAY:9"},
        {"entity_type": "installment", "entity_id": "   ", "operation_key": "PAY:9"},
        {"entity_type": "installment", "entity_id": "INST0009", "operation_key": ""},
    ):
        with pytest.raises(Validation, match="业务动作标识不能为空"):
            upsert_operation_operators(
                seeded_db,
                actor="seeduser1",
                operator_user_ids=[1],
                **kwargs,
            )


def test_bulk_operators_returns_empty_for_no_entities(seeded_db):
    assert list_operation_operators_bulk(
        seeded_db, entity_type="installment", entity_ids=[]
    ) == {}
