"""installments/service.py 业务层守卫与「回收账号出售登记」全分支覆盖。

既有 test_installments_contract.py 偏路由/契约层：create_installment 的
合约类型与计划校验、waive/extend/settle_early 的守卫、recover_account 的
处置守卫、以及 record_sale 整段（L1128-1190）从未被直接调用。本文件补齐。

末尾一组用例专门覆盖「外键 / 精度保证不可达」的 6 行防御分支：
- L315 / L676 / L739 / L1061 / L1068：依赖外键（orders.account_id → accounts.id
  SET NULL、installments.order_id → orders.id RESTRICT）。正常 ORM 路径删父行只
  会置 NULL，不留悬空引用，故常规测试到不了。
- L975（settle_early 循环内 `outstanding <= 0: continue`）：rows 已按
  `received + waived < due` 过滤，正常数据下 outstanding 恒 > 0，该分支是死代码。
  原用例需构造 received=0.996 的超精度脏行，PG 存不进去，曾以 skip 挂起；
  [2026-11-03] 改为把「不可达」本身写成可执行断言（三层保证各一条用例）：
  `test_amount_columns_lock_two_decimal_precision`（列 scale=2 且 0.996→1.00、
  该行被查询排除）、`test_overpaid_schedule_rejected_by_check_constraint`
  （ck_installment_schedules_settled_amount_within_due 拒绝超额付）、
  `test_settle_early_filters_settled_rows_but_keeps_one_cent`（付清行被过滤、
  只差 1 分仍结清）。任一层松动即报警，提示守卫重新变为可达。

覆盖手段：**用独立连接 + `session_replication_role=replica` 绕过外键造脏数据**。
PostgreSQL 没有 SQLite 的 `PRAGMA foreign_keys=OFF`；superuser 把会话级的
`session_replication_role` 设为 `replica` 后 FK 触发器不执行，可真实复现
「约束未生效时遗留的脏行」（生产上 DBA 直连改数据同样会产生）。
注意：`replica` 只关 FK 触发器，**CHECK 约束照常执行**——所以超额付这类脏行
在 PG 上根本造不出来，这本身就是一道不可绕过的防线。
复位用 `SET LOCAL`（作用域为当前事务，用例回滚即自动失效），随后 `expire_all()`
让主会话重读。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

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
        )  # 320-326

def test_consignment_sale_is_rejected_for_consignment_orders(seeded_db):
    """代挂售出仅全款：DG 订单既不能建 STOCK_SALE，也不能建遗留的 CONSIGNMENT_SALE。"""
    order = _order(seeded_db, order_type="DG")
    with pytest.raises(Validation, match="STOCK_SALE 只能用于 HS、TH 订单"):
        _contract(
            seeded_db,
            order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
        )  # 327-333
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
        )  # 349-352

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
        )  # 393-395

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
        )  # 661-672

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
        )  # 674-682

def test_cancel_skips_payment_already_reversed(seeded_db):
    """PAYMENT 已被 CANCEL 冲销同额 → remaining<=0，跳过逐笔退款（L712）。"""
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
    assert result["refund_amount"] == Decimal("0.00")  # 696-712

def test_cancel_refund_total_matches_per_event_recompute(seeded_db):
    """取消退款总额必须与「逐笔 PAYMENT 独立核算」一致。

    2026-10-28 把 cancel_installment 内逐笔 SUM(CANCEL) 改写成一次 GROUP BY
    （原实现是循环内查询，N+1）。这条用例用**与实现无关的循环重算**做交叉验证：
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
        )  # 790-797

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
        )  # 800-801

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
        )  # 803-809

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
        )  # 870-877

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
        )  # 878-879

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
        )  # 880-881

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
        )  # 882-883

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
    assert updated.status == ScheduleStatus.PENDING.value  # 884-887
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
        )  # 947-956

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
        )  # 957-967

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
        )  # 1054-1058

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
        )  # 1062-1065

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
        )  # 1069-1076

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
        )  # 1128

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
        )  # 1130-1135

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

