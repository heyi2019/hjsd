"""FLOW-01 tests/backend/test_flow_config_driven：跨模块流程 E —— 配置影响业务（BIZ-FLOW-CONFIG）。

业务链路（项目跨模块测试·流程 E）
-------------------------------
表单字段配置（required 翻转）直接改变建单校验行为：同一自定义字段在选填态允许缺省、
在必填态强制要求。验证「字段配置改动即改行为」这条核心口径。

测试分类：服务级集成（seeded_db 校验 DB 状态）。
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.errors import Validation
from app.business.create import create_order
from app.business.form_field_admin import (
    create_order_form_field,
    update_order_form_field,
)

TODAY = date(2026, 10, 8)


def _hs_order(seeded_db, *, game_account, with_field=None):
    form_extra = {"extra_flow_e_memo": with_field} if with_field is not None else None
    return create_order(
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
    _hs_order(seeded_db, game_account="flow-e-1")

    # 翻转配置为「必填」。
    update_order_form_field(seeded_db, field.id, required=True, actor="pytest")

    # 必填态：缺少该字段建单被拒。
    with pytest.raises(Validation):
        _hs_order(seeded_db, game_account="flow-e-2")

    # 必填态：补齐该字段则通过。
    _hs_order(seeded_db, game_account="flow-e-3", with_field="hello")


def test_order_custom_field_condition_uses_account_snapshot(seeded_db):
    game_type = create_order_form_field(
        seeded_db, order_type_code="HS", field_key="game_type", label="游戏类型", actor="pytest",
    )
    game_type.is_custom = False
    seeded_db.flush()
    create_order_form_field(
        seeded_db, order_type_code="HS", field_key="account_receipt", label="账号凭据",
        required_when={"field": "game_type", "op": "eq", "values": ["王者荣耀"]},
        section="ACCOUNT_PRODUCT", actor="pytest",
    )

    common = {"order_type": "HS", "trade_date": TODAY, "actor": "pytest"}
    snapshot = {"game_account": "conditional-required", "game_type": "王者荣耀"}
    with pytest.raises(Validation, match="账号凭据"):
        create_order(seeded_db, **common, account_snapshot=snapshot)
    with pytest.raises(Validation, match="账号凭据"):
        create_order(seeded_db, **common, account_snapshot=snapshot, form_extra={"game_type": "其他"})

    order = create_order(
        seeded_db, **common, account_snapshot=snapshot, form_extra={"account_receipt": "凭据A"},
    )
    from app.domain.trade import Account
    assert seeded_db.get(Account, order.account_id).form_extra["account_receipt"] == "凭据A"
    create_order(
        seeded_db, **common, account_snapshot={"game_account": "conditional-optional", "game_type": "其他"},
    )


@pytest.mark.parametrize(("has_secondary", "trigger"), [(True, "有"), (False, "无")])
def test_order_condition_matches_secondary_display_value(seeded_db, has_secondary, trigger):
    secondary = create_order_form_field(
        seeded_db, order_type_code="HS", field_key="has_secondary", label="有无二次", actor="pytest",
    )
    secondary.is_custom = False
    seeded_db.flush()
    create_order_form_field(
        seeded_db, order_type_code="HS", field_key="secondary_note", label="二次说明", actor="pytest",
        required_when={"field": "has_secondary", "op": "eq", "values": [trigger]},
    )
    with pytest.raises(Validation, match="二次说明"):
        create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
            account_snapshot={"game_account": f"secondary-{trigger}", "has_secondary": has_secondary},
        )
    saved = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_snapshot={"game_account": f"secondary-{trigger}", "has_secondary": has_secondary},
        form_extra={"secondary_note": "已确认"},
    )
    assert saved.form_extra["secondary_note"] == "已确认"
    create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_snapshot={"game_account": f"secondary-other-{trigger}", "has_secondary": not has_secondary},
    )
