"""FLOW-01 tests/backend/test_flow_config_driven：跨模块流程 E —— 配置影响业务（BIZ-FLOW-CONFIG）。

业务链路（项目跨模块测试·流程 E）
-------------------------------
表单字段配置（required 翻转）直接改变建单校验行为：同一自定义字段在选填态允许缺省、
在必填态强制要求。验证「经营规则走配置、配置改动即改行为」这条核心口径。

测试分类：服务级集成（seeded_db 校验 DB 状态）。
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.errors import Validation
from app.orders import service as orders_service
from app.orders.form_field_admin import (
    create_order_form_field,
    update_order_form_field,
)

TODAY = date(2026, 10, 8)


def _hs_order(seeded_db, *, game_account, with_field=None):
    form_extra = {"extra_flow_e_memo": with_field} if with_field is not None else None
    return orders_service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_snapshot={"game_account": game_account, "game_type": "王者荣耀"},
        form_extra=form_extra,
    )


def test_flow_e_form_field_config_drives_validation(seeded_db):
    """BIZ-FLOW-CONFIG-001：翻转表单字段 required，建单校验行为随之改变。"""
    # 以「选填」建一个 HS 自定义表单字段（section=EXTRA，is_custom=True）。
    field = create_order_form_field(
        seeded_db, order_type_code="HS", field_key="extra_flow_e_memo",
        label="流程E测试备注", actor="pytest", field_type="TEXT",
        required=False, section="EXTRA",
    )

    # 选填态：不填该字段也能建单成功。
    o1 = _hs_order(seeded_db, game_account="flow-e-1")
    assert o1.status == "ACTIVE"
    assert o1.form_extra is None

    # 翻转配置为「必填」。
    update_order_form_field(seeded_db, field.id, required=True, actor="pytest")

    # 必填态：缺少该字段建单被拒。
    with pytest.raises(Validation):
        _hs_order(seeded_db, game_account="flow-e-2")

    # 必填态：补齐该字段则通过。
    o2 = _hs_order(seeded_db, game_account="flow-e-3", with_field="hello")
    assert o2.status == "ACTIVE"
    assert o2.form_extra["extra_flow_e_memo"] == "hello"
