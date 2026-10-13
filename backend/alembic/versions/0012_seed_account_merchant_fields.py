"""种子迁移：号商（游戏账号交易）客户档案推荐活字段（2026-10-13）

落地「方案1：执行 + 字段可在设置增删」。后端活字段机制（FieldDefinition /
EntityExtraValue）已完整，但库内无任何预置定义；本迁移幂等写入号商业务线
常用的客户辅助字段，让用户进「设置 → 活字段」即可看到并继续增删。

口径（第一性原理，BAS-04）：
- 活字段只承载辅助信息，绝不可覆盖核算字段；因此全部为 customer 实体、非敏感。
- required 一律 False：避免对存量客户（无值）的编辑/合并路径触发必填拦截；
  用户在设置页可按需把某些字段改为必填。
- 幂等：以 (entity_type, field_key) 唯一约束去重，重跑不重复插入、不报错。
- options 仅 SELECT / MULTI_SELECT 填 JSON 数组，其余为 NULL。

downgrade：按 field_key 列表删除本迁移写入的种子字段（仅本迁移引入，可逆）。
"""
from __future__ import annotations

import json

from alembic import op
from sqlalchemy import text

revision = "0012_seed_account_merchant_fields"
down_revision = "0011_orders_drop_draft_status"
branch_labels = None
depends_on = None

# 号商客户档案推荐活字段（非敏感、纯辅助）。
_SEED_FIELDS = [
    {
        "entity_type": "customer",
        "field_key": "trade_role",
        "label": "交易角色",
        "field_type": "SELECT",
        "options": ["买家", "卖家", "货源", "中介"],
        "required": False,
        "sort_order": 10,
    },
    {
        "entity_type": "customer",
        "field_key": "game_category",
        "label": "常玩品类",
        "field_type": "MULTI_SELECT",
        "options": ["王者荣耀", "和平精英", "原神", "英雄联盟", "其他"],
        "required": False,
        "sort_order": 20,
    },
    {
        "entity_type": "customer",
        "field_key": "credit_level",
        "label": "信用评级",
        "field_type": "SELECT",
        "options": ["优质", "普通", "观察", "黑名单"],
        "required": False,
        "sort_order": 30,
    },
    {
        "entity_type": "customer",
        "field_key": "referrer",
        "label": "转介绍人",
        "field_type": "TEXT",
        "options": None,
        "required": False,
        "sort_order": 40,
    },
    {
        "entity_type": "customer",
        "field_key": "with_compensation",
        "label": "是否包赔",
        "field_type": "BOOLEAN",
        "options": None,
        "required": False,
        "sort_order": 50,
    },
    {
        "entity_type": "customer",
        "field_key": "recovery_record",
        "label": "找回记录",
        "field_type": "SELECT",
        "options": ["无", "已找回", "协商中", "已赔付"],
        "required": False,
        "sort_order": 60,
    },
    {
        "entity_type": "customer",
        "field_key": "payment_consistency",
        "label": "付款一致性",
        "field_type": "SELECT",
        "options": ["一致", "偶发不一致", "不一致"],
        "required": False,
        "sort_order": 70,
    },
    {
        "entity_type": "customer",
        "field_key": "settle_preference",
        "label": "结算偏好",
        "field_type": "SELECT",
        "options": ["即时", "周结", "月结"],
        "required": False,
        "sort_order": 80,
    },
]


def upgrade() -> None:
    bind = op.get_bind()
    for f in _SEED_FIELDS:
        options = json.dumps(f["options"], ensure_ascii=False) if f["options"] else None
        # 幂等：仅当同 (entity_type, field_key) 不存在时插入。
        bind.execute(
            text(
                """
                INSERT INTO field_definitions
                    (entity_type, field_key, label, field_type, options, required, sort_order, is_active, created_by, updated_by)
                SELECT :entity_type, :field_key, :label, :field_type, :options, :required, :sort_order, 1, 'system', 'system'
                WHERE NOT EXISTS (
                    SELECT 1 FROM field_definitions
                    WHERE entity_type = :entity_type AND field_key = :field_key
                )
                """
            ),
            {
                "entity_type": f["entity_type"],
                "field_key": f["field_key"],
                "label": f["label"],
                "field_type": f["field_type"],
                "options": options,
                "required": int(f["required"]),
                "sort_order": f["sort_order"],
            },
        )


def downgrade() -> None:
    bind = op.get_bind()
    keys = [f["field_key"] for f in _SEED_FIELDS]
    bind.execute(
        text(
            "DELETE FROM field_definitions "
            "WHERE entity_type = 'customer' AND field_key IN :keys"
        ).bindparams(keys=tuple(keys)),
    )
