"""FORM-01 表单作用域注册表 + 操作类表单 form_extra 落库（迁移 f7a8b9c0d1e2）。

覆盖：
- GET /order-form-fields/scopes 返回注册表 FORM_SCOPES 的全部作用域（当前 49 个，
  断言直接对齐注册表，避免每次新增作用域都要改数字——曾因写死 47 而腐化）；
- 12 个新作用域种子已由迁移落库（GET /order-form-fields 可读）；
- 订单事件 / 取消 / 订单关联 / 编辑订单 / 分润 / 分期取消 / 账号资料 /
  工作室流水的 form_extra 通道。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.core.errors import Validation
from app.domain.trade import Account, Cashflow, Order, OrderEvent, OrderFormField
from app.settings.field_definitions.catalog_seed import seed_catalog
from app.domain.form_scopes import FORM_SCOPES
from app.shared.form_field_rules import validate_business_responsible, validate_form_extra
from app.business.stocks.profile import update_account_profile


D = "2026-10-27"


def test_form_values_must_use_registered_scope(seeded_db):
    """后端表单值只能落入注册过的当前作用域，避免前端拼错 scope 后静默丢值。"""
    with pytest.raises(Validation, match="表单作用域不存在"):
        validate_form_extra(seeded_db, order_type_code="LEGACY_REBATE_FORM", values={"x": 1})


def test_scopes_endpoint_lists_all_scopes(seeded_client, headers):
    response = seeded_client.get("/api/v1/order-form-fields/scopes", headers=headers)
    assert response.status_code == 200, response.text
    scopes = response.json()
    expected = {item.code for item in FORM_SCOPES}
    assert {item["code"] for item in scopes} == expected
    assert len(scopes) == len(expected)
    by_code = {item["code"]: item for item in scopes}
    assert by_code["ORDERCANC"]["label"] == "取消"
    assert by_code["ORDERCANC"]["group"] == "ORDEROP"
    assert by_code["INVREFUND"]["label"] == "取消"
    assert by_code["INVREFUND"]["group"] == "INVENTORY"
    assert by_code["INVCANCEL"]["group"] == "INSTALLMENT"
    assert by_code["INVEDIT"]["label"] == "编辑"
    assert by_code["INVEDIT"]["group"] == "INVENTORY"
    assert by_code["INVOID"]["label"] == "下架"
    assert by_code["INVOID"]["group"] == "INVENTORY"
    assert by_code["REFUND"]["label"] == "资金收支"
    assert by_code["REFUND"]["group"] == "ORDEROP"
    assert "INVPLATFORM" not in by_code
    assert by_code["STUDIOEXP"]["group"] == "STUDIO"
    # 既有作用域仍在清单中
    assert by_code["HS"]["label"] == "回收建单"
    for code in ("ORDDELETE", "INVDELETE", "SYSREMIND", "SYSGAME", "SYSDICT", "SYSFIELD", "SYSORDER", "SYSPOOL"):
        assert by_code[code]["group"] == "SYSTEM"


def test_operation_scope_seeds_match_registry(seeded_db):
    """当前基线为所有操作作用域落入可读取的字段种子。"""
    from app.domain import form_scopes

    seed_catalog(seeded_db)
    seeded_db.commit()
    seeded_codes = set(seeded_db.scalars(select(OrderFormField.order_type_code)))
    registry_codes = {s.code for s in form_scopes.FORM_SCOPES}
    # 当前基线的操作类种子必须覆盖所有可配置操作作用域。
    operation_codes = {
        "ORDERCANC", "ORDEREDIT", "ORDERLINK", "REFUND",
        "INVREFUND", "INVOID", "INVCANCEL",
        "STUDIOEXP", "STUDIOREJ", "STUDIOREV",
    }
    assert operation_codes <= seeded_codes
    assert operation_codes | {"ALLOCATION", "INVEDIT"} <= registry_codes
    for code in ("ORDDELETE", "INVDELETE", "SYSREMIND", "SYSGAME", "SYSDICT", "SYSFIELD", "SYSORDER", "SYSPOOL"):
        assert code in seeded_codes
    from app.business.form_fields import create_order_form_field, set_order_form_field_active, update_order_form_field
    reason = seeded_db.scalar(select(OrderFormField).where(OrderFormField.order_type_code == "ORDDELETE", OrderFormField.field_key == "reason"))
    assert reason.required and reason.locked
    with pytest.raises(Validation, match="不可停用"):
        set_order_form_field_active(seeded_db, reason.id, False, actor="pytest")
    with pytest.raises(Validation, match="不可改为选填"):
        update_order_form_field(seeded_db, reason.id, required=False, actor="pytest")
    with pytest.raises(Validation, match="不能新增自定义字段"):
        create_order_form_field(seeded_db, order_type_code="ORDDELETE", field_key="extra", label="附加字段", actor="pytest")
    optional = seeded_db.scalar(select(OrderFormField).where(OrderFormField.order_type_code == "SYSREMIND", OrderFormField.field_key == "profitNotificationsEnabled"))
    set_order_form_field_active(seeded_db, optional.id, False, actor="pytest")
    assert not optional.is_active


def test_allocation_scope_has_core_field_seeds(seeded_db):
    """订单分润的核心字段必须由当前基线直接提供。"""
    seed_catalog(seeded_db)
    seeded_db.commit()
    keys = set(
        seeded_db.scalars(
            select(OrderFormField.field_key).where(OrderFormField.order_type_code == "ALLOCATION")
        )
    )
    assert {"employee", "role", "allocation_rate", "allocation_amount"} <= keys


def test_business_responsible_fields_are_registered_for_all_order_types(seeded_db):
    """三类建单负责人必须是配置中心可见的内置多选必填字段。"""
    seed_catalog(seeded_db)
    seeded_db.commit()

    expected = {
        "HS": "回收操作人",
        "TH": "提号操作人",
        "DG": "代挂操作人",
    }
    rows = seeded_db.scalars(
        select(OrderFormField).where(
            OrderFormField.field_key == "business_responsible_ids",
            OrderFormField.order_type_code.in_(expected),
        )
    ).all()

    assert {row.order_type_code for row in rows} == set(expected)
    for row in rows:
        assert row.label == expected[row.order_type_code]
        assert row.field_type == "MULTI_SELECT"
        assert row.required is True
        assert row.is_active is True
        assert row.locked is True
        assert row.is_custom is False


@pytest.mark.parametrize(
    ("order_type_code", "label"),
    [("HS", "回收操作人"), ("TH", "提号操作人"), ("DG", "代挂操作人")],
)
def test_business_responsible_is_required_by_backend(seeded_db, order_type_code, label):
    seed_catalog(seeded_db)

    with pytest.raises(Validation, match=f"字段 {label} 必填"):
        validate_business_responsible(
            seeded_db,
            order_type_code=order_type_code,
            values={},
        )

    validate_business_responsible(
        seeded_db,
        order_type_code=order_type_code,
        values={"business_responsible_ids": [1]},
    )


def _create_order(seeded_client, headers) -> dict:
    response = seeded_client.post(
        "/api/v1/orders",
        json={
            "order_type": "HS",
            "trade_date": D,
            "account_snapshot": {"game_account": f"form-extra-{D}"},
            "initial_buy": {"amount": "100", "occurred_on": D},
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_post_event_persists_form_extra(seeded_client, seeded_db, headers):
    order = _create_order(seeded_client, headers)
    response = seeded_client.post(
        f"/api/v1/orders/{order['id']}/events",
        json={
            "event_type": "OPERATE",
            "operation_type": "IMAGE",
            "occurred_on": D,
            "note": "作图",
            "form_extra": {"channel": "微信", "ticket_no": "TK-1"},
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text
    event = seeded_db.get(OrderEvent, response.json()["event"]["id"])
    assert event.form_extra == {
        "channel": "微信",
        "ticket_no": "TK-1",
        "operation_type": "IMAGE",
    }


def test_cancel_order_merges_form_extra_into_order(seeded_client, seeded_db, headers):
    response = seeded_client.post(
        "/api/v1/orders",
        json={"order_type": "HS", "trade_date": D, "account_snapshot": {"game_account": f"cancel-extra-{D}"}},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    order_id = response.json()["id"]
    cancel = seeded_client.post(
        f"/api/v1/orders/{order_id}/cancel",
        json={"reason": "误建", "form_extra": {"approved_by": "何一"}},
        headers=headers,
    )
    assert cancel.status_code == 200, cancel.text
    order = seeded_db.get(Order, order_id)
    assert order.form_extra == {"approved_by": "何一"}


def test_patch_order_merges_form_extra(seeded_client, seeded_db, headers):
    order = _create_order(seeded_client, headers)
    response = seeded_client.patch(
        f"/api/v1/orders/{order['id']}",
        json={"form_extra": {"source_channel": "闲鱼"}},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    row = seeded_db.get(Order, order["id"])
    assert row.form_extra == {"source_channel": "闲鱼"}


def test_profit_allocations_merge_form_extra(seeded_client, seeded_db, headers):
    from app.business.form_fields import create_order_form_field
    order = _create_order(seeded_client, headers)
    seeded_db.get(Order, order["id"]).status = "COMPLETED"
    create_order_form_field(seeded_db, order_type_code="ALLOCATION", field_key="remark",
                            label="分润备注", required=True, actor="pytest")
    seeded_db.flush()
    missing = seeded_client.put(
        f"/api/v1/orders/{order['id']}/profit-allocations",
        json={"items": [{"user_id": None, "role": "OWNER", "allocation_rate": "100", "allocation_amount": "0"}]},
        headers=headers,
    )
    assert missing.status_code == 422, missing.text
    assert "分润备注" in missing.text
    response = seeded_client.put(
        f"/api/v1/orders/{order['id']}/profit-allocations",
        json={
            "items": [{"user_id": None, "role": "OWNER", "allocation_rate": "100", "allocation_amount": "0"}],
            "form_extra": {"remark": "按比例全额"},
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    row = seeded_db.get(Order, order["id"])
    assert row.form_extra == {"remark": "按比例全额"}


def test_cashflow_create_and_reverse_form_extra(seeded_client, seeded_db, headers):
    pools = seeded_client.get("/api/v1/pools", headers=headers).json()
    pool_id = pools[0]["id"] if isinstance(pools, list) else pools["items"][0]["id"]
    created = seeded_client.post(
        "/api/v1/cashflows",
        json={
            "pool_id": pool_id,
            "occurred_on": D,
            "direction": "OUT",
            "category": "房租",
            "amount": "500",
            "note": "工作室月租",
            "form_extra": {"landlord": "李某"},
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    flow_id = created.json()["id"]
    row = seeded_db.get(Cashflow, flow_id)
    flow_no = row.flow_no
    assert row.form_extra == {"landlord": "李某"}

    # 流水创建即已入账，直接冲销，冲销流水携带 form_extra
    reversed_flow = seeded_client.post(
        f"/api/v1/cashflows/{flow_id}/reverse",
        json={"reversed_on": D, "reason": "录错", "form_extra": {"ticket": "RV-1"}},
        headers=headers,
    )
    assert reversed_flow.status_code == 200, reversed_flow.text
    reversal = (
        seeded_db.query(Cashflow)
        .filter(Cashflow.source_type == "REVERSAL", Cashflow.source_id == flow_no)
        .one()
    )
    assert reversal.form_extra == {"ticket": "RV-1"}


def test_account_profile_merges_form_extra(seeded_client, seeded_db, headers):
    order = _create_order(seeded_client, headers)
    account_id = order["account_id"]
    assert account_id is not None
    update_account_profile(
        seeded_db,
        account_id,
        actor="admin",
        form_extra={"supplier": "号商A"},
    )
    account = seeded_db.get(Account, account_id)
    assert account.form_extra == {"supplier": "号商A"}


def test_sale_scopes_have_independent_field_sets(seeded_db):
    """三类售出表单各自独立：改一份的字段标签不影响另外两份。

    测试库 seed_template 只播基础主数据、不播 catalog，故本用例显式调用活基线种子。
    """
    from sqlalchemy import func, select

    from app.domain.trade_models.form_config import OrderFormField
    from app.settings.field_definitions.catalog_seed import seed_catalog
    from app.domain.form_scopes import SCOPE_CODES

    seed_catalog(seeded_db, actor="pytest")
    seeded_db.flush()

    codes = ("SALEREC", "SALETH", "SALEDG")
    assert all(code in SCOPE_CODES for code in codes)
    assert "SALE" not in SCOPE_CODES

    def count(code: str) -> int:
        return int(
            seeded_db.scalar(
                select(func.count())
                .select_from(OrderFormField)
                .where(OrderFormField.order_type_code == code)
            )
            or 0
        )

    def amount_of(code: str):
        return seeded_db.scalar(
            select(OrderFormField).where(
                OrderFormField.order_type_code == code,
                OrderFormField.field_key == "amount",
            )
        )

    # 三份字段集按各自界面差异化：回收/提号含分期与分笔，代挂只有佣金口径。
    assert [count(code) for code in codes] == [28, 28, 21]
    assert count("SALE") == 0
    assert amount_of("SALEREC").label == "售出金额"
    assert amount_of("SALEDG").label == "利润"
    for code in ("SALEREC", "SALETH"):
        payment_method = seeded_db.scalar(
            select(OrderFormField).where(
                OrderFormField.order_type_code == code,
                OrderFormField.field_key == "payment_method",
            )
        )
        assert payment_method is not None
        assert payment_method.options == [
            {"value": "FULL", "label": "全款"},
            {"value": "INSTALLMENT", "label": "分期付款"},
        ]
    assert "sale_amount" in {
        row.field_key
        for row in seeded_db.scalars(
            select(OrderFormField).where(OrderFormField.order_type_code == "SALEDG")
        )
    }
    assert "payment_method" not in {
        row.field_key
        for row in seeded_db.scalars(
            select(OrderFormField).where(OrderFormField.order_type_code == "SALEDG")
        )
    }
    # 无界面控件的占位行已清理；条件必填的依赖字段必须在同一作用域内。
    for code in codes:
        keys = {
            row.field_key
            for row in seeded_db.scalars(
                select(OrderFormField).where(OrderFormField.order_type_code == code)
            )
        }
        assert not {"first_due_on", "customer_id"} & keys
        for row in seeded_db.scalars(
            select(OrderFormField).where(OrderFormField.order_type_code == code)
        ):
            if row.required_when:  # JSON 列可能存的是 JSON null 而非 SQL NULL
                assert row.required_when["field"] in keys

    amount_of("SALEREC").label = "回收成交价"
    seeded_db.flush()
    assert amount_of("SALETH").label == "售出金额"
    assert amount_of("SALEDG").label == "利润"
