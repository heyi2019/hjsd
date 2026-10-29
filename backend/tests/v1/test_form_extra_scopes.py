"""表单作用域注册表 + 操作类表单 form_extra 落库（迁移 f7a8b9c0d1e2）。

覆盖：
- GET /order-form-fields/scopes 返回注册表 FORM_SCOPES 的全部作用域（当前 49 个，
  断言直接对齐注册表，避免每次新增作用域都要改数字——曾因写死 47 而腐化）；
- 12 个新作用域种子已由迁移落库（GET /order-form-fields 可读）；
- 订单事件 / 订单作废 / 订单关联 / 编辑订单 / 分润 / 分期取消 / 账号资料 /
  工作室流水的 form_extra 通道。
"""
from __future__ import annotations

from app.domain.trade import Account, Cashflow, Order, OrderEvent, OrderLink
from app.orders.form_scopes import FORM_SCOPES


D = "2026-10-27"


def test_scopes_endpoint_lists_all_scopes(seeded_client, headers):
    response = seeded_client.get("/api/v1/order-form-fields/scopes", headers=headers)
    assert response.status_code == 200, response.text
    scopes = response.json()
    expected = {item.code for item in FORM_SCOPES}
    assert {item["code"] for item in scopes} == expected
    assert len(scopes) == len(expected)
    by_code = {item["code"]: item for item in scopes}
    assert by_code["ORDERCANC"]["label"] == "售出取消交易"
    assert by_code["ORDERCANC"]["group"] == "ORDEROP"
    assert by_code["INVREFUND"]["label"] == "库存取消交易"
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


def test_operation_scope_seeds_match_registry():
    """迁移种子与 form_scopes 注册表一致（测试库不跑 alembic，直接对拍常量）。"""
    import importlib.util
    from pathlib import Path

    migration_path = (
        Path(__file__).resolve().parents[2]
        / "alembic" / "legacy_versions_pre_squash" / "0019_form_extra_columns_and_op_scopes.py"
    )
    spec = importlib.util.spec_from_file_location("migration_0019", migration_path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    from app.orders import form_scopes

    seeded_codes = set(migration.SEED)
    registry_codes = {s.code for s in form_scopes.FORM_SCOPES}
    assert seeded_codes <= registry_codes
    # 12 个操作类作用域中 10 个有核心字段种子（ALLOCATION/INVEDIT 核心字段为
    # 硬编码 UI，配置不驱动，仅承载自定义字段，不播种）。
    operation_codes = {
        "ORDERCANC", "ORDEREDIT", "ORDERLINK", "REFUND",
        "INVREFUND", "INVOID", "INVCANCEL",
        "STUDIOEXP", "STUDIOREJ", "STUDIOREV",
    }
    assert operation_codes <= seeded_codes
    assert "ALLOCATION" not in seeded_codes and "INVEDIT" not in seeded_codes
    # 但 12 个作用域全部在注册表中
    assert operation_codes | {"ALLOCATION", "INVEDIT"} <= registry_codes


def test_allocation_scope_has_core_field_seeds():
    """订单分润不能再是空配置，核心字段应由迁移预置。"""
    import importlib.util
    from pathlib import Path

    migration_path = (
        Path(__file__).resolve().parents[2]
        / "alembic" / "versions" / "0054_seed_allocation_form_fields.py"
    )
    spec = importlib.util.spec_from_file_location("migration_0054", migration_path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    keys = {row[0] for row in migration.SEED}
    assert keys == {"employee", "role", "allocation_rate", "allocation_amount"}


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
            "event_type": "COST",
            "amount": "10",
            "occurred_on": D,
            "flow_category": "FEE",
            "reason": "额外成本",
            "form_extra": {"channel": "微信", "ticket_no": "TK-1"},
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text
    event = seeded_db.get(OrderEvent, response.json()["event"]["id"])
    assert event.form_extra == {"channel": "微信", "ticket_no": "TK-1"}


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


def test_create_order_link_persists_form_extra(seeded_client, seeded_db, headers):
    first = _create_order(seeded_client, headers)
    second = seeded_client.post(
        "/api/v1/orders",
        json={"order_type": "HS", "trade_date": D, "account_snapshot": {"game_account": f"link-extra-{D}"}},
        headers=headers,
    )
    assert second.status_code == 201, second.text
    response = seeded_client.post(
        f"/api/v1/orders/{second.json()['id']}/links",
        json={
            "related_order_id": first["id"],
            "relation_type": "FOLLOW_UP",
            "form_extra": {"deal_group": "G-9"},
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text
    link = seeded_db.get(OrderLink, response.json()["id"])
    assert link.form_extra == {"deal_group": "G-9"}


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
    order = _create_order(seeded_client, headers)
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
            "nature": "BUSINESS_OUT",
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
    assert row.form_extra == {"landlord": "李某"}

    # 审核后冲销，冲销流水携带 form_extra
    approved = seeded_client.post(f"/api/v1/cashflows/{flow_id}/approve", headers=headers)
    assert approved.status_code == 200, approved.text
    reversed_flow = seeded_client.post(
        f"/api/v1/cashflows/{flow_id}/reverse",
        json={"reversed_on": D, "reason": "录错", "form_extra": {"ticket": "RV-1"}},
        headers=headers,
    )
    assert reversed_flow.status_code == 200, reversed_flow.text
    reversal = (
        seeded_db.query(Cashflow)
        .filter(Cashflow.reversal_of_id == flow_id)
        .one()
    )
    assert reversal.form_extra == {"ticket": "RV-1"}


def test_account_profile_merges_form_extra(seeded_client, seeded_db, headers):
    order = _create_order(seeded_client, headers)
    account_id = order["account_id"]
    assert account_id is not None
    response = seeded_client.patch(
        f"/api/v1/stocks/{account_id}",
        json={"form_extra": {"supplier": "号商A"}},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    account = seeded_db.get(Account, account_id)
    assert account.form_extra == {"supplier": "号商A"}
