"""REBATE-01 返点生命周期契约 + 分次结算模型层下线守卫。

2026-11-12 裁决：返点登记即确认收入，生命周期收窄为「登记 + 编辑」，
不再有删除/作废（delete_rebate 已移除，退回走资金中心录入 OUT 支出）。
"""

import importlib.util

from app.shared import business_numbering
from app.domain.base import Base
from app.domain import trade
from app.funds import rebates, router, schemas


def test_rebate_has_only_register_and_edit_lifecycle():
    """返点生命周期 = 登记 + 编辑；删除/作废与分次结算均属下线能力。"""
    legacy_names = (
        "settle_rebate",
        "list_rebate_settlements",
        "reverse_rebate_settlement",
        "settled_net_total",
        "void_rebate",
        "delete_rebate",
        "SettlementCreate",
        "SettlementOut",
        "SettlementReverse",
        "RebateVoid",
    )

    for module in (rebates, router, schemas):
        for name in legacy_names:
            assert not hasattr(module, name), f"{module.__name__}.{name} is obsolete"
    # 2026-11-12 去兼容：finance.service 再导出门面已删除
    assert importlib.util.find_spec("app.funds.service") is None


def test_rebate_settlement_model_layer_is_removed():
    """2026-11-05 裁决：返点分次结算表 / ORM / 编号器整体下线。

    已有库（含生产）保留历史表、不 drop，避免破坏历史数据；全新库由活动基线
    `create_all` 按 ORM 建表，所以 metadata 里不能再出现这张表，否则新装环境
    会又长出一张无人写入的死表。
    """
    assert "rebate_records" in Base.metadata.tables  # 前置：trade 模型已加载
    assert "rebate_settlements" not in Base.metadata.tables
    assert not hasattr(trade, "RebateSettlement")
    assert not hasattr(business_numbering, "rebate_settlement_no")
    assert "rebate_settlement_no" not in business_numbering.__all__
