"""installments/service.py 业务层守卫与「回收账号出售登记」全分支覆盖。

既有 test_installments_contract.py 偏路由/契约层：create_installment 的
合约类型与计划校验、waive/extend/settle_early 的守卫、recover_account 的
处置守卫、以及 record_sale 整段（L1128-1190）从未被直接调用。本文件补齐。

注：以下 6 行为「不可达防御」，保留源码不删、不强行覆盖：
- L315 / L676 / L739 / L1061 / L1068：数据库外键保证不可达（orders.account_id
  → accounts.id SET NULL、installments.order_id → orders.id RESTRICT，测试库
  FK 开启，物理删父行只会置 NULL，不会留下悬空引用）。
- L975（settle_early 循环内 `outstanding <= 0: continue`）：rows 已按
  `received + waived < due` 过滤，且 pay() 只改指定期次、不顺延，故该 continue
  恒不触发；保留以防御未来 pay 改为跨期顺延。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import Conflict, NotFound, Validation
from app.domain.enums import (
    EventType,
    InstallmentContractType,
    InstallmentDispositionAction,
    InstallmentStatus,
    ScheduleStatus,
)
from app.domain.trade import InstallmentSchedule, OrderEvent
from app.installments import service as installment_service
from app.orders import service as orders_service

TODAY = date(2026, 10, 12)
FUTURE = date(2026, 11, 30)


def _account(seeded_db, game_account: str):
    from app.accounts import service as accounts_service

    return accounts_service.create_account(
        seeded_db,
        game_account=game_account,
        platform="王者",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )


def _order(seeded_db, *, order_type="DFQ", account_id=None, trade_date=TODAY):
    return orders_service.create_order(
        seeded_db,
        order_type=order_type,
        trade_date=trade_date,
        actor="pytest",
        account_id=account_id,
    )


def _buy(seeded_db, order_id: int, amount="800"):
    orders_service.post_event(
        seeded_db,
        order_id,
        event_type="BUY",
        amount=Decimal(amount),
        occurred_on=TODAY,
        actor="pytest",
    )


def _contract(
    seeded_db,
    order_id: int,
    *,
    contract_type=InstallmentContractType.ADVANCE_PURCHASE.value,
    principal=None,
    down_payment="100",
    periods=2,
    per_period="300",
    first_due_on=TODAY,
    **kwargs,
):
    if principal is None:
        principal = str(Decimal(down_payment) + Decimal(per_period) * periods)
    return installment_service.create_installment(
        seeded_db,
        order_id=order_id,
        contract_type=contract_type,
        principal=Decimal(principal),
        down_payment=Decimal(down_payment),
        periods=periods,
        per_period=Decimal(per_period),
        first_due_on=first_due_on,
        actor="pytest",
        **kwargs,
    )


def _posted_event(seeded_db, order_id: int, *, event_type: str, amount: str, offset_event_id=None):
    event = OrderEvent(
        event_no=f"EVT-{order_id}-{event_type}-{amount}-{offset_event_id}",
        order_id=order_id,
        event_type=event_type,
        amount=Decimal(amount),
        occurred_on=TODAY,
        is_posted=True,
        offset_event_id=offset_event_id,
    )
    seeded_db.add(event)
    seeded_db.flush()
    return event


def _dfq_overdue(seeded_db, game_account: str, **kwargs):
    """DFQ 订单 + 逾期分期合约（账号先只存快照，回收时才物化库存账号）。"""
    order = _order(seeded_db, order_type="DFQ")
    order.account_snapshot = {"game_account": game_account, "game_type": "王者"}
    seeded_db.flush()
    contract = _contract(seeded_db, order.id, **kwargs)
    contract.status = InstallmentStatus.OVERDUE.value
    seeded_db.flush()
    return order, contract


# ------------------------------------------------------- 建单：合约类型与计划
def test_create_pickup_sale_requires_th_order(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    with pytest.raises(Validation, match="PICKUP_SALE 只能用于 TH 订单"):
        _contract(
            seeded_db,
            order.id,
            contract_type=InstallmentContractType.PICKUP_SALE.value,
        )  # 320-326


def test_create_consignment_sale_requires_dg_order(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    with pytest.raises(Validation, match="CONSIGNMENT_SALE 只能用于 DG 订单"):
        _contract(
            seeded_db,
            order.id,
            contract_type=InstallmentContractType.CONSIGNMENT_SALE.value,
        )  # 327-333


def test_create_rejects_schedule_period_out_of_range(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    with pytest.raises(Validation, match="分期计划期次必须从 1 开始且不能重复"):
        _contract(
            seeded_db,
            order.id,
            periods=2,
            schedule=[
                {"period_no": 1, "due_on": TODAY},
                {"period_no": 3, "due_on": FUTURE},
            ],
        )  # 349-352


def test_create_rejects_negative_final_period(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    # 本金 0 + 每期 100×2 = 200 的还款计划，尾期调整后为负
    with pytest.raises(Validation, match="每期金额过高"):
        _contract(
            seeded_db,
            order.id,
            principal="0",
            down_payment="0",
            per_period="100",
            periods=2,
            adjust_final_period=True,
        )  # 393-395


# --------------------------------------------- DFQ 快照账号物化（回收前置）
def test_materialize_dfq_recovery_account_requires_snapshot_account(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    with pytest.raises(Validation, match="DFQ 分期缺少可回收的账号资料"):
        installment_service._materialize_dfq_recovery_account(
            seeded_db, order, actor="pytest"
        )  # 85-88


def test_materialize_dfq_recovery_account_rejects_duplicate(seeded_db):
    _account(seeded_db, "dup-recovery-account")
    order = _order(seeded_db, order_type="DFQ")
    order.account_snapshot = {"game_account": "dup-recovery-account"}
    seeded_db.flush()
    with pytest.raises(Conflict, match="不能从 DFQ 快照重复建库存账号"):
        installment_service._materialize_dfq_recovery_account(
            seeded_db, order, actor="pytest"
        )  # 89-95


# ------------------------------------------------------------- 取消：状态守卫
def test_cancel_rejects_closed_contract(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    contract.status = InstallmentStatus.CLOSED.value
    seeded_db.flush()
    with pytest.raises(Conflict, match="不能取消交易"):
        installment_service.cancel_installment(
            seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="客户取消"
        )  # 661-672


def test_cancel_rejects_non_active_order(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    order.status = "CANCELLED"
    seeded_db.flush()
    with pytest.raises(Conflict, match="不能取消分期"):
        installment_service.cancel_installment(
            seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="客户取消"
        )  # 674-682


def test_cancel_skips_payment_already_reversed(seeded_db):
    """PAYMENT 已被 CANCEL 冲销同额 → remaining<=0，跳过逐笔退款（L712）。"""
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    payment = _posted_event(seeded_db, order.id, event_type=EventType.PAYMENT.value, amount="100")
    _posted_event(
        seeded_db,
        order.id,
        event_type=EventType.CANCEL.value,
        amount="100",
        offset_event_id=payment.id,
    )
    result = installment_service.cancel_installment(
        seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="客户取消"
    )
    assert result["refund_amount"] == Decimal("0.00")  # 696-712


# ------------------------------------------------------------- 减免：期次守卫
def test_waive_rejects_missing_period(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    with pytest.raises(NotFound, match="期次 99 不存在"):
        installment_service.waive_schedule(
            seeded_db,
            contract.id,
            period_no=99,
            amount=Decimal("10"),
            waived_on=TODAY,
            actor="pytest",
            reason="减免",
        )  # 790-797


def test_waive_rejects_completed_period(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    schedule = seeded_db.scalar(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == contract.id,
            InstallmentSchedule.period_no == 1,
        )
    )
    schedule.status = ScheduleStatus.PAID.value
    seeded_db.flush()
    with pytest.raises(Validation, match="已完成期次不可减免"):
        installment_service.waive_schedule(
            seeded_db,
            contract.id,
            period_no=1,
            amount=Decimal("10"),
            waived_on=TODAY,
            actor="pytest",
            reason="减免",
        )  # 800-801


def test_waive_rejects_amount_over_outstanding(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id, per_period="300")
    with pytest.raises(Validation, match="减免金额超过未收金额"):
        installment_service.waive_schedule(
            seeded_db,
            contract.id,
            period_no=1,
            amount=Decimal("99999"),
            waived_on=TODAY,
            actor="pytest",
            reason="减免",
        )  # 803-809


# ------------------------------------------------------------- 展期：期次守卫
def test_extend_rejects_missing_period(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    with pytest.raises(NotFound, match="期次 99 不存在"):
        installment_service.extend_schedule(
            seeded_db,
            contract.id,
            period_no=99,
            new_due_on=FUTURE,
            actor="pytest",
            reason="展期",
        )  # 870-877


def test_extend_rejects_received_period(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    schedule = seeded_db.scalar(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == contract.id,
            InstallmentSchedule.period_no == 1,
        )
    )
    schedule.received_amount = Decimal("1")
    seeded_db.flush()
    with pytest.raises(Validation, match="已收期不可展期"):
        installment_service.extend_schedule(
            seeded_db,
            contract.id,
            period_no=1,
            new_due_on=FUTURE,
            actor="pytest",
            reason="展期",
        )  # 878-879


def test_extend_rejects_completed_period(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    schedule = seeded_db.scalar(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == contract.id,
            InstallmentSchedule.period_no == 1,
        )
    )
    schedule.status = ScheduleStatus.WAIVED.value
    seeded_db.flush()
    with pytest.raises(Validation, match="已完成期次不可展期"):
        installment_service.extend_schedule(
            seeded_db,
            contract.id,
            period_no=1,
            new_due_on=FUTURE,
            actor="pytest",
            reason="展期",
        )  # 880-881


def test_extend_rejects_earlier_due_on(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id, first_due_on=FUTURE)
    with pytest.raises(Validation, match="展期后的到期日必须晚于原到期日"):
        installment_service.extend_schedule(
            seeded_db,
            contract.id,
            period_no=1,
            new_due_on=TODAY,
            actor="pytest",
            reason="展期",
        )  # 882-883


def test_extend_resets_overdue_period_to_pending(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    schedule = seeded_db.scalar(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == contract.id,
            InstallmentSchedule.period_no == 1,
        )
    )
    schedule.status = ScheduleStatus.OVERDUE.value
    seeded_db.flush()
    updated = installment_service.extend_schedule(
        seeded_db,
        contract.id,
        period_no=1,
        new_due_on=FUTURE,
        actor="pytest",
        reason="展期",
    )
    assert updated.status == ScheduleStatus.PENDING.value  # 884-887
    assert updated.due_on == FUTURE


# --------------------------------------------------------- 提前结清：状态守卫
def test_settle_early_rejects_settled_contract(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    contract.status = InstallmentStatus.SETTLED.value
    seeded_db.flush()
    with pytest.raises(Conflict, match="不可提前结清"):
        installment_service.settle_early(
            seeded_db, contract.id, paid_on=TODAY, actor="pytest"
        )  # 947-956


def test_settle_early_rejects_when_nothing_outstanding(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    for row in seeded_db.scalars(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == contract.id
        )
    ).all():
        row.received_amount = row.due_amount
    seeded_db.flush()
    with pytest.raises(Validation, match="合约没有剩余应收"):
        installment_service.settle_early(
            seeded_db, contract.id, paid_on=TODAY, actor="pytest"
        )  # 957-967


# ----------------------------------------------------------- 账号回收：处置守卫
def test_recover_rejects_contract_not_overdue(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    assert contract.status in {
        InstallmentStatus.PENDING.value,
        InstallmentStatus.ACTIVE.value,
    }
    with pytest.raises(Validation, match="只有逾期或违约合约可以回收账号"):
        installment_service.recover_account(
            seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="回收"
        )  # 1054-1058


def test_recover_rejects_order_without_account(seeded_db):
    """非 DFQ 订单且无库存账号 → 不物化快照，直接报「没有可回收的账号」。

    用 TH + PICKUP_SALE 组合：建单合法且天然不带库存账号（HS+STOCK_SALE 会
    强制要求账号在库，DG+CONSIGNMENT_SALE 会要求订单类型为 DG）。
    """
    order = _order(seeded_db, order_type="TH")
    contract = _contract(
        seeded_db,
        order.id,
        contract_type=InstallmentContractType.PICKUP_SALE.value,
    )
    contract.status = InstallmentStatus.OVERDUE.value
    seeded_db.flush()
    with pytest.raises(Validation, match="分期合约没有可回收的账号"):
        installment_service.recover_account(
            seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="回收"
        )  # 1062-1065


def test_recover_rejects_duplicate_recovery(seeded_db):
    order, contract = _dfq_overdue(seeded_db, "recover-dup-account")
    installment_service.recover_account(
        seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="回收"
    )
    seeded_db.refresh(contract)
    contract.status = InstallmentStatus.OVERDUE.value  # 回到可回收状态再登记一次
    seeded_db.flush()
    with pytest.raises(Conflict, match="该分期合约已登记回收"):
        installment_service.recover_account(
            seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="回收"
        )  # 1069-1076


# ------------------------------------------------------- 回收账号出售登记全流程
def _recovered(seeded_db, game_account: str):
    """返回 (order, contract)：已完成账号回收、合约 CLOSED。"""
    order, contract = _dfq_overdue(seeded_db, game_account)
    installment_service.recover_account(
        seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="回收"
    )
    seeded_db.refresh(order)
    seeded_db.refresh(contract)
    return order, contract


def _sale_order(seeded_db, account_id: int, *, with_sell=True):
    sale = _order(seeded_db, order_type="HS")
    sale.account_id = account_id
    seeded_db.flush()
    if with_sell:
        _posted_event(seeded_db, sale.id, event_type=EventType.SELL.value, amount="900")
    return sale


def test_record_sale_requires_note(seeded_db):
    order, contract = _recovered(seeded_db, "resale-need-note")
    sale = _sale_order(seeded_db, order.account_id)
    with pytest.raises(Validation, match="出售必须填写说明"):
        installment_service.record_sale(
            seeded_db,
            contract.id,
            sale_order_id=sale.id,
            occurred_on=TODAY,
            actor="pytest",
            note="   ",
        )  # 1128


def test_record_sale_rejects_contract_not_closable(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    sale = _order(seeded_db, order_type="HS")
    with pytest.raises(Validation, match="只有已关闭、逾期或违约合约可以登记出售"):
        installment_service.record_sale(
            seeded_db,
            contract.id,
            sale_order_id=sale.id,
            occurred_on=TODAY,
            actor="pytest",
            note="出售",
        )  # 1130-1135


def test_record_sale_rejects_order_without_account(seeded_db):
    order = _order(seeded_db, order_type="DFQ")
    contract = _contract(seeded_db, order.id)
    contract.status = InstallmentStatus.CLOSED.value
    seeded_db.flush()
    sale = _order(seeded_db, order_type="HS")
    with pytest.raises(Validation, match="分期合约没有可出售的账号"):
        installment_service.record_sale(
            seeded_db,
            contract.id,
            sale_order_id=sale.id,
            occurred_on=TODAY,
            actor="pytest",
            note="出售",
        )  # 1136-1139


def test_record_sale_rejects_unknown_sale_order(seeded_db):
    order, contract = _recovered(seeded_db, "resale-unknown-order")
    with pytest.raises(Validation, match="出售必须关联新的售出订单"):
        installment_service.record_sale(
            seeded_db,
            contract.id,
            sale_order_id=999999,
            occurred_on=TODAY,
            actor="pytest",
            note="出售",
        )  # 1137-1141


def test_record_sale_rejects_same_order(seeded_db):
    order, contract = _recovered(seeded_db, "resale-same-order")
    with pytest.raises(Validation, match="出售必须关联新的售出订单"):
        installment_service.record_sale(
            seeded_db,
            contract.id,
            sale_order_id=order.id,
            occurred_on=TODAY,
            actor="pytest",
            note="出售",
        )  # 1140-1141


def test_record_sale_rejects_different_account(seeded_db):
    order, contract = _recovered(seeded_db, "resale-diff-account")
    other = _account(seeded_db, "resale-other-account")
    sale = _sale_order(seeded_db, other.id)
    with pytest.raises(Validation, match="出售订单必须关联同一个账号"):
        installment_service.record_sale(
            seeded_db,
            contract.id,
            sale_order_id=sale.id,
            occurred_on=TODAY,
            actor="pytest",
            note="出售",
        )  # 1142-1143


def test_record_sale_requires_prior_recovery(seeded_db):
    """有账号但从未登记回收 → 不能出售（直接物化快照，跳过 RECOVER）。"""
    order = _order(seeded_db, order_type="DFQ")
    order.account_snapshot = {"game_account": "resale-no-recover"}
    seeded_db.flush()
    installment_service._materialize_dfq_recovery_account(seeded_db, order, actor="pytest")
    contract = _contract(seeded_db, order.id)
    contract.status = InstallmentStatus.CLOSED.value
    seeded_db.flush()
    sale = _sale_order(seeded_db, order.account_id)
    with pytest.raises(Validation, match="出售前必须先登记回收"):
        installment_service.record_sale(
            seeded_db,
            contract.id,
            sale_order_id=sale.id,
            occurred_on=TODAY,
            actor="pytest",
            note="出售",
        )  # 1144-1151


def test_record_sale_requires_posted_sell(seeded_db):
    order, contract = _recovered(seeded_db, "resale-no-sell")
    sale = _sale_order(seeded_db, order.account_id, with_sell=False)
    with pytest.raises(Validation, match="出售订单必须先登记 SELL 事件"):
        installment_service.record_sale(
            seeded_db,
            contract.id,
            sale_order_id=sale.id,
            occurred_on=TODAY,
            actor="pytest",
            note="出售",
        )  # 1152-1160


def test_record_sale_rejects_duplicate(seeded_db):
    order, contract = _recovered(seeded_db, "resale-duplicate")
    sale = _sale_order(seeded_db, order.account_id)
    installment_service.record_sale(
        seeded_db,
        contract.id,
        sale_order_id=sale.id,
        occurred_on=TODAY,
        actor="pytest",
        note="出售",
    )
    with pytest.raises(Conflict, match="该分期合约已登记出售"):
        installment_service.record_sale(
            seeded_db,
            contract.id,
            sale_order_id=sale.id,
            occurred_on=TODAY,
            actor="pytest",
            note="再卖一次",
        )  # 1161-1168


def test_record_sale_success(seeded_db):
    order, contract = _recovered(seeded_db, "resale-success")
    sale = _sale_order(seeded_db, order.account_id)
    disposition = installment_service.record_sale(
        seeded_db,
        contract.id,
        sale_order_id=sale.id,
        occurred_on=TODAY,
        actor="pytest",
        note="  出售给新客户  ",
    )
    assert disposition.action == InstallmentDispositionAction.RESELL.value  # 1169-1190
    assert disposition.account_id == order.account_id
    assert disposition.related_order_id == sale.id
    assert disposition.note == "出售给新客户"  # _required_text 去空白


def test_record_resale_delegates_to_record_sale(seeded_db):
    order, contract = _recovered(seeded_db, "resale-legacy-alias")
    sale = _sale_order(seeded_db, order.account_id)
    disposition = installment_service.record_resale(
        seeded_db,
        contract.id,
        resale_order_id=sale.id,
        occurred_on=TODAY,
        actor="pytest",
        note="旧接口登记出售",
    )
    assert disposition.action == InstallmentDispositionAction.RESELL.value  # 1204
    assert disposition.related_order_id == sale.id
