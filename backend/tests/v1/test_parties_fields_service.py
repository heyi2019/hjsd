"""动态字段服务拆分后的独立契约测试。"""
from __future__ import annotations

import pytest

from app.core.errors import Validation
from app.parties import fields
from app.parties import service as parties_service


def test_field_module_creates_and_lists_definition(seeded_db):
    definition = fields.create_field_definition(
        seeded_db,
        entity_type="customer",
        field_key="service_note",
        label="服务备注",
        actor="pytest",
    )

    listed = fields.list_field_definitions(seeded_db, entity_type="customer")

    assert [item.field_key for item in listed] == [definition.field_key]


def test_field_module_writes_and_reads_entity_values(seeded_db):
    definition = fields.create_field_definition(
        seeded_db,
        entity_type="customer",
        field_key="service_score",
        label="服务评分",
        field_type="NUMBER",
        actor="pytest",
    )
    customer = parties_service.create_customer(
        seeded_db, display_name="动态字段测试客户", actor="pytest"
    )

    fields.set_extra_values(
        seeded_db,
        entity_type="customer",
        entity_id=customer.id,
        values=[(definition.field_key, 5)],
    )

    assert fields.get_extra_values(
        seeded_db, entity_type="customer", entity_id=customer.id
    ) == {definition.field_key: 5}


def test_field_module_keeps_number_validation(seeded_db):
    definition = fields.create_field_definition(
        seeded_db,
        entity_type="customer",
        field_key="service_amount",
        label="服务金额",
        field_type="NUMBER",
        actor="pytest",
    )
    customer = parties_service.create_customer(
        seeded_db, display_name="动态字段校验客户", actor="pytest"
    )

    with pytest.raises(Validation, match="服务金额 必须为数字"):
        fields.set_extra_values(
            seeded_db,
            entity_type="customer",
            entity_id=customer.id,
            values=[(definition.field_key, "not-a-number")],
        )
