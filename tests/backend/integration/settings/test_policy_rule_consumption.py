"""POLICY-01 经营规则 → 真实计算的消费契约（改前必读）。

背景：2026-10-26 起经营规则支持配参数，但此前**只有返点费率**被后端读取，
其余参数只是版本留痕。本文件锁死新接入的两条链路，防止「配了不生效」回潮：

1. REBATE 的返点费率规则
   —— 费率只留痕，不推算返点金额；返点金额必须明确填写。
2. INSTALLMENT 的 `config.service_fee_rate`（+ `config.base`）
   —— service_fee 省略（None）时按规则补算；**显式传 0 表示不收，不被规则覆盖**。

「省略」与「传 0」必须可区分：这是两条链路成立的前提，也是为什么
service_fee 用 Optional 而不是 0 作哨兵。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.stocks.profile import create_account
from app.core.errors import Validation
from app.finance.rebates import create_rebate
from app.value_added_services import create as inst_create
from app.orders.create import create_order
from app.orders.events import post_event
from app.policy import definitions as policy_definitions
from app.policy import versions as policy_versions

D = date(2026, 10, 17)


def _publish(seeded_db, policy_code: str, config: dict) -> None:
    definition = policy_definitions.create_definition(
        seeded_db,
        policy_code=policy_code,
        name=f"{policy_code} 规则",
        scope_type="GLOBAL",
        actor="pytest",
    )
    policy_versions.create_version(
        seeded_db,
        definition["id"],
        effective_from=D,
        config=config,
        actor="pytest",
    )


def _order_with_buy(seeded_db, *, game_account: str) -> int:
    account = create_account(
        seeded_db,
        game_account=game_account,
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
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("1000"),
        occurred_on=D,
        actor="pytest",
        pool_id=1,
    )
    return order.id


# ---------------------------------------------------------------- 返点金额

def test_rebate_amount_is_explicit(seeded_db):
    record = create_rebate(
        seeded_db,
        source_order_id=_order_with_buy(seeded_db, game_account="rule-explicit-amount"),
        rebate_type="BUY",
        amount=Decimal("300"),
        collected_on=D,
        actor="pytest",
    )
    assert record.amount == Decimal("300.00")


# ------------------------------------------------------------ 分期服务费率
def _pickup_order(seeded_db, *, game_account: str) -> int:
    """TH 订单要求账号为 DISTRIBUTION/PICKUP。"""
    account = create_account(
        seeded_db,
        game_account=game_account,
        business_mode="DISTRIBUTION",
        inventory_type="PICKUP",
        actor="pytest",
    )
    order = create_order(
        seeded_db,
        order_type="TH",
        trade_date=D,
        actor="pytest",
        account_id=account.id,
    )
    return order.id


def _sign(seeded_db, order_id: int, **kwargs):
    return inst_create.create_installment(
        seeded_db,
        order_id=order_id,
        contract_type="PICKUP_SALE",
        principal=Decimal("700"),
        down_payment=Decimal("100"),
        periods=2,
        per_period=Decimal("300"),
        first_due_on=D,
        actor="pytest",
        **kwargs,
    )


def test_installment_service_fee_derived_from_rule(seeded_db):
    _publish(seeded_db, "INSTALLMENT", {"service_fee_rate": "3", "base": "PRINCIPAL", "periods": "2"})
    contract = _sign(seeded_db, _pickup_order(seeded_db, game_account="rule-fee-derived"))
    # 700 × 3% = 21.00
    assert contract.service_fee == Decimal("21.00")


def test_explicit_zero_service_fee_is_respected(seeded_db):
    """显式 0 = 不收服务费，不能被规则覆盖（区分「省略」与「填 0」）。"""
    _publish(seeded_db, "INSTALLMENT", {"service_fee_rate": "3", "base": "PRINCIPAL"})
    contract = _sign(
        seeded_db, _pickup_order(seeded_db, game_account="rule-fee-zero"), service_fee=Decimal("0")
    )
    assert contract.service_fee == Decimal("0.00")


def test_installment_service_fee_defaults_to_zero_without_rule(seeded_db):
    contract = _sign(seeded_db, _pickup_order(seeded_db, game_account="rule-fee-none"))
    assert contract.service_fee == Decimal("0.00")


def test_installment_rule_rejects_unsupported_base(seeded_db):
    _publish(seeded_db, "INSTALLMENT", {"service_fee_rate": "3", "base": "PROFIT"})
    with pytest.raises(Validation):
        _sign(seeded_db, _pickup_order(seeded_db, game_account="rule-fee-bad-base"))