# ------------------------------------------------- 外键 / 精度保证的不可达防御
def _raw_sql(seeded_db, sql: str, params=()):
    """在主会话的连接上执行 DML，绕过外键约束造脏数据。

    PostgreSQL 没有 SQLite 的 `PRAGMA foreign_keys=OFF`；superuser 把会话级的
    `session_replication_role` 设为 `replica` 后 FK 触发器不执行，可真实复现
    「DBA 直连改数据遗留悬空引用 / 超精度零头」——这是生产同样会出现的一类脏行。

    [2026-11-03 夹具改为事务回滚后重写] 原实现走**独立连接**：那时每个用例结束会
    物理清库，主会话的 `commit()` 是真的落库，独立连接看得到那几行。夹具换成
    「外层事务 + savepoint」后主会话写入不再真正提交，独立连接看不到，`UPDATE ...
    WHERE id = ?` 会匹配 0 行，`pytest.raises(NotFound)` 随之失效。

    现在改在主会话的连接内执行：
    - 用 `SET LOCAL` 而不是 `SET`，作用域是当前事务，用例回滚时自动失效——比原来
      「用完必须 RESET、否则连接归还池后静默关掉后续用例的 FK 约束」更安全；
    - 造完脏数据立刻把 `session_replication_role` 恢复 `origin`，本事务后续的正常
      写入仍受 FK 约束保护。
    """
    seeded_db.flush()
    connection = seeded_db.connection()
    connection.exec_driver_sql("SET LOCAL session_replication_role = 'replica'")
    try:
        # 调用点沿用 SQLite 的 `?` 占位符书写，这里翻译成 psycopg 的 `%s`。
        connection.exec_driver_sql(sql.replace("?", "%s"), tuple(params))
    finally:
        connection.exec_driver_sql("SET LOCAL session_replication_role = 'origin'")
    seeded_db.expire_all()

def test_create_stock_sale_rejects_dangling_account(seeded_db):
    """orders.account_id 悬空 → STOCK_SALE 建单拒绝（L315）。

    FK `orders.account_id → accounts.id ON DELETE SET NULL` 保证正常路径不会留下
    悬空引用；这里用独立连接绕过外键，复现直连脏数据场景。
    """
    account = _account(seeded_db, "ACC-315")
    order = _order(seeded_db, order_type="HS", account_id=account.id)
    seeded_db.flush()
    _raw_sql(seeded_db, "UPDATE orders SET account_id = 999315 WHERE id = ?", (order.id,))
    with pytest.raises(Validation, match="STOCK_SALE 要求账号已入库且已在库"):
        _contract(
            seeded_db,
            order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
        )

def test_cancel_rejects_dangling_order(seeded_db):
    """installments.order_id 悬空 → 取消分期报「所属订单不存在」（L676）。"""
    _, contract = _pickup_overdue(seeded_db, "ACC-676")
    _raw_sql(
        seeded_db,
        "UPDATE installments SET order_id = 999676 WHERE id = ?",
        (contract.id,),
    )
    with pytest.raises(NotFound, match="分期合约所属订单不存在"):
        installment_service.cancel_installment(
            seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="脏数据"
        )

def test_cancel_rejects_dangling_account(seeded_db):
    """orders.account_id 悬空 → 取消分期报「关联账号不存在」（L739）。"""
    account = _account(
        seeded_db,
        "ACC-739",
        business_mode="DISTRIBUTION",
        inventory_type="PICKUP",
    )
    order = _order(seeded_db, order_type="TH", account_id=account.id)
    contract = _contract(seeded_db, order.id)
    seeded_db.flush()
    _raw_sql(seeded_db, "UPDATE orders SET account_id = 999739 WHERE id = ?", (order.id,))
    with pytest.raises(NotFound, match="分期合约关联账号不存在"):
        installment_service.cancel_installment(
            seeded_db, contract.id, cancelled_on=TODAY, actor="pytest", reason="脏数据"
        )

def test_amount_columns_lock_two_decimal_precision(seeded_db):
    """精度锁死在 2 位 → settle_early 的「零头 continue」在 PG 下不可达。

    该 continue 位于 settlement.py:82（`outstanding <= 0`），原用例需要构造
    received=0.996 的超精度脏行才能触发。但金额列是 NUMERIC(18,2)：直写 3 位小数
    会被 ROUND_HALF_UP 存成 1.00，`received + waived < due` 随即不成立、该行连 SQL
    都查不出来，永远到不了 continue。

    本用例把「不可达」本身变成可执行断言 —— 若日后有人放宽列精度，这里先红，
    提示守卫重新变为可达、必须恢复脏数据用例：
      1) 结构：三张金额列的 numeric_scale 都是 2；
      2) 存储：直写 '0.996' 落库是 1.00（超精度零头根本进不了表）；
      3) 过滤：该行因 `received + waived < due` 不成立而被 settle_early 的查询排除。
    """
    scales = dict(
        seeded_db.execute(
            text(
                "SELECT column_name, numeric_scale FROM information_schema.columns "
                "WHERE table_name = 'installment_schedules' "
                "AND column_name IN ('due_amount', 'received_amount', 'waived_amount')"
            )
        ).all()
    )
    assert scales == {"due_amount": 2, "received_amount": 2, "waived_amount": 2}

    _, contract = _pickup_overdue(seeded_db, "ACC-975")
    _raw_sql(
        seeded_db,
        "UPDATE installment_schedules SET due_amount = '1.00', "
        "received_amount = '0.996', waived_amount = '0' WHERE installment_id = ?",
        (contract.id,),
    )
    seeded_db.expire_all()
    stored = seeded_db.scalar(
        select(InstallmentSchedule.received_amount).where(
            InstallmentSchedule.installment_id == contract.id
        )
    )
    assert stored == Decimal("1.00"), "NUMERIC(18,2) 应把 0.996 四舍五入成 1.00"

    selected = seeded_db.scalars(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == contract.id,
            InstallmentSchedule.received_amount + InstallmentSchedule.waived_amount
            < InstallmentSchedule.due_amount,
        )
    ).all()
    assert selected == [], "取整后已无剩余应收，continue 分支拿不到任何行"


