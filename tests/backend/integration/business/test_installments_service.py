"""INSTALLMENT-02 分期服务层的状态、金额、处置与关联数据边界。

除 API 契约外，直接验证服务层的取消、提前结清、坏账处置和回收账号，
确保异常输入不会留下悬空关联或不闭合金额。
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
from app.value_added_services import service as installment_service
from app.orders import service as orders_service

TODAY = date(2026, 10, 12)
FUTURE = date(2026, 11, 30)

def _account(
    seeded_db,
    game_account: str,
    *,
    business_mode="SELF",
    inventory_type="RECOVERY",
):
    from app.stocks import service as stocks_service

    return stocks_service.create_account(
        seeded_db,
        game_account=game_account,
        platform="王者",
        business_mode=business_mode,
        inventory_type=inventory_type,
        actor="pytest",
    )

def _order(seeded_db, *, order_type="TH", account_id=None, trade_date=TODAY):
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
    contract_type=InstallmentContractType.PICKUP_SALE.value,
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

def _pickup_overdue(seeded_db, game_account: str, **kwargs):
    """DG 订单 + 逾期分期合约（订单创建时即关联库存账号）。"""
    account = _account(
        seeded_db,
        game_account,
        business_mode="DISTRIBUTION",
        inventory_type="PICKUP",
    )
    order = _order(seeded_db, order_type="TH", account_id=account.id)
    contract = _contract(seeded_db, order.id, **kwargs)
    contract.status = InstallmentStatus.OVERDUE.value
    seeded_db.flush()
    return order, contract

# ------------------------------------------------------- 建单：合约类型与计划
def test_create_pickup_sale_requires_th_order(seeded_db):
    order = _order(seeded_db, order_type="DG")
    with pytest.raises(Validation, match="PICKUP_SALE 只能用于 TH 订单"):
        _contract(
            seeded_db,
            order.id,
            contract_type=InstallmentContractType.PICKUP_SALE.value,
        )
def test_consignment_sale_is_rejected_for_consignment_orders(seeded_db):
    """代挂售出仅全款：DG 订单既不能建 STOCK_SALE，也不能建遗留的 CONSIGNMENT_SALE。"""
    order = _order(seeded_db, order_type="DG")
    with pytest.raises(Validation, match="STOCK_SALE 只能用于 HS、TH 订单"):
        _contract(
            seeded_db,
            order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
        )
    with pytest.raises(Validation, match="代挂售出仅全款，不提供分期出售"):
        _contract(
            seeded_db,
            order.id,
            contract_type=InstallmentContractType.CONSIGNMENT_SALE.value,
        )

def test_create_rejects_schedule_period_out_of_range(seeded_db):
    order = _order(seeded_db, order_type="TH")
    with pytest.raises(Validation, match="分期计划期次必须从 1 开始且不能重复"):
        _contract(
            seeded_db,
            order.id,
            periods=2,
            schedule=[
                {"period_no": 1, "due_on": TODAY},
                {"period_no": 3, "due_on": FUTURE},
            ],
        )
def test_create_rejects_negative_final_period(seeded_db):
    order = _order(seeded_db, order_type="TH")
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
        )
# --------------------------------------------- 快照账号物化（回收前置）

# ------------------------------------------------------------- 取消：状态守卫
def test_cancel_rejects_closed_contract(seeded_db):
    order = _order(seeded_db, order_type="TH")
    contract = _contract(seeded_db, order.id)
    contract.status = InstallmentStatus.CLOSED.value
    seeded_db.flush()
    with pytest.raises(Conflict, match="不能取消"):
        installment_service.cancel_installment(
            seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="客户取消"
        )
def test_cancel_rejects_settled_contract(seeded_db):
    """已结清合约不得再走退款/终止分期，避免反向冲销已完成交易。"""
    order = _order(seeded_db, order_type="TH")
    contract = _contract(seeded_db, order.id)
    contract.status = InstallmentStatus.SETTLED.value
    seeded_db.flush()
    with pytest.raises(Conflict, match="不能取消"):
        installment_service.cancel_installment(
            seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="客户取消"
        )

def test_cancel_rejects_non_active_order(seeded_db):
    order = _order(seeded_db, order_type="TH")
    contract = _contract(seeded_db, order.id)
    order.status = "CANCELLED"
    seeded_db.flush()
    with pytest.raises(Conflict, match="不能取消分期"):
        installment_service.cancel_installment(
            seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="客户取消"
        )
def test_cancel_skips_payment_already_reversed(seeded_db):
    """已全额冲销的 PAYMENT 不得再次产生退款。"""
    order = _order(seeded_db, order_type="TH")
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
    assert result["refund_amount"] == Decimal("0.00")
def test_cancel_refund_total_matches_per_event_recompute(seeded_db):
    """取消退款总额必须与逐笔 PAYMENT 独立核算一致。

    用与实现无关的循环重算交叉验证：
    退款 = Σ max(0, 该笔 PAYMENT 金额 − 该笔已被冲销金额)。
    覆盖三种情形：全额未退、部分已退、多笔并存（应退 100 / 80 / 300）。
    """
    account = _account(seeded_db, "cancel-multi-refund")
    purchase = _order(seeded_db, order_type="HS", account_id=account.id)
    _buy(seeded_db, purchase.id, amount="800")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    contract = _contract(
        seeded_db,
        order.id,
        contract_type=InstallmentContractType.STOCK_SALE.value,
        principal="1000",
        down_payment="100",
        periods=1,
        per_period="900",
    )
    # 两笔真实收款（走 pay 才会"被合约承认"，后续才有可退金额）
    installment_service.pay(
        seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY, period_no=0, actor="pytest"
    )
    installment_service.pay(
        seeded_db, contract.id, amount=Decimal("300"), paid_on=TODAY, period_no=1, actor="pytest"
    )
    payments = list(
        seeded_db.scalars(
            select(OrderEvent)
            .where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == EventType.PAYMENT.value,
                OrderEvent.is_posted.is_(True),
            )
            .order_by(OrderEvent.id)
        ).all()
    )
    # 第 2 笔先手工冲销 120（直接写事件，避免再触发资金池路由），应只剩 180 可退
    seeded_db.add(OrderEvent(
        event_no="EVT-OFFSET-PRIOR-120",
        order_id=order.id,
        event_type=EventType.CANCEL.value,
        amount=Decimal("120"),
        occurred_on=TODAY,
        is_posted=True,
        offset_event_id=payments[1].id,
    ))
    seeded_db.flush()

    def _loop_total() -> Decimal:
        """原口径重算：逐笔查该 PAYMENT 的已冲销额。"""
        expected = Decimal("0")
        for payment in payments:
            already = sum(
                (
                    item.amount
                    for item in seeded_db.scalars(
                        select(OrderEvent).where(
                            OrderEvent.offset_event_id == payment.id,
                            OrderEvent.event_type == EventType.CANCEL.value,
                            OrderEvent.is_posted.is_(True),
                        )
                    ).all()
                ),
                Decimal("0"),
            )
            remaining = payment.amount - already
            if remaining > 0:
                expected += remaining
        return expected

    expected = _loop_total()
    assert expected == Decimal("280.00")  # 100 + (300 - 120)

    result = installment_service.cancel_installment(
        seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="客户取消"
    )
    assert result["refund_amount"] == expected
    # 两笔可退：第 1 笔 100 + 第 2 笔剩余 180
    assert len(result["cancel_event_ids"]) == 2

# ------------------------------------------------------------- 减免：期次守卫
def test_waive_rejects_missing_period(seeded_db):
    order = _order(seeded_db, order_type="TH")
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
        )
def test_waive_rejects_completed_period(seeded_db):
    order = _order(seeded_db, order_type="TH")
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
        )
def test_waive_rejects_amount_over_outstanding(seeded_db):
    order = _order(seeded_db, order_type="TH")
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
        )
# ------------------------------------------------------------- 展期：期次守卫
def test_extend_rejects_missing_period(seeded_db):
    order = _order(seeded_db, order_type="TH")
    contract = _contract(seeded_db, order.id)
    with pytest.raises(NotFound, match="期次 99 不存在"):
        installment_service.extend_schedule(
            seeded_db,
            contract.id,
            period_no=99,
            new_due_on=FUTURE,
            actor="pytest",
            reason="展期",
        )
def test_extend_rejects_received_period(seeded_db):
    order = _order(seeded_db, order_type="TH")
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
        )
def test_extend_rejects_completed_period(seeded_db):
    order = _order(seeded_db, order_type="TH")
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
        )
def test_extend_rejects_earlier_due_on(seeded_db):
    order = _order(seeded_db, order_type="TH")
    contract = _contract(seeded_db, order.id, first_due_on=FUTURE)
    with pytest.raises(Validation, match="展期后的到期日必须晚于原到期日"):
        installment_service.extend_schedule(
            seeded_db,
            contract.id,
            period_no=1,
            new_due_on=TODAY,
            actor="pytest",
            reason="展期",
        )
def test_extend_resets_overdue_period_to_pending(seeded_db):
    order = _order(seeded_db, order_type="TH")
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
    assert updated.status == ScheduleStatus.PENDING.value
    assert updated.due_on == FUTURE

# --------------------------------------------------------- 提前结清：状态守卫
def test_settle_early_rejects_settled_contract(seeded_db):
    order = _order(seeded_db, order_type="TH")
    contract = _contract(seeded_db, order.id)
    contract.status = InstallmentStatus.SETTLED.value
    seeded_db.flush()
    with pytest.raises(Conflict, match="不可提前结清"):
        installment_service.settle_early(
            seeded_db, contract.id, paid_on=TODAY, actor="pytest"
        )
def test_settle_early_rejects_when_nothing_outstanding(seeded_db):
    order = _order(seeded_db, order_type="TH")
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
        )
# ----------------------------------------------------------- 账号回收：处置守卫
def test_recover_rejects_contract_not_overdue(seeded_db):
    order = _order(seeded_db, order_type="TH")
    contract = _contract(seeded_db, order.id)
    assert contract.status in {
        InstallmentStatus.PENDING.value,
        InstallmentStatus.ACTIVE.value,
    }
    with pytest.raises(Validation, match="只有逾期或违约合约可以回收账号"):
        installment_service.recover_account(
            seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="回收"
        )
def test_recover_rejects_order_without_account(seeded_db):
    """未关联库存账号的订单 → 不物化快照，直接报「没有可回收的账号」。

    用 TH + PICKUP_SALE 组合：建单合法且天然不带库存账号（HS+STOCK_SALE 会
    强制要求账号在库，DG 订单不提供分期出售）。
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
        )
