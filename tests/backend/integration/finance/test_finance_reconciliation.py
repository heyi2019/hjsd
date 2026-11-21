"""DEPOSIT-01 对账契约：TestReconciliation 拆出（4 tests）。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.business.inventory.profile import create_account
from app.core.errors import Validation
from app.shared.operation_operators import list_operation_operators
from app.domain.foundation import Pool
from app.domain.trade import Cashflow
from app.funds.reconciliation import create_reconciliation, resolve_reconciliation
from app.business.create import create_order
from app.business.events import post_event

TODAY = date(2026, 10, 4)


def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None
    return pool


def _active_order(seeded_db) -> int:
    account = create_account(
        seeded_db,
        game_account=f"finance-active-{uuid4().hex[:10]}",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_id=account.id,
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    return order.id


class TestReconciliation:
    @pytest.mark.parametrize("raw_ids", [[[1]], [0], [True], ["1"]])
    def test_reconciliation_rejects_invalid_unmatched_flow_ids(
        self, seeded_db, raw_ids
    ):
        invest = _pool(seeded_db, "HJ_INVEST")

        with pytest.raises(Validation, match="正整数"):
            create_reconciliation(
                seeded_db,
                pool_id=invest.id,
                reconciled_on=TODAY,
                account_label="招商银行卡",
                statement_balance=Decimal("0.00"),
                unmatched_flow_ids=raw_ids,
                actor="finance",
            )

    def test_reconciliation_snapshots_difference_and_unmatched_flows(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        flow = Cashflow(
            flow_no="CF-RECON-1",
            pool_id=invest.id,
            occurred_on=TODAY,
            category="OTHER",
            direction="IN",
            amount=Decimal("100.00"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(flow)
        seeded_db.flush()

        item = create_reconciliation(
            seeded_db,
            pool_id=invest.id,
            reconciled_on=TODAY,
            account_label="招商银行卡",
            statement_balance=Decimal("90.00"),
            unmatched_flow_ids=[flow.id],
            reason="银行手续费尚未入账",
            actor="finance",
            operator_user_ids=[1],
        )

        assert item.system_balance == Decimal("100.00")
        assert item.difference == Decimal("-10.00")
        assert item.unmatched_flow_ids == [flow.id]
        assert item.status == "OPEN"

        resolved = resolve_reconciliation(
            seeded_db, item.id, actor="finance", reason="已完成银行核对", operator_user_ids=[1]
        )
        assert resolved.status == "RESOLVED"
        assert resolved.resolved_by == "finance"

        with pytest.raises(Validation, match="已核销"):
            resolve_reconciliation(
                seeded_db, item.id, actor="finance", reason="重复核销"
            )

    def test_reconciliation_requires_reason_for_difference(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(Validation, match="差异原因"):
            create_reconciliation(
                seeded_db,
                pool_id=invest.id,
                reconciled_on=TODAY,
                account_label="银行卡",
                statement_balance=Decimal("1.00"),
                actor="finance",
            )

    def test_reconciliation_actions_persist_action_operators(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        item = create_reconciliation(
            seeded_db,
            pool_id=invest.id,
            reconciled_on=TODAY,
            account_label="动作快照账户",
            statement_balance=Decimal("0.00"),
            actor="pytest",
            operator_user_ids=[1, 2],
        )
        resolve_reconciliation(
            seeded_db,
            item.id,
            actor="pytest",
            reason="已完成核对",
            operator_user_ids=[2],
        )

        rows = list_operation_operators(
            seeded_db,
            entity_type="reconciliation",
            entity_id=item.id,
        )
        assert {row.operation_key: row.operator_user_ids for row in rows} == {
            "CREATE": [1, 2],
            "RESOLVE": [2],
        }