def test_overpaid_schedule_rejected_by_check_constraint(seeded_db):
    """received + waived > due 被 CHECK 约束拒绝 → 超额付的行结构上就不存在。

    这是「零头 continue」不可达的第一层保证（另两层见
    test_amount_columns_lock_two_decimal_precision：NUMERIC(18,2) 精度、
    settle_early 的 `received + waived < due` 过滤）。
    """
    _, contract = _pickup_overdue(seeded_db, "ACC-975")
    savepoint = seeded_db.begin_nested()
    with pytest.raises(IntegrityError):
        seeded_db.execute(
            text(
                "UPDATE installment_schedules SET received_amount = due_amount + 5 "
                "WHERE installment_id = :iid AND period_no = 1"
            ),
            {"iid": contract.id},
        )
    savepoint.rollback()


def test_settle_early_filters_settled_rows_but_keeps_one_cent(seeded_db):
    """已付清的行被过滤、只差 1 分仍结清 → 「零头 continue」永远无输入。

    证明 SQL 条件 `received + waived < due` 已把零余额行拦干净，且用的是 `<` 不是
    `<=`，不会误杀真实应收。
    """
    _, contract = _pickup_overdue(seeded_db, "ACC-975")
    periods = seeded_db.scalars(
        select(InstallmentSchedule.period_no)
        .where(InstallmentSchedule.installment_id == contract.id)
        .order_by(InstallmentSchedule.period_no)
    ).all()
    assert periods == [0, 1, 2]

    # period 0 付清（等于）、period 1 也付清：两者都必须被 SQL 过滤掉
    _raw_sql(
        seeded_db,
        "UPDATE installment_schedules SET received_amount = due_amount "
        "WHERE installment_id = ? AND period_no IN (0, 1)",
        (contract.id,),
    )
    # period 2 只差 1 分：必须仍被查出并结清，证明过滤没误杀
    _raw_sql(
        seeded_db,
        "UPDATE installment_schedules SET received_amount = due_amount - 0.01 "
        "WHERE installment_id = ? AND period_no = 2",
        (contract.id,),
    )
    seeded_db.expire_all()

    def _payments():
        return seeded_db.scalars(
            select(OrderEvent).where(OrderEvent.event_type == EventType.PAYMENT.value)
        ).all()

    before = {event.id for event in _payments()}
    result = installment_service.settle_early(
        seeded_db, contract.id, paid_on=TODAY, actor="pytest", pool_id=1
    )
    assert result.id == contract.id
    created = [event for event in _payments() if event.id not in before]
    assert len(created) == 1, "付清/超额付的行不得生成 PAYMENT，只差 1 分的行必须结清"
    assert created[0].amount == Decimal("0.01")

def test_recover_rejects_dangling_order(seeded_db):
    """installments.order_id 悬空 → 回收账号报「没有所属订单」（L1061）。"""
    _, contract = _pickup_overdue(seeded_db, "ACC-1061")
    _raw_sql(
        seeded_db,
        "UPDATE installments SET order_id = 999161 WHERE id = ?",
        (contract.id,),
    )
    with pytest.raises(Validation, match="分期合约没有所属订单"):
        installment_service.recover_account(
            seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="脏数据"
        )

def test_recover_rejects_dangling_account(seeded_db):
    """orders.account_id 悬空 → 回收账号报「关联账号不存在」（L1068）。"""
    account = _account(
        seeded_db,
        "ACC-1068",
        business_mode="DISTRIBUTION",
        inventory_type="PICKUP",
    )
    order = _order(seeded_db, order_type="TH", account_id=account.id)
    contract = _contract(seeded_db, order.id)
    contract.status = InstallmentStatus.OVERDUE.value
    seeded_db.flush()
    _raw_sql(seeded_db, "UPDATE orders SET account_id = 999168 WHERE id = ?", (order.id,))
    with pytest.raises(NotFound, match="分期合约关联账号不存在"):
        installment_service.recover_account(
            seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="脏数据"
        )

def test_record_sale_is_the_only_installment_resale_entrypoint():
    assert not hasattr(installment_service, "record_resale")
