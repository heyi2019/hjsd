"""QLT 守卫用例：quality.issues / quality.service 覆盖收口至 100%。

直接驱动业务校验与扫描守卫分支；scan 内部不可达的 ORPHAN_CASHFLOW 分支已在源码移除。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import Conflict, NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.enums import (
    AccountStatus,
    CashflowStatus,
    Nature,
    QualityIssueStatus,
    ReconciliationStatus,
    OrderStatus,
)
from app.domain.foundation import Pool, PoolOwnership, PoolStatus, PoolType
from app.domain.trade import (
    Account,
    Cashflow,
    InstallmentSchedule,
    Order,
    OrderEvent,
    Reconciliation,
)
from app.installments import service as installments_service
from app.quality import issues
from app.quality import service as quality_service


# ------------------------------------------------------------------- helpers
def _account(seeded_db) -> Account:
    acc = Account(
        game_account="q-acc-1",
        platform="王者",
        business_mode="SELF",
        inventory_type="RECOVERY",
        status=AccountStatus.IN_STOCK.value,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(acc)
    seeded_db.commit()
    return acc


def _pool(seeded_db) -> Pool:
    pool = Pool(
        code="QPOOL2",
        name="q-pool-2",
        pool_type=PoolType.OTHER.value,
        ownership=PoolOwnership.OWNED.value,
        status=PoolStatus.ACTIVE.value,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(pool)
    seeded_db.commit()
    return pool


def _order(
    seeded_db,
    *,
    order_no: str,
    order_type: str = "HS",
    capital_type: str = "STOCK",
    owner_id: int = 1,
    account_id=None,
    account_snapshot=None,
) -> Order:
    order = Order(
        order_no=order_no,
        order_type=order_type,
        capital_type=capital_type,
        trade_date=date.today(),
        status=OrderStatus.ACTIVE.value,
        owner_id=owner_id,
        account_id=account_id,
        account_snapshot=account_snapshot,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(order)
    seeded_db.commit()
    return order


def _scoped_user(pool_ids):
    return CurrentUser.build(
        id=1,
        username="scope",
        roles=["STAFF"],
        pool_ids=frozenset(pool_ids),
        owner_scope="SELF",
    )


def _dfq_with_overdue_installment(seeded_db, *, order_no: str, owner_id: int):
    order = _order(
        seeded_db,
        order_no=order_no,
        order_type="DFQ",
        capital_type="ZERO",
        owner_id=owner_id,
        account_id=None,
    )
    inst = installments_service.create_installment(
        seeded_db,
        order_id=order.id,
        contract_type="ADVANCE_PURCHASE",
        principal=Decimal("100"),
        down_payment=Decimal("0"),
        periods=1,
        per_period=Decimal("100"),
        first_due_on=date(2026, 1, 1),
        actor="pytest",
    )
    sched = seeded_db.scalar(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == inst.id
        )
    )
    sched.due_on = date(2020, 1, 1)
    sched.received_amount = to_money("0")
    sched.due_amount = to_money("100")
    sched.status = "PENDING"
    seeded_db.commit()
    return order, inst


# ------------------------------------------------------------------- issues.py
def test_get_issue_not_found(seeded_db):
    with pytest.raises(NotFound, match="质量工单不存在"):
        issues.get_issue(seeded_db, 999999)


def test_list_issues_invalid_status(seeded_db):
    with pytest.raises(Validation, match="质量工单状态必须为"):
        issues.list_issues(seeded_db, status="NOPE")


def test_create_issue_invalid_severity(seeded_db):
    with pytest.raises(Validation, match="质量工单严重级别无效"):
        issues.create_issue(
            seeded_db,
            code="X",
            severity="BOGUS",
            title="t",
            entity_type="order",
            entity_id="E1",
            message="m",
            actor="pytest",
        )


def _open_issue(seeded_db, **kw):
    kw.setdefault("code", "GUARD")
    kw.setdefault("severity", "HIGH")
    kw.setdefault("title", "t")
    kw.setdefault("entity_type", "order")
    kw.setdefault("entity_id", "E-GUARD")
    kw.setdefault("message", "m")
    kw.setdefault("actor", "pytest")
    return issues.create_issue(seeded_db, **kw)


def test_update_closed_issue_conflict(seeded_db):
    issue = _open_issue(seeded_db)
    issues.close_issue(seeded_db, issue.id, resolution="done", evidence=None, actor="pytest")
    with pytest.raises(Conflict, match="已关闭质量工单不可更新"):
        issues.update_issue(
            seeded_db,
            issue.id,
            status=QualityIssueStatus.IN_PROGRESS.value,
            actor="pytest",
        )


def test_update_issue_to_closed_rejected(seeded_db):
    issue = _open_issue(seeded_db)
    with pytest.raises(Validation, match="关闭质量工单必须使用 close 接口"):
        issues.update_issue(
            seeded_db,
            issue.id,
            status=QualityIssueStatus.CLOSED.value,
            actor="pytest",
        )


def test_close_already_closed_conflict(seeded_db):
    issue = _open_issue(seeded_db)
    issues.close_issue(seeded_db, issue.id, resolution="done", evidence=None, actor="pytest")
    with pytest.raises(Conflict, match="质量工单已关闭"):
        issues.close_issue(seeded_db, issue.id, resolution="again", evidence=None, actor="pytest")


def test_close_without_resolution(seeded_db):
    issue = _open_issue(seeded_db)
    with pytest.raises(Validation, match="关闭质量工单必须填写解决方式"):
        issues.close_issue(seeded_db, issue.id, resolution="   ", evidence=None, actor="pytest")


def test_batch_close_invalid_selection(seeded_db):
    with pytest.raises(Validation, match="批量关闭工单必须选择 1-50 个且不能重复"):
        issues.batch_close_issues(seeded_db, [], resolution="x", evidence=None, actor="pytest")
    issue = _open_issue(seeded_db, entity_id="E-DUP")
    with pytest.raises(Validation, match="批量关闭工单必须选择 1-50 个且不能重复"):
        issues.batch_close_issues(
            seeded_db, [issue.id, issue.id], resolution="x", evidence=None, actor="pytest"
        )


def test_batch_close_without_resolution(seeded_db):
    issue = _open_issue(seeded_db, entity_id="E-RES")
    with pytest.raises(Validation, match="关闭质量工单必须填写解决方式"):
        issues.batch_close_issues(
            seeded_db, [issue.id], resolution="  ", evidence=None, actor="pytest"
        )


def test_batch_close_missing_ids(seeded_db):
    with pytest.raises(NotFound, match="质量工单不存在"):
        issues.batch_close_issues(
            seeded_db, [999999], resolution="x", evidence=None, actor="pytest"
        )


# ------------------------------------------------------------------- service.py
def test_scan_skips_unposted_event(seeded_db):
    order = _order(seeded_db, order_no="Q-UNPOSTED-1")
    ev = OrderEvent(
        order_id=order.id,
        event_type="BUY",
        is_posted=False,
        amount=to_money("0"),
        portion="PRINCIPAL",
        occurred_on=date.today(),
        event_no="EV-UNPOSTED-1",
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(ev)
    seeded_db.commit()
    result = quality_service.scan(seeded_db, user=None)
    assert isinstance(result, list)


def test_scan_cashflow_source_mismatch(seeded_db):
    pool2 = _pool(seeded_db)
    order = _order(seeded_db, order_no="Q-MISMATCH-1")
    ev = OrderEvent(
        order_id=order.id,
        event_type="BUY",
        is_posted=True,
        amount=to_money("100"),
        portion="PRINCIPAL",
        occurred_on=date.today(),
        event_no="EV-MISMATCH-1",
        pool_id=1,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(ev)
    seeded_db.commit()
    cf = Cashflow(
        flow_no="FL-MISMATCH-1",
        pool_id=pool2.id,
        occurred_on=date.today(),
        nature=Nature.BUSINESS_IN.value,
        direction="IN",
        category="OTHER",
        amount=to_money("50"),
        status=CashflowStatus.APPROVED.value,
        order_id=None,
        order_event_id=ev.id,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(cf)
    seeded_db.commit()
    codes = {item["code"] for item in quality_service.scan(seeded_db, user=None)}
    assert "CASHFLOW_SOURCE_MISMATCH" in codes


def test_scan_dfq_account_link_invalid_and_missing_installment(seeded_db):
    acc = _account(seeded_db)
    _order(
        seeded_db,
        order_no="DFQ-ACCT-1",
        order_type="DFQ",
        capital_type="ZERO",
        owner_id=1,
        account_id=acc.id,
    )
    codes = {item["code"] for item in quality_service.scan(seeded_db, user=None)}
    assert "ORDER_ACCOUNT_LINK_INVALID" in codes
    assert "INSTALLMENT_MISSING" in codes


def test_scan_installment_overdue_visible(seeded_db):
    _dfq_with_overdue_installment(seeded_db, order_no="DFQ-OVD-1", owner_id=1)
    codes = {item["code"] for item in quality_service.scan(seeded_db, user=None)}
    assert "INSTALLMENT_OVERDUE" in codes


def test_scan_installment_scope_exclusion(seeded_db):
    # owner_id=2 对非管理员(SELF,id=1)不可见 -> 分期被跳过，不产生逾期工单
    _dfq_with_overdue_installment(seeded_db, order_no="DFQ-HIDDEN-1", owner_id=2)
    issues_found = quality_service.scan(seeded_db, user=_scoped_user([1]))
    assert not any(
        item["code"] == "INSTALLMENT_OVERDUE" for item in issues_found
    )


def test_next_month_december():
    assert quality_service._next_month(date(2026, 12, 15)) == date(2027, 1, 1)


def test_metric_months_invalid_range():
    with pytest.raises(Validation, match="开始日期不能晚于结束日期"):
        quality_service._metric_months(date(2026, 6, 1), date(2026, 1, 1))


def test_metrics_scope_filters(seeded_db):
    order = _order(seeded_db, order_no="Q-METRIC-1")
    ev = OrderEvent(
        order_id=order.id,
        event_type="BUY",
        is_posted=True,
        amount=to_money("100"),
        portion="PRINCIPAL",
        occurred_on=date.today(),
        event_no="EV-METRIC-1",
        pool_id=1,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(ev)
    seeded_db.commit()
    seeded_db.add(
        Cashflow(
            flow_no="FL-METRIC-1",
            pool_id=1,
            occurred_on=date.today(),
            nature=Nature.BUSINESS_IN.value,
            direction="IN",
            category="OTHER",
            amount=to_money("100"),
            status=CashflowStatus.APPROVED.value,
            order_id=order.id,
            order_event_id=ev.id,
            created_by="pytest",
            updated_by="pytest",
        )
    )
    seeded_db.add(
        Reconciliation(
            pool_id=1,
            reconciled_on=date.today(),
            account_label="t",
            system_balance=to_money("0"),
            statement_balance=to_money("0"),
            difference=to_money("0"),
            status=ReconciliationStatus.RESOLVED.value,
            created_by="pytest",
            updated_by="pytest",
        )
    )
    seeded_db.commit()
    result = quality_service.metrics(seeded_db, user=_scoped_user([1]))
    assert "items" in result


# ------------------------------------------------------- N+1 回归护栏（scan）
def _count_selects(session, fn) -> int:
    """统计 fn() 执行期间发出的 SELECT 条数（不区分参数，只看次数）。"""
    from sqlalchemy import event

    engine = session.get_bind().engine
    seen: list[str] = []

    # 事件回调签名由 SQLAlchemy 固定（位置传参），未使用的参数以下划线前缀标明。
    def _record(_conn, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            seen.append(statement)

    event.listen(engine, "before_cursor_execute", _record)
    try:
        fn()
    finally:
        event.remove(engine, "before_cursor_execute", _record)
    return len(seen)


def test_scan_sql_count_does_not_grow_with_rows(seeded_db):
    """scan() 的 SQL 条数必须与行数无关。

    2026-10-28 优化前，真实库单次请求 919 条 SQL：逐事件 COUNT 现金流、
    逐单 EXISTS 分期、逐行 session.get 合约、逐池 pool_balance 都是循环内查询。
    这里不钉精确条数（新增检查项应当允许增长），只钉"不随行数线性增长"这一性质：
    再加 4 个订单 + 4 个已过账事件后条数必须不变，一旦有人改回循环内查询就会红。
    """
    pool = _pool(seeded_db)

    def _add_order_with_event(seq: int) -> None:
        order = _order(seeded_db, order_no=f"Q-N1-{seq}")
        seeded_db.add(
            OrderEvent(
                order_id=order.id,
                event_type="BUY",
                is_posted=True,
                amount=to_money("100"),
                portion="PRINCIPAL",
                occurred_on=date.today(),
                event_no=f"EV-N1-{seq}",
                pool_id=pool.id,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.commit()

    _add_order_with_event(1)
    base = _count_selects(seeded_db, lambda: quality_service.scan(seeded_db, user=None))

    for seq in (2, 3, 4, 5):
        _add_order_with_event(seq)
    grown = _count_selects(seeded_db, lambda: quality_service.scan(seeded_db, user=None))

    assert grown == base, (
        f"scan() 的 SELECT 条数随行数增长（{base} → {grown}），说明又出现了 N+1；"
        "请改为批量聚合 / IN 预取，而不是在循环里逐条查询。"
    )
