from datetime import date

import pytest
from pydantic import ValidationError

from app.orders.schemas import OrderAccountSnapshot, OrderCreate
from app.stocks.router import AccountProfileUpdate


def test_product_aliases_normalize_to_canonical_account_fields():
    snapshot = OrderAccountSnapshot.model_validate({"product": "acc-001", "product_type": "王者荣耀"})
    assert snapshot.game_account == "acc-001"
    assert snapshot.game_type == "王者荣耀"

    order = OrderCreate.model_validate({
        "order_type": "HS",
        "trade_date": date(2026, 10, 28),
        "product": "acc-002",
        "product_type": "原神",
    })
    assert order.game_account == "acc-002"
    assert order.game_type == "原神"

    profile = AccountProfileUpdate.model_validate({"product": "acc-003", "product_type": "PUBG"})
    assert profile.game_account == "acc-003"
    assert profile.game_type == "PUBG"


def test_product_aliases_reject_conflicting_duplicate_values():
    with pytest.raises(ValidationError, match="game_account 与 product 不能同时填写不同值"):
        OrderAccountSnapshot.model_validate({"game_account": "acc-a", "product": "acc-b"})
