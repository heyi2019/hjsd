from app.orders.order_detail.view.derived import _finance_type


def test_buy_finance_type_uses_order_cost_label():
    assert _finance_type("BUY", "OUT", order_type="HS") == "回收成本"
    assert _finance_type("BUY", "OUT", order_type="TH") == "提号成本"
    assert _finance_type("BUY", "OUT", order_type="DG") == "代挂成本"
