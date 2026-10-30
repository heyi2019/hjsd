"""经营规则 → 真实计算的消费契约（改前必读）。

背景：2026-10-26 起经营规则支持配参数，但此前**只有返点费率**被后端读取，
其余参数只是版本留痕。本文件锁死新接入的两条链路，防止「配了不生效」回潮：

1. REBATE 的 `config.base`（GROSS / PRINCIPAL / PROFIT）
   —— base_amount 省略时按订单事件派生，口径与报表同源（app/orders/amounts.py）。
2. INSTALLMENT 的 `config.service_fee_rate`（+ `config.base`）
   —— service_fee 省略（None）时按规则补算；**显式传 0 表示不收，不被规则覆盖**。

「省略」与「传 0」必须可区分：这是两条链路成立的前提，也是为什么
service_fee / base_amount 用 Optional 而不是 0 作哨兵。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.stocks import service as account_service
from app.core.errors import Validation
from app.finance import service as finance_service
from app.installments import service as installment_service
from app.orders import service as order_service
from app.policy import service as policy_service

D = date(2026, 10, 17)


def _publish(seeded_db, policy_code: str, config: dict) -> None:
    definition = policy_service.create_definition(
        seeded_db,
        policy_code=policy_code,
        name=f"{policy_code} 规则",
        scope_type="GLOBAL",
        actor="pytest",
    )
    version = policy_service.create_version(
        seeded_db,
        definition["id"],
        effective_from=D,
        config=config,
        actor="pytest",
    )


def _order_with_buy(seeded_db, *, game_account: str) -> int:
    account = account_service.create_account(
        seeded_db,
        game_account=game_account,
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = order_service.create_order(
        seeded_db,
        order_type="HS",
        owner_id=1,
        trade_date=D,
        actor="pytest",
        account_id=account.id,
    )
    order_service.post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("1000"),
        occurred_on=D,
        actor="pytest",
        pool_id=1,
    )
    return order.id


# ---------------------------------------------------------------- 返点基数
def test_rebate_base_derived_from_rule_principal(seeded_db):
    _publish(seeded_db, "REBATE", {"base": "PRINCIPAL", "rate": "5"})
    record = finance_service.create_rebate(
        seeded_db,
        source_order_id=_order_with_buy(seeded_db, game_account="rule-base-principal"),
        rebate_type="BUY",
        collected_on=D,
        actor="pytest",
    )
    # 买入成本 1000 → 基数由规则派生，无需手填
    assert record.base_amount == Decimal("1000.00")
    assert record.rate == Decimal("5.00")


def test_rebate_base_gross_without_sell_is_rejected(seeded_db):
    """GROSS 取卖出收入；未卖出时为 0，必须报错而不是静默记 0 元返点。"""
    _publish(seeded_db, "REBATE", {"base": "GROSS", "rate": "5"})
    with pytest.raises(Validation):
        finance_service.create_rebate(
            seeded_db,
            source_order_id=_order_with_buy(seeded_db, game_account="rule-base-gross"),
            rebate_type="BUY",
            collected_on=D,
            actor="pytest",
        )


def test_rebate_base_requires_explicit_or_rule_when_no_base_configured(seeded_db):
    _publish(seeded_db, "REBATE", {"rate": "5"})
    with pytest.raises(Validation):
        finance_service.create_rebate(
            seeded_db,
            source_order_id=_order_with_buy(seeded_db, game_account="rule-base-none"),
            rebate_type="BUY",
            collected_on=D,
            actor="pytest",
        )


def test_explicit_rebate_base_wins_over_rule(seeded_db):
    _publish(seeded_db, "REBATE", {"base": "PRINCIPAL", "rate": "5"})
    record = finance_service.create_rebate(
        seeded_db,
        source_order_id=_order_with_buy(seeded_db, game_account="rule-base-explicit"),
        rebate_type="BUY",
        base_amount=Decimal("300"),
        collected_on=D,
        actor="pytest",
    )
    assert record.base_amount == Decimal("300.00")


# ------------------------------------------------------------ 分期服务费率
def _dfq_order(seeded_db, *, game_account: str) -> int:
    account = account_service.create_account(
        seeded_db,
        game_account=game_account,
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = order_service.create_order(
        seeded_db,
        order_type="DFQ",
        trade_date=D,
        actor="pytest",
        account_id=account.id,
    )
    return order.id


def _sign(seeded_db, order_id: int, **kwargs):
    return installment_service.create_installment(
        seeded_db,
        order_id=order_id,
        contract_type="ADVANCE_PURCHASE",
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
    contract = _sign(seeded_db, _dfq_order(seeded_db, game_account="rule-fee-derived"))
    # 700 × 3% = 21.00
    assert contract.service_fee == Decimal("21.00")


def test_explicit_zero_service_fee_is_respected(seeded_db):
    """显式 0 = 不收服务费，不能被规则覆盖（区分「省略」与「填 0」）。"""
    _publish(seeded_db, "INSTALLMENT", {"service_fee_rate": "3", "base": "PRINCIPAL"})
    contract = _sign(
        seeded_db, _dfq_order(seeded_db, game_account="rule-fee-zero"), service_fee=Decimal("0")
    )
    assert contract.service_fee == Decimal("0.00")


def test_installment_service_fee_defaults_to_zero_without_rule(seeded_db):
    contract = _sign(seeded_db, _dfq_order(seeded_db, game_account="rule-fee-none"))
    assert contract.service_fee == Decimal("0.00")


def test_installment_rule_rejects_unsupported_base(seeded_db):
    _publish(seeded_db, "INSTALLMENT", {"service_fee_rate": "3", "base": "PROFIT"})
    with pytest.raises(Validation):
        _sign(seeded_db, _dfq_order(seeded_db, game_account="rule-fee-bad-base"))