def test_recover_rejects_duplicate_recovery(seeded_db):
    order, contract = _pickup_overdue(seeded_db, "recover-dup-account")
    installment_service.recover_account(
        seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="回收"
    )
    seeded_db.refresh(contract)
    contract.status = InstallmentStatus.OVERDUE.value  # 回到可回收状态再登记一次
    seeded_db.flush()
    with pytest.raises(Conflict, match="该分期合约已登记回收"):
        installment_service.recover_account(
            seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="回收"
        )
# ------------------------------------------------------- 回收账号出售登记全流程
def _recovered(seeded_db, game_account: str):
    """返回 (order, contract)：已完成账号回收、合约 CLOSED。"""
    order, contract = _pickup_overdue(seeded_db, game_account)
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
        )
def test_record_sale_rejects_contract_not_closable(seeded_db):
    order = _order(seeded_db, order_type="TH")
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
        )
def test_record_sale_rejects_order_without_account(seeded_db):
    order = _order(seeded_db, order_type="TH")
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
        )
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
        )
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
        )
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
        )
def test_record_sale_requires_prior_recovery(seeded_db):
    """有库存账号但从未登记回收 → 不能出售。"""
    account = _account(
        seeded_db,
        "resale-no-recover",
        business_mode="DISTRIBUTION",
        inventory_type="PICKUP",
    )
    order = _order(seeded_db, order_type="TH")
    order.account_id = account.id
    seeded_db.flush()
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
        )
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
        )
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
        )
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
    assert disposition.action == InstallmentDispositionAction.RESELL.value
    assert disposition.account_id == order.account_id
    assert disposition.related_order_id == sale.id
    assert disposition.note == "出售给新客户"  # _required_text 去空白
