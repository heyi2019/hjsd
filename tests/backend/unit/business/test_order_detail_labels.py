from datetime import datetime

from app.orders.order_detail.view.derived import _finance_type
from app.orders.output_labels import _elapsed_label


def test_buy_finance_type_uses_order_cost_label():
    assert _finance_type("BUY", "OUT", order_type="HS") == "回收成本"
    assert _finance_type("BUY", "OUT", order_type="TH") == "提号成本"
    assert _finance_type("BUY", "OUT", order_type="DG") == "代挂成本"


def test_elapsed_label_uses_current_time_for_unsold_inventory():
    assert _elapsed_label(
        start=datetime(2026, 11, 10, 9, 30),
        end=None,
        now=datetime(2026, 11, 17, 16, 45),
    ) == "7天7小时15分"


def test_elapsed_label_clamps_same_day_date_only_sale_to_zero():
    assert _elapsed_label(
        start=datetime(2026, 11, 17, 2, 5),
        end=datetime(2026, 11, 17, 0, 0),
    ) == "0分"
