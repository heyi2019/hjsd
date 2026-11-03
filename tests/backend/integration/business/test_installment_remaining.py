"""INSTALLMENT-01 分期合约「剩余应收」口径（INST）。

背景：前端原先自己算 `total_receivable - paid_amount - bad_debt_amount`，先收款后减免
时会出现负的「剩余」。现由后端下发 `remaining_receivable`，本文件锁住：

1. 未收款时剩余等于总应收；
2. 部分收款 + 坏账时按差额算；
3. 已收 + 坏账超过总应收（减免把应收降到已收之下）时取 0，不返回负数；
4. 列表接口确实下发该字段，前端不再自行相减。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.trade import Installment
from app.orders import service as orders_service
from app.value_added_services import service as installment_service

TODAY = date(2026, 10, 12)


def _contract(seeded_db, *, principal="1200.00", down_payment="200.00", periods=2, per_period="500.00"):
    order = orders_service.create_order(
        seeded_db,
        order_type="TH",
        trade_date=TODAY,
        actor="pytest",
    )
    return installment_service.create_installment(
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
    from app.value_added_services import schemas

    seeded_db.refresh(contract)
    return schemas.InstallmentOut.model_validate(
        {**contract.__dict__, "extra_values": {}}
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

    response = seeded_client.get("/api/v1/installments", headers=headers)
    assert response.status_code == 200, response.text

    items = [item for item in response.json() if item["id"] == contract.id]
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

    response = seeded_client.get("/api/v1/installments/export.csv", headers=headers)
    assert response.status_code == 200, response.text
    lines = response.text.splitlines()
    header = lines[0].split(",")
    # 列表列注册表里「剩余」列 key 是 remaining，导出必须真的填上值（不是空列）。
    assert "剩余" in header
    index = header.index("剩余")
    contract_rows = [line.split(",") for line in lines[1:] if contract.inst_no in line]
    assert contract_rows, "导出应包含刚创建的合约"
    assert contract_rows[0][index] == "1200.00"

    stored = seeded_db.scalar(select(Installment).where(Installment.id == contract.id))
    assert stored is not None
