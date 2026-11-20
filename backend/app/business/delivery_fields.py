"""订单买号和卖号交付资料所使用的字段。"""

DELIVERY_FIELDS = (
    "bound_phone", "bound_phone_owner", "intermediary_platform", "intermediary_platform_other",
    "intermediary_type", "compensation_type", "delivery_responsible_ids",
)
SELL_DELIVERY_FIELDS = frozenset(f"sell_{key}" for key in DELIVERY_FIELDS)
