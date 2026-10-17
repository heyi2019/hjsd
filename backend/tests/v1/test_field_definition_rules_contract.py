"""活字段定义的适用范围、规则、默认值与编辑契约。"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.errors import Validation
from app.orders import service as orders_service
from app.parties import service


def test_field_definition_rules_defaults_and_applicability(
    seeded_client, seeded_db, headers
):
    definition = service.create_field_definition(
        seeded_db,
        entity_type="order",
        field_key="seller_note",
        label="卖家备注",
        field_type="TEXT",
        applicable_order_types=["HS"],
        validation_rule={"min_length": 2, "max_length": 20},
        default_value="默认备注",
        actor="pytest",
    )
    assert definition.applicable_order_types == ["HS"]
    assert definition.validation_rule == {"min_length": 2, "max_length": 20}
    assert definition.default_value == "默认备注"

    hs_order = orders_service.create_order(
        seeded_db,
        order_type="HS",
        trade_date=date(2026, 10, 17),
        actor="pytest",
    )
    assert service.get_extra_values(
        seeded_db, entity_type="order", entity_id=hs_order.id
    ) == {"seller_note": "默认备注"}

    with pytest.raises(Validation, match="不适用"):
        orders_service.create_order(
            seeded_db,
            order_type="DG",
            trade_date=date(2026, 10, 17),
            actor="pytest",
        )

    updated = seeded_client.patch(
        f"/api/v1/field-definitions/{definition.id}",
        json={"label": "卖家备注（已更新）", "sort_order": 8},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["label"] == "卖家备注（已更新）"
    assert updated.json()["sort_order"] == 8


def test_field_definition_rejects_rules_that_do_not_apply_to_type(seeded_db):
    with pytest.raises(Validation, match="只有文本字段"):
        service.create_field_definition(
            seeded_db,
            entity_type="order",
            field_key="status_choice",
            label="状态",
            field_type="SELECT",
            options=["正常", "异常"],
            validation_rule={"pattern": "正常|异常"},
            actor="pytest",
        )


def test_field_definition_cannot_shadow_fixed_entity_fields(seeded_db):
    with pytest.raises(Validation, match="不能覆盖固定字段"):
        service.create_field_definition(
            seeded_db,
            entity_type="order",
            field_key="order_no",
            label="伪订单号",
            actor="pytest",
        )


@pytest.mark.parametrize(
    ("entity_type", "field_key"),
    [("account", "source_order_no"), ("cashflow", "order_no")],
)
def test_field_definition_cannot_shadow_computed_api_fields(
    seeded_db, entity_type, field_key
):
    with pytest.raises(Validation, match="不能覆盖固定字段"):
        service.create_field_definition(
            seeded_db,
            entity_type=entity_type,
            field_key=field_key,
            label="不能覆盖接口字段",
            actor="pytest",
        )
