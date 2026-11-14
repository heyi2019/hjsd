"""PARTY-01 R9 fixture：客户来源「可输入选填」+ 四类建单「落库级断言」。

背景（2026-10-28）：客户来源字段由「严格 SELECT + 独立 _other 文本分支」改为
「可自由输入的 SELECT（combobox）+ 选填」。后端 create_order 对 form_extra 原样落库
（service.py:432）、不校验选项/必填，所以「可输入」与「选填」都是 API 既有的契约行为；
本文件用针对性 fixture 把它们锁死，避免日后回归。

落库级断言：三类建单（HS/TH/DG）经 API 创建后，直接查库确认 Order 行与
（DG/HS/TH 各自触发的）库存 Account 行确实落地，而非只看响应回显。
"""
from __future__ import annotations

import pytest
from datetime import date

from sqlalchemy import select

from app.domain.parties import Customer
from app.domain.trade import Account, Order
from app.parties.customers import create_customer

D = date(2026, 10, 4)

# 各业务类型对应的客户来源字段键（与 order_form_fields 种子一致）。
CUSTOMER_SOURCE_KEY = {
    "HS": "customer_source",
    "TH": "customer_source",
    "DG": "dg_customer_source",
}

def _base_payload(order_type: str) -> dict:
    """返回该类型「最小可建单」负载（含触发内联库存账号的必填项）。"""
    base = {"order_type": order_type, "trade_date": D.isoformat()}
    if order_type == "HS":
        return {
            **base,
            "account_snapshot": {"game_account": "r9-hs-account"},
            "initial_buy": {"amount": "100", "occurred_on": D.isoformat()},
            "initial_costs": [{"amount": "10", "occurred_on": D.isoformat(), "flow_category": "FEE"}],
        }
    if order_type == "TH":
        return {
            **base,
            "account_snapshot": {"game_account": "r9-th-account"},
            "initial_buy": {"amount": "100", "occurred_on": D.isoformat()},
            "initial_costs": [{"amount": "10", "occurred_on": D.isoformat(), "flow_category": "FEE"}],
        }
    if order_type == "DG":
        return {**base, "account_snapshot": {"game_account": "r9-dg-account"}}

# ------------------------------------------------------------------ 客户来源：可输入选填
@pytest.mark.parametrize("order_type", ["HS", "TH", "DG"])
def test_customer_source_accepts_free_typed_value(seeded_client, seeded_db, headers, order_type):
    """可输入：不在预设选项里的自由文本也应被接受并落库。"""
    key = CUSTOMER_SOURCE_KEY[order_type]
    free_value = "抖音直播间引流"  # 非预设 option，专门测「可输入」
    payload = _base_payload(order_type)
    payload["form_extra"] = {key: free_value}

    resp = seeded_client.post("/api/v1/orders", json=payload, headers=headers)
    assert resp.status_code == 201, resp.text

    order = seeded_db.get(Order, resp.json()["id"])
    assert order is not None
    assert order.form_extra is not None
    assert order.form_extra.get(key) == free_value

@pytest.mark.parametrize("order_type", ["HS", "TH", "DG"])
def test_customer_source_optional_when_omitted(seeded_client, headers, order_type):
    """选填：不传客户来源字段也能成功建单（字段为选填，不因 required=1 在后端拦）。"""
    resp = seeded_client.post(
        "/api/v1/orders", json=_base_payload(order_type), headers=headers
    )
    assert resp.status_code == 201, resp.text

@pytest.mark.parametrize("order_type", ["HS", "TH", "DG"])
def test_customer_source_explicit_empty_string_accepted(seeded_client, headers, order_type):
    """选填边界：显式传空字符串也算「未填」，不应被拒。"""
    key = CUSTOMER_SOURCE_KEY[order_type]
    payload = _base_payload(order_type)
    payload["form_extra"] = {key: ""}
    resp = seeded_client.post("/api/v1/orders", json=payload, headers=headers)
    assert resp.status_code == 201, resp.text

# ------------------------------------------------------------------ 三类建单：落库级断言
@pytest.mark.parametrize(
    ("order_type", "prefix", "inventory_type", "business_mode"),
    [
        ("HS", "HS", "RECOVERY", "SELF"),
        ("TH", "TH", "PICKUP", "DISTRIBUTION"),
        ("DG", "DG", "CONSIGNMENT", "DISTRIBUTION"),
    ],
)
def test_order_lands_with_inline_inventory_account(
    seeded_client, seeded_db, headers, order_type, prefix, inventory_type, business_mode
):
    """HS/TH/DG 建单（带 game_account）→ Order 行 + 内联库存 Account 行均落库。"""
    resp = seeded_client.post(
        "/api/v1/orders", json=_base_payload(order_type), headers=headers
    )
    assert resp.status_code == 201, resp.text
    order_id = resp.json()["id"]

    order = seeded_db.get(Order, order_id)
    assert order is not None
    assert order.order_type == order_type
    assert order.status == "ACTIVE"
    assert order.order_no.startswith(prefix)
    assert order.account_id is not None

    account = seeded_db.get(Account, order.account_id)
    assert account is not None
    assert account.inventory_type == inventory_type
    assert account.business_mode == business_mode

def test_four_order_types_all_persist_distinct_rows(seeded_client, seeded_db, headers):
    """三类各建一单，库内同时存在 3 行、各自 order_no 前缀正确、互不复用编号。"""
    created = []
    for ot in ("HS", "TH", "DG"):
        resp = seeded_client.post(
            "/api/v1/orders", json=_base_payload(ot), headers=headers
        )
        assert resp.status_code == 201, resp.text
        created.append((ot, resp.json()["order_no"]))

    prefixes = {ot: no for ot, no in created}
    assert prefixes["HS"].startswith("HS")
    assert prefixes["TH"].startswith("TH")
    assert prefixes["DG"].startswith("DG")
    # 编号互不相同
    assert len({no for _, no in created}) == 3

    db_rows = seeded_db.scalars(select(Order).where(Order.order_no.in_([no for _, no in created]))).all()
    assert len(db_rows) == 3


def test_order_inline_customer_creates_a_profile_when_phone_differs(
    seeded_client, seeded_db, headers
):
    """建单内联客户以昵称和明确联系方式复用；手机号不同则建新档案。"""
    create_customer(
        seeded_db,
        display_name="同名客户",
        phone="13800000000",
        actor="pytest",
    )
    payload = _base_payload("HS")
    payload["customer_input"] = {
        "display_name": "同名客户",
        "role": "SELLER",
        "phone": "13900000000",
    }

    response = seeded_client.post("/api/v1/orders", json=payload, headers=headers)

    assert response.status_code == 201, response.text
    customers = seeded_db.scalars(
        select(Customer).where(Customer.display_name == "同名客户").order_by(Customer.id)
    ).all()
    assert [customer.phone for customer in customers] == ["13800000000", "13900000000"]


def test_order_rejects_snapshot_and_existing_account_together(seeded_client, headers):
    """建单的账号来源必须唯一，不能既引用库存又提交新账号快照。"""
    payload = _base_payload("HS")
    payload["account_id"] = 999999

    response = seeded_client.post("/api/v1/orders", json=payload, headers=headers)

    assert response.status_code == 422
    assert "账号快照与库存账号不能同时提交" in response.text
