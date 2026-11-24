"""INVENTORY-03 订单和库存凭证保留：历史删除接口不得清理业务数据。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import Validation
from app.domain.enums import (
    AuditAction,
    InstallmentContractType,
    InstallmentDispositionAction,
    InstallmentStatus,
)
from app.domain.foundation import AuditLog
from app.domain.trade import (
    Account,
    Cashflow,
    Installment,
    InstallmentDisposition,
    Order,
    OrderEvent,
    RebateRecord,
)
from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.business.inventory.profile import create_account
from app.business.inventory.deletion import delete_inventory
from app.business.orders.deletion import delete_order
from app.finance.rebates import create_rebate

D = date(2026, 10, 20)


def _account_with_order(seeded_db, name: str = "delete-target") -> tuple[int, int]:
    account = create_account(
        seeded_db,
        game_account=name,
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = create_order(
        seeded_db, order_type="HS", trade_date=D, actor="pytest", account_id=account.id
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=D, actor="pytest",
    )
    seeded_db.commit()
    return account.id, order.id


def _delete(seeded_client, account_id: int, *, headers: dict[str, str], reason: object = "重复录入"):
    payload = {} if reason is None else {"reason": reason}
    return seeded_client.request(
        "DELETE", f"/api/stocks/{account_id}", headers=headers, json=payload
    )


def test_delete_inventory_preserves_order_events_cashflows_and_rebate(seeded_client, seeded_db, headers):
    account_id, order_id = _account_with_order(seeded_db)
    stock_no = seeded_db.get(Account, account_id).stock_no
    rebate = create_rebate(
        seeded_db, source_order_id=order_id, amount=Decimal("5"),
        collected_on=D, actor="pytest", rebate_type="BUY",
    )
    rebate_id = rebate.id
    seeded_db.commit()
    response = _delete(seeded_client, account_id, headers=headers, reason="重复录入，需清理")
    assert response.status_code == 422, response.text
    seeded_db.expire_all()

    assert seeded_db.get(Account, account_id) is not None
    assert seeded_db.get(Order, order_id) is not None
    assert seeded_db.scalar(select(OrderEvent.id).where(OrderEvent.order_id == order_id)) is not None
    assert seeded_db.scalar(select(Cashflow.id).where(Cashflow.order_id == order_id)) is not None
    assert seeded_db.get(RebateRecord, rebate_id) is not None

    audit = seeded_db.scalar(
        select(AuditLog).where(
            AuditLog.action == AuditAction.ACCOUNT_DELETE,
            AuditLog.entity_id == stock_no,
        )
    )
    assert audit is None


@pytest.mark.parametrize("entry", ["order", "inventory"])
def test_delete_preserves_event_cashflows_and_reversal_chain(seeded_client, seeded_db, headers, entry):
    account_id, order_id = _account_with_order(seeded_db, "delete-scope-target")
    other_account_id, other_order_id = _account_with_order(seeded_db, "delete-scope-other")
    target = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == order_id))
    other = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == other_order_id))
    assert target is not None and other is not None
    # 历史流水可能仅靠事件编号关联订单。
    target.order_id = None
    other.order_id = None
    reversals = []
    for number, original in (("TEST-DEL-REV-A", target), ("TEST-DEL-REV-B", other)):
        reversal = Cashflow(flow_no=number, pool_id=original.pool_id, occurred_on=D,
                            category=original.category, direction="IN", amount=Decimal("10"),
                            source_type="REVERSAL", source_id=original.flow_no,
                            created_by="pytest", updated_by="pytest")
        seeded_db.add(reversal)
        reversals.append(reversal)
    seeded_db.flush()
    nested_reversal = Cashflow(flow_no="TEST-DEL-REV-A2", pool_id=target.pool_id, occurred_on=D,
                               category=target.category, direction="OUT", amount=Decimal("10"),
                               source_type="REVERSAL", source_id=reversals[0].flow_no,
                               created_by="pytest", updated_by="pytest")
    seeded_db.add(nested_reversal)
    seeded_db.flush()
    target_id, other_id = target.id, other.id
    target_reversal_id, other_reversal_id = (item.id for item in reversals)
    nested_reversal_id = nested_reversal.id
    seeded_db.commit()

    response = (_delete(seeded_client, account_id, headers=headers) if entry == "inventory" else
                seeded_client.request("DELETE", f"/api/orders/{order_id}", headers=headers, json={"reason": "重复录入"}))
    assert response.status_code == 422, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Order, order_id) is not None
    assert seeded_db.get(Account, account_id) is not None
    assert seeded_db.get(Cashflow, target_id) is not None
    assert seeded_db.get(Cashflow, target_reversal_id) is not None
    assert seeded_db.get(Cashflow, nested_reversal_id) is not None
    assert seeded_db.get(Order, other_order_id) is not None
    assert seeded_db.get(Account, other_account_id) is not None
    assert seeded_db.get(Cashflow, other_id) is not None
    assert seeded_db.get(Cashflow, other_reversal_id) is not None

def test_delete_requires_non_blank_reason(seeded_client, seeded_db, headers):
    account_id, _ = _account_with_order(seeded_db, "blank-reason")
    for reason in (None, "", "   "):
        response = _delete(seeded_client, account_id, headers=headers, reason=reason)
        assert response.status_code == 422, (reason, response.text)
    seeded_db.expire_all()
    assert seeded_db.get(Account, account_id) is not None
    assert seeded_db.scalar(
        select(AuditLog.id).where(AuditLog.action == AuditAction.ACCOUNT_DELETE)
    ) is None


def test_non_admin_cannot_delete_inventory(seeded_client, seeded_db, operator_headers):
    account_id, _ = _account_with_order(seeded_db, "operator-target")
    response = _delete(seeded_client, account_id, headers=operator_headers)
    assert response.status_code == 403, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Account, account_id) is not None


def test_delete_inventory_preserves_installment_disposition(seeded_client, seeded_db, headers):
    account_id, order_id = _account_with_order(seeded_db, "disposition-target")
    inst = Installment(
        inst_no="DEL-DISP-001",
        order_id=order_id,
        contract_type=InstallmentContractType.PICKUP_SALE.value,
        principal=Decimal("0"),
        down_payment=Decimal("0"),
        service_fee=Decimal("0"),
        periods=1,
        per_period_service_fee=Decimal("0"),
        per_period=Decimal("0"),
        bad_debt_amount=Decimal("0"),
        status=InstallmentStatus.DEFAULTED.value,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(inst)
    seeded_db.flush()
    seeded_db.add(
        InstallmentDisposition(
            installment_id=inst.id,
            account_id=account_id,
            action=InstallmentDispositionAction.RECOVER.value,
            occurred_on=D,
            note="pytest 处置记录",
            created_by="pytest",
            updated_by="pytest",
        )
    )
    seeded_db.commit()

    response = _delete(seeded_client, account_id, headers=headers)
    assert response.status_code == 422, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Account, account_id) is not None
    assert seeded_db.get(Order, order_id) is not None
    assert seeded_db.scalar(
        select(InstallmentDisposition.id).where(InstallmentDisposition.account_id == account_id)
    ) is not None


@pytest.mark.parametrize("entry", ["order", "inventory"])
def test_direct_delete_service_cannot_bypass_voucher_retention(seeded_db, entry):
    account_id, order_id = _account_with_order(seeded_db, f"service-{entry}")
    with pytest.raises(Validation, match="不可删除"):
        if entry == "order":
            delete_order(seeded_db, order_id, actor="pytest", reason="重复录入")
        else:
            delete_inventory(seeded_db, account_id, actor="pytest", reason="重复录入")
    assert seeded_db.get(Order, order_id) is not None
    assert seeded_db.get(Account, account_id) is not None


@pytest.mark.parametrize("entry", ["order", "inventory"])
def test_empty_order_or_unlinked_inventory_is_still_a_voucher(seeded_client, seeded_db, headers, entry):
    account = create_account(
        seeded_db, game_account=f"empty-{entry}", business_mode="SELF",
        inventory_type="RECOVERY", actor="pytest",
    )
    if entry == "order":
        order = create_order(seeded_db, order_type="HS", trade_date=D, actor="pytest", account_id=account.id)
        endpoint = f"/api/orders/{order.id}"
    else:
        endpoint = f"/api/stocks/{account.id}"
    seeded_db.commit()
    response = seeded_client.request("DELETE", endpoint, headers=headers, json={"reason": "重复录入"})
    assert response.status_code == 422, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Account, account.id) is not None
    if entry == "order":
        assert seeded_db.get(Order, order.id) is not None


def test_delete_unknown_account_returns_404(seeded_client, headers):
    response = _delete(seeded_client, 999_999, headers=headers)
    assert response.status_code == 404, response.text
