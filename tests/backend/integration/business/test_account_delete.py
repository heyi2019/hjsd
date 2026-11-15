"""INVENTORY-03 库存全量删除功能契约（2026-11-13 裁决）。

口径：物理删除库存行，**关联订单/事件/资金流水/返点全部删除**；
仅系统管理员可删，删除原因必填且写入审计日志；
审计日志与客户、合作方等主数据保留。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

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
)
from app.orders.create import create_order
from app.orders.events import post_event
from app.stocks.profile import create_account

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
        "DELETE", f"/api/v1/stocks/{account_id}", headers=headers, json=payload
    )


def test_delete_inventory_removes_orders_and_keeps_audit_reason(seeded_client, seeded_db, headers):
    account_id, order_id = _account_with_order(seeded_db)
    stock_no = seeded_db.get(Account, account_id).stock_no
    response = _delete(seeded_client, account_id, headers=headers, reason="重复录入，需清理")
    assert response.status_code == 204, response.text
    seeded_db.expire_all()

    assert seeded_db.get(Account, account_id) is None
    assert seeded_db.get(Order, order_id) is None
    assert seeded_db.scalar(select(OrderEvent.id).where(OrderEvent.order_id == order_id)) is None
    assert seeded_db.scalar(select(Cashflow.id).where(Cashflow.order_id == order_id)) is None

    audit = seeded_db.scalar(
        select(AuditLog).where(
            AuditLog.action == AuditAction.ACCOUNT_DELETE,
            AuditLog.entity_id == str(account_id),
        )
    )
    assert audit is not None and audit.reason == "重复录入，需清理"
    assert audit.before_json["stock_no"] == stock_no
    assert audit.before_json["game_account"] == "delete-target"
    assert audit.after_json["deleted_orders"][0]["id"] == order_id

    listed = seeded_client.get("/api/v1/stocks", headers=headers)
    assert listed.status_code == 200
    assert account_id not in [item["id"] for item in listed.json()["items"]]


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


def test_installment_disposition_is_removed_with_inventory(seeded_client, seeded_db, headers):
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
    assert response.status_code == 204, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Account, account_id) is None
    assert seeded_db.get(Order, order_id) is None
    assert seeded_db.scalar(
        select(InstallmentDisposition.id).where(InstallmentDisposition.account_id == account_id)
    ) is None


def test_delete_unknown_account_returns_404(seeded_client, headers):
    response = _delete(seeded_client, 999_999, headers=headers)
    assert response.status_code == 404, response.text
