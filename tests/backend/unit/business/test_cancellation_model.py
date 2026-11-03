"""STATE-01 取消模型的独立规则测试。"""
from app.domain.enums import Direction
from app.orders.cancellation_model import cancellation_direction_for_offset_type


def test_cancel_direction_follows_the_original_cashflow_direction():
    """买入/成本的取消收回资金，售出的取消向买家退款。"""
    assert cancellation_direction_for_offset_type("BUY") == Direction.IN.value
    assert cancellation_direction_for_offset_type("COST") == Direction.IN.value
    assert cancellation_direction_for_offset_type("SELL") == Direction.OUT.value
    assert cancellation_direction_for_offset_type("PAYMENT") == Direction.OUT.value
