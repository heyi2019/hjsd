"""INSTALLMENT-02 分期写路径守卫（pay/cancel/waive/extend 与结清，从 test_installments_service.py 逐字拆出）。

既有 test_installments_contract.py 偏路由/契约层：create_installment 的
合约类型与计划校验、waive/extend/settle_early 的守卫、recover_account 的
处置守卫。本文件只保留当前订单一一绑定模型仍支持的分期路径。

末尾一组用例专门覆盖「外键 / 精度保证不可达」的 6 行防御分支：
- L315 / L676 / L739 / L1061 / L1068：依赖外键（orders.account_id → accounts.id
  SET NULL、installments.order_id → orders.id RESTRICT）。正常 ORM 路径删父行只
  会置 NULL，不留悬空引用，故常规测试到不了。
- L975（settle_early 循环内 `outstanding <= 0: continue`）：rows 已按
  `received + waived < due` 过滤，正常数据下 outstanding 恒 > 0，该分支不可达。
  原用例需构造 received=0.996 的超精度脏行，PG 存不进去，曾以 skip 挂起；
  [2026-11-03] 改为把「不可达」本身写成可执行断言（三层保证各一条用例）：
  `test_amount_columns_lock_two_decimal_precision`（列 scale=2 且 0.996→1.00、
  该行被查询排除）、`test_overpaid_schedule_rejected_by_check_constraint`
  （ck_installment_schedules_settled_amount_within_due 拒绝超额付）、
  `test_settle_early_filters_settled_rows_but_keeps_one_cent`（付清行被过滤、
  只差 1 分仍结清）。任一层松动即报警，提示守卫重新变为可达。
  **裁决（11-03）：不删**——它防的不是今天的过滤，而是「循环内陈旧读」：若 pay()
  将来支持跨期顺延，前一期收款会把后一期补满，此时跳过是该期正确语义，删掉反而
  让提前结清抛 Validation 直接失败。已在 settlement.py 就近写明，改源码别只删 if。

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
from sqlalchemy import select

from app.core.errors import Conflict, NotFound, Validation
from app.domain.enums import (
    InstallmentContractType,
    InstallmentStatus,
    ScheduleStatus)
from app.domain.trade import InstallmentSchedule, OrderEvent
from app.business.installments import create as inst_create
from app.business.installments import recovery as inst_recovery
from app.business.installments.repayments.waive import waive_schedule as inst_waive
from app.business.installments.repayments.extend import extend_schedule as inst_extend
from app.business.installments import settlement as inst_settlement
from app.business.orders.create import create_order
from app.business.orders.events import post_event

TODAY = date(2026, 10, 12)
FUTURE = date(2026, 11, 30)


def _account(
    seeded_db,
    game_account: str,
    *,
    business_mode="SELF",
    inventory_type="RECOVERY",
):
    from app.business.inventory.profile import create_account

    return create_account(
        seeded_db,
        game_account=game_account,
        business_mode=business_mode,
        inventory_type=inventory_type,
        actor="pytest",
    )

def _order(seeded_db, *, order_type="TH", account_id=None, trade_date=TODAY):
    return create_order(
        seeded_db,
        order_type=order_type,
        trade_date=trade_date,
        actor="pytest",
        account_id=account_id,
    )

def _buy(seeded_db, order_id: int, amount="800"):
    post_event(
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
    return inst_create.create_installment(
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

def _recovered(seeded_db, game_account: str):
    """返回 (order, contract)：已完成账号回收、合约 CLOSED。"""
    order, contract = _pickup_overdue(seeded_db, game_account)
    inst_recovery.recover_account(
        seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="回收"
    )
    seeded_db.refresh(order)
    seeded_db.refresh(contract)
    return order, contract

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
        inst_waive(
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
        inst_waive(
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
        inst_extend(
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
        inst_extend(
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
        inst_extend(
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
        inst_extend(
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
    updated = inst_extend(
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
        inst_settlement.settle_early(
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
        inst_settlement.settle_early(
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
        inst_recovery.recover_account(
            seeded_db, contract.id, occurred_on=TODAY, actor="pytest", note="回收"
        )  # 1054-1058
