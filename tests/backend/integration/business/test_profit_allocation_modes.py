"""PROFIT-01 分润两种录入口径的契约测试。

口径（2026-10-26 用户裁决「不止可以填比例，也可以填金额，两个都选填」）：

- **按人模式**（items 不带 allocation_type）：每行一个姓名（user_id，空=公司归属），
  比例与金额都选填、同一行只能填一个。
  - 纯比例：合计必须 100%（沿用 BAS-06-03）。
  - 出现金额：金额合计不得超过订单利润，比例合计不得超过 100%。
- **按动作模式**（items 都带 allocation_type）：原四项结构不变，用于兼容旧数据/旧前端。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.stocks.profile import create_account
from app.core.errors import Validation
from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog
from app.orders.create import create_order
from app.orders.events import post_event
from app.policy import allocations as policy_allocations
from app.policy import definitions as policy_definitions
from app.reporting.r3_commission import r3_commission_reconciliation

D = date(2026, 10, 17)


def _order_with_profit(seeded_db, *, buy: str = "1000", sell: str = "1500") -> int:
    """造一单有已过账 BUY/SELL 的订单，利润 = sell - buy。"""
    account = create_account(
        seeded_db,
        game_account=f"alloc-{buy}-{sell}",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = create_order(
        seeded_db,
        order_type="HS",
        owner_id=1,
        trade_date=D,
        actor="pytest",
        account_id=account.id,
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal(buy),
        occurred_on=D, actor="pytest", pool_id=1,
    )
    post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal(sell),
        occurred_on=D, actor="pytest", pool_id=1,
    )
    return order.id


def test_person_mode_allows_same_user_in_two_roles(seeded_db):
    """同一人可担任多个角色（对齐 DB 唯一约束 uq_order_profit_alloc），但同角色不可重复。"""
    order_id = _order_with_profit(seeded_db)

    rows = policy_allocations.set_allocations(
        seeded_db,
        order_id,
        items=[
            {"user_id": 1, "role": "SALES", "allocation_rate": "60"},
            {"user_id": 1, "role": "SERVICE", "allocation_rate": "40"},
        ],
    )

    assert [row["role"] for row in rows] == ["SALES", "SERVICE"]

    with pytest.raises(Validation, match="同一角色下不可重复分润"):
        policy_allocations.set_allocations(
            seeded_db,
            order_id,
            items=[
                {"user_id": 1, "role": "SALES", "allocation_rate": "50"},
                {"user_id": 1, "role": "SALES", "allocation_rate": "50"},
            ],
        )


def test_person_mode_accepts_one_name_with_full_rate(seeded_db):
    """按人模式不再强制四项：一个人拿 100% 是合法的。"""
    order_id = _order_with_profit(seeded_db)

    rows = policy_allocations.set_allocations(
        seeded_db,
        order_id,
        items=[{"user_id": 1, "role": "OWNER", "allocation_rate": "100"}],
    )

    assert len(rows) == 1
    assert rows[0]["allocation_rate"] == "100.00"
    assert rows[0]["allocation_amount"] == "0.00"
    assert rows[0]["total_rate"] == "100.00"


def test_person_mode_rate_must_total_one_hundred_without_amount(seeded_db):
    order_id = _order_with_profit(seeded_db)

    with pytest.raises(Validation):
        policy_allocations.set_allocations(
            seeded_db,
            order_id,
            items=[
                {"user_id": 1, "role": "OWNER", "allocation_rate": "60"},
                {"user_id": 2, "role": "OWNER", "allocation_rate": "30"},
            ],
        )


def test_person_mode_accepts_amount_only(seeded_db):
    """按金额分润：金额落库，比例保持 0，合计校验改为金额口径。"""
    order_id = _order_with_profit(seeded_db)

    rows = policy_allocations.set_allocations(
        seeded_db,
        order_id,
        items=[
            {"user_id": 1, "role": "OWNER", "allocation_amount": "300"},
            {"user_id": 2, "role": "OWNER", "allocation_amount": "200"},
        ],
    )

    assert [row["allocation_amount"] for row in rows] == ["300.00", "200.00"]
    assert all(row["allocation_rate"] == "0.00" for row in rows)
    assert rows[0]["total_amount"] == "500.00"


def test_person_mode_rejects_rate_and_amount_on_the_same_row(seeded_db):
    order_id = _order_with_profit(seeded_db)

    with pytest.raises(Validation):
        policy_allocations.set_allocations(
            seeded_db,
            order_id,
            items=[{"user_id": 1, "role": "OWNER", "allocation_rate": "10", "allocation_amount": "100"}],
        )


def test_person_mode_amount_cannot_exceed_order_profit(seeded_db):
    """利润 500，填 600 必须拒绝——金额模式不能凭空超出可分利润。"""
    order_id = _order_with_profit(seeded_db, buy="1000", sell="1500")

    with pytest.raises(Validation):
        policy_allocations.set_allocations(
            seeded_db,
            order_id,
            items=[{"user_id": 1, "role": "OWNER", "allocation_amount": "600"}],
        )


def test_person_mode_amount_requires_positive_profit(seeded_db):
    """没有过账事件的订单没有利润，按金额分润应显式报错而不是记账 0。"""
    order = create_order(
        seeded_db, order_type="HS", owner_id=1, trade_date=D, actor="pytest"
    )

    with pytest.raises(Validation):
        policy_allocations.set_allocations(
            seeded_db, order.id, items=[{"user_id": 1, "role": "OWNER", "allocation_amount": "100"}]
        )


def test_person_mode_rejects_duplicate_people(seeded_db):
    order_id = _order_with_profit(seeded_db)

    with pytest.raises(Validation):
        policy_allocations.set_allocations(
            seeded_db,
            order_id,
            items=[
                {"user_id": 1, "role": "OWNER", "allocation_rate": "50"},
                {"user_id": 1, "role": "OWNER", "allocation_rate": "50"},
            ],
        )


def test_person_mode_company_row_has_no_user(seeded_db):
    """姓名可为空表示公司归属，但最多一行。"""
    order_id = _order_with_profit(seeded_db)

    rows = policy_allocations.set_allocations(
        seeded_db,
        order_id,
        items=[
            {"user_id": 1, "role": "OWNER", "allocation_rate": "60"},
            {"user_id": None, "role": "OWNER", "allocation_rate": "40"},
        ],
    )

    assert [row["user_id"] for row in rows] == [1, None]


def _latest_audit(seeded_db, entity_type: str, entity_id: int) -> AuditLog | None:
    return seeded_db.scalars(
        select(AuditLog)
        .where(AuditLog.entity_type == entity_type, AuditLog.entity_id == str(entity_id))
        .order_by(AuditLog.id.desc())
    ).first()


def test_person_allocation_writes_dedicated_audit_action(seeded_db):
    """分润审计单独成动作：不再混进 EXCEPTION_APPROVE（否则审计页按异常审批筛会串味）。"""
    order_id = _order_with_profit(seeded_db)

    policy_allocations.set_allocations(
        seeded_db,
        order_id,
        items=[{"user_id": 1, "role": "OWNER", "allocation_rate": "100"}],
    )

    entry = _latest_audit(seeded_db, "order", order_id)
    assert entry is not None
    assert entry.action == AuditAction.PROFIT_ALLOCATION_SET.value
    assert entry.action != AuditAction.EXCEPTION_APPROVE.value


def test_policy_definition_creation_audits_as_policy_change(seeded_db):
    """政策定义/版本属「变更经营规则」，不是「审批异常」。"""
    definition = policy_definitions.create_definition(
        seeded_db,
        policy_code="AUDIT_PROBE",
        name="审计动作探针",
        scope_type="GLOBAL",
        actor="pytest",
    )

    entry = _latest_audit(seeded_db, "policy_definition", int(definition["id"]))
    assert entry is not None
    assert entry.action == AuditAction.POLICY_CHANGE.value


def test_commission_report_uses_amount_as_payable_base(seeded_db):
    """报表口径：填金额时直接取金额作为应付基数，不再乘利润比例。"""
    order_id = _order_with_profit(seeded_db, buy="1000", sell="1500")
    policy_allocations.set_allocations(
        seeded_db,
        order_id,
        items=[{"user_id": 1, "role": "OWNER", "allocation_amount": "120"}],
    )

    report = r3_commission_reconciliation(seeded_db)
    rows = [row for group in report["groups"] for row in group.get("orders", [])]

    assert [row["profit_base"] for row in rows] == [Decimal("120.00")]


# ---- 亏损单分润（2026-11-05 用户裁决「亏损的时候分亏损」）----
# 亏损单按金额分润填负数，表示该人分担的亏损额。方向必须与订单盈亏一致，
# 且报表 base 取负值（`amount != 0` 判据；旧实现用 `> 0` 会把负数当未填而回退比例）。


def test_person_mode_allows_negative_amount_on_loss_order(seeded_db):
    """亏损单（利润 -500）填 -300：落库为负，报表 profit_base 也取 -300。"""
    order_id = _order_with_profit(seeded_db, buy="1500", sell="1000")

    rows = policy_allocations.set_allocations(
        seeded_db,
        order_id,
        items=[{"user_id": 1, "role": "OWNER", "allocation_amount": "-300"}],
    )

    assert [row["allocation_amount"] for row in rows] == ["-300.00"]
    assert all(row["allocation_rate"] == "0.00" for row in rows)

    report = r3_commission_reconciliation(seeded_db)
    entries = [row for group in report["groups"] for row in group.get("orders", [])]
    assert [row["profit_base"] for row in entries] == [Decimal("-300.00")]


def test_person_mode_rejects_positive_amount_on_loss_order(seeded_db):
    """亏损单填正数等于把亏损记成收益，必须拒绝。"""
    order_id = _order_with_profit(seeded_db, buy="1500", sell="1000")

    with pytest.raises(Validation):
        policy_allocations.set_allocations(
            seeded_db,
            order_id,
            items=[{"user_id": 1, "role": "OWNER", "allocation_amount": "300"}],
        )


def test_person_mode_rejects_over_shared_loss(seeded_db):
    """亏损 -500，合计 -600 属于超额分担，必须拒绝（按绝对值比较）。"""
    order_id = _order_with_profit(seeded_db, buy="1500", sell="1000")

    with pytest.raises(Validation):
        policy_allocations.set_allocations(
            seeded_db,
            order_id,
            items=[{"user_id": 1, "role": "OWNER", "allocation_amount": "-600"}],
        )


def test_person_mode_rejects_negative_amount_on_profit_order(seeded_db):
    """盈利单填负数同样是方向错误，必须拒绝。"""
    order_id = _order_with_profit(seeded_db, buy="1000", sell="1500")

    with pytest.raises(Validation):
        policy_allocations.set_allocations(
            seeded_db,
            order_id,
            items=[{"user_id": 1, "role": "OWNER", "allocation_amount": "-300"}],
        )
