"""REBATE-01 返点登记 / 编辑 / 删除生命周期契约。"""

from app.finance import rebates, router, schemas, service


def test_rebate_has_only_register_edit_delete_lifecycle():
    legacy_names = (
        "settle_rebate",
        "list_rebate_settlements",
        "reverse_rebate_settlement",
        "settled_net_total",
        "void_rebate",
        "SettlementCreate",
        "SettlementOut",
        "SettlementReverse",
        "RebateVoid",
    )

    for module in (rebates, service, router, schemas):
        for name in legacy_names:
            assert not hasattr(module, name), f"{module.__name__}.{name} is obsolete"
