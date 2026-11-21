"""MASTER-01 产品别名兼容：旧别名必须仍可解析为当前主数据。"""

from datetime import date

import pytest
from pydantic import ValidationError

from app.business.orders.schemas import OrderAccountSnapshot, OrderCreate
from app.business.inventory.schemas import AccountProfileUpdate


def test_product_contract_uses_canonical_account_fields_only():
    snapshot = OrderAccountSnapshot.model_validate({"game_account": "acc-001", "game_type": "王者荣耀"})
    assert snapshot.game_account == "acc-001"
    assert snapshot.game_type == "王者荣耀"

    order = OrderCreate.model_validate({
        "order_type": "HS",
        "trade_date": date(2026, 10, 28),
        "account_snapshot": {"game_account": "acc-002", "game_type": "原神"},
    })
    assert order.account_snapshot is not None
    assert order.account_snapshot.game_account == "acc-002"
    assert order.account_snapshot.game_type == "原神"

    profile = AccountProfileUpdate.model_validate({"game_account": "acc-003", "game_type": "PUBG"})
    assert profile.game_account == "acc-003"
    assert profile.game_type == "PUBG"


@pytest.mark.parametrize("payload", [
    {"product": "acc-001"},
    {"product_type": "王者荣耀"},
])
def test_product_aliases_are_rejected(payload):
    with pytest.raises(ValidationError):
        OrderAccountSnapshot.model_validate(payload)


def test_product_aliases_are_rejected_even_with_canonical_value():
    with pytest.raises(ValidationError):
        OrderAccountSnapshot.model_validate({"game_account": "acc-a", "product": "acc-b"})
