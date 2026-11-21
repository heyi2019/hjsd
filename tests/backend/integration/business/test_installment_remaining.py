"""INSTALLMENT-01 分期合约「剩余应收」口径（INST）。

背景：前端原先自己算 `total_receivable - paid_amount - bad_debt_amount`，先收款后减免
时会出现负的「剩余」。现由后端下发 `remaining_receivable`，本文件锁住：

1. 未收款时剩余等于总应收；
2. 部分收款 + 坏账时按差额算；
3. 已收 + 坏账超过总应收（减免把应收降到已收之下）时取 0，不返回负数；
4. 列表接口确实下发该字段，前端不再自行相减。
"""
from __future__ import annotations

import csv
from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.trade import Installment, Order
from app.business.orders.create import create_order
from app.business.installments import create as inst_create

TODAY = date(2026, 10, 12)


def _contract(seeded_db, *, principal="1200.00", down_payment="200.00", periods=2, per_period="500.00"):
    order = create_order(
        seeded_db,
        order_type="TH",
        trade_date=TODAY,
        actor="pytest",
    )
    return inst_create.create_installment(
        seeded_db,
        order_id=order.id,
        contract_type="PICKUP_SALE",
        principal=Decimal(principal),
        down_payment=Decimal(down_payment),
        periods=periods,
        per_period=Decimal(per_period),
        first_due_on=TODAY,
        actor="pytest",
    )


def _output(seeded_db, contract: Installment):
    from app.business.installments import schemas

    seeded_db.refresh(contract)
    order = seeded_db.get(Order, contract.order_id)
    assert order is not None
    return schemas.InstallmentOut.model_validate(
        {
            **contract.__dict__,
            "extra_values": {},
            "order": {
                "id": order.id,
                "order_no": order.order_no,
                "order_type": order.order_type,
                "trade_date": order.trade_date,
            },
        }
    )


def test_remaining_equals_total_when_nothing_paid(seeded_db):
    out = _output(seeded_db, _contract(seeded_db))

    assert out.total_receivable == Decimal("1200.00")
    assert out.remaining_receivable == Decimal("1200.00")


def test_remaining_subtracts_paid_and_bad_debt(seeded_db):
    contract = _contract(seeded_db)
    contract.paid_amount = Decimal("300.00")
    contract.bad_debt_amount = Decimal("100.00")
    seeded_db.commit()

    out = _output(seeded_db, contract)

    assert out.remaining_receivable == Decimal("800.00")


def test_remaining_never_negative_after_waiver(seeded_db):
    # 先收 900，再减免 500：总应收 1200 − 500 = 700 < 已收 900 → 剩余按 0 计。
    contract = _contract(seeded_db)
    contract.paid_amount = Decimal("900.00")
    contract.waived_amount = Decimal("500.00")
    seeded_db.commit()

    out = _output(seeded_db, contract)

    assert out.total_receivable == Decimal("700.00")
    assert out.remaining_receivable == Decimal("0.00")


def test_list_endpoint_ships_remaining_receivable(seeded_client, seeded_db, headers):
    contract = _contract(seeded_db)
    contract.paid_amount = Decimal("200.00")
    seeded_db.commit()

    response = seeded_client.get("/api/installments", headers=headers)
    assert response.status_code == 200, response.text

    items = [item for item in response.json()["items"] if item["id"] == contract.id]
    assert items, "列表应包含刚创建的合约"
    assert items[0]["remaining_receivable"] == "1000.00"
    # 与总应收同源：总额由后端算，剩余不得比总额大。
    assert Decimal(items[0]["remaining_receivable"]) <= Decimal(
        items[0]["total_receivable"]
    )


def test_export_rows_include_remaining_receivable(seeded_client, seeded_db, headers):
    """导出走同一份 schema：剩余字段不能只在页面有、导出没有。"""
    contract = _contract(seeded_db)
    seeded_db.commit()

    response = seeded_client.get("/api/installments/export.csv", headers=headers)
    assert response.status_code == 200, response.text
    rows = list(csv.reader(response.text.splitlines()))
    header = rows[0]
    # 列表列注册表里「剩余」列 key 是 remaining，导出必须真的填上值（不是空列）。
    assert "剩余" in header
    index = header.index("剩余")
    contract_rows = [row for row in rows[1:] if contract.inst_no in row]
    assert contract_rows, "导出应包含刚创建的合约"
    assert contract_rows[0][index] == "1200.00"

    stored = seeded_db.scalar(select(Installment).where(Installment.id == contract.id))
    assert stored is not None


def test_installment_export_uses_same_status_type_and_date_filters_as_list(seeded_client, seeded_db, headers):
    matching = _contract(seeded_db)
    wrong_date = _contract(seeded_db)
    wrong_type = _contract(seeded_db)
    wrong_status = _contract(seeded_db)
    for contract in (matching, wrong_date, wrong_status):
        contract.contract_type = "STOCK_SALE"
        contract.status = "OVERDUE"
    wrong_type.status = "OVERDUE"
    wrong_status.status = "ACTIVE"
    seeded_db.get(Order, wrong_date.order_id).trade_date = date(2026, 9, 1)
    seeded_db.flush()
    filters = {"status": "OVERDUE", "contract_type": "STOCK_SALE", "trade_date_from": "2026-10-01", "trade_date_to": "2026-10-31"}
    listing = seeded_client.get("/api/installments", params=filters, headers=headers)
    exported = seeded_client.get("/api/installments/export.csv", params=filters, headers=headers)
    assert listing.status_code == exported.status_code == 200
    assert [item["id"] for item in listing.json()["items"]] == [matching.id]
    assert matching.inst_no in exported.text
    assert all(item.inst_no not in exported.text for item in (wrong_date, wrong_type, wrong_status))


def test_workbench_installment_cards_match_visible_contract_type(seeded_client, seeded_db, headers):
    visible = _contract(seeded_db)
    other_type = _contract(seeded_db)
    visible.contract_type = "STOCK_SALE"
    visible.status = "OVERDUE"
    other_type.status = "OVERDUE"
    seeded_db.flush()
    dashboard = seeded_client.get("/api/workbench/summary", headers=headers)
    totals = seeded_client.get("/api/installments/totals", params={"contract_type": "STOCK_SALE"}, headers=headers)
    assert dashboard.status_code == totals.status_code == 200
    assert dashboard.json()["installments"] == {"total_count": totals.json()["total_count"], "overdue_count": totals.json()["overdue_count"]} == {"total_count": 1, "overdue_count": 1}
