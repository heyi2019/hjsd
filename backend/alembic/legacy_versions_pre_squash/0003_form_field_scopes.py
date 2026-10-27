"""form_field_scopes：为 27 个业务表单作用域补充字段配置种子

将「建单表单字段配置」能力从 4 个建单类型（HS/TH/DG/DFQ）扩展到全部业务表单：
库存（售出/寄售/返点）、客户需求池、分期（9 个弹窗）、返点（3 个弹窗）、
资金（11 个弹窗）。order_type_code 本就是 2-10 位大写字母数字的自由字符串，
无需改表结构，仅补种子行。

种子 label 与 required 必须与各表单当前 UI 完全一致，保证开启配置能力后零行为变化；
用户后续在设置中改 label / required / is_active 才生效。

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-10-26 01:00:00.000000

"""
from __future__ import annotations

from typing import Sequence

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.trade import OrderFormField


revision: str = 'b2c3d4e5f6a7'
down_revision: str | None = 'a1b2c3d4e5f6'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 元组：(field_key, label, field_type, required, sort_order)
# 既有硬编码字段的 field_type 仅作展示参考，真正生效的是 required / is_active / label。
SEED: dict[str, list[tuple[str, str, str, bool, int]]] = {
    # ---- 库存 ----
    "SALE": [
        ("customer_id", "买家", "SELECT", True, 10),
        ("amount", "售出金额", "NUMBER", True, 20),
        ("payment_method", "付款方式", "SELECT", False, 30),
        ("pool_id", "收款资金账户", "SELECT", True, 40),
        ("down_payment", "首付金额", "NUMBER", False, 50),
        ("service_fee", "分期服务费总额", "NUMBER", False, 60),
        ("periods", "分期期数", "NUMBER", False, 70),
        ("per_period_service_fee", "每期服务费", "NUMBER", False, 80),
        ("per_period", "每期金额", "NUMBER", True, 90),
        ("first_due_on", "首期日期", "DATE", True, 100),
        ("note", "备注", "TEXT", False, 110),
    ],
    "CONSIGN": [
        ("platform_ids", "寄售平台", "MULTI_SELECT", True, 10),
    ],
    "INVREBATE": [
        ("rebate_type", "返点类型", "MULTI_SELECT", True, 10),
        ("base_amount", "返点金额", "NUMBER", True, 20),
        ("rate", "返点比例", "TEXT", False, 30),
        ("collected_on", "返点日期", "DATE", True, 40),
    ],
    # ---- 客户 ----
    "LEAD": [
        ("customer_id", "客户", "SELECT", True, 10),
        ("request_type", "需求类型", "SELECT", True, 20),
        ("budget", "预算", "NUMBER", False, 30),
        ("target", "需求目标", "TEXT", True, 40),
        ("note", "备注", "TEXT", False, 50),
    ],
    # ---- 分期 ----
    "INSTPAY": [
        ("period_no", "期次", "SELECT", False, 10),
        ("amount", "本次实收", "NUMBER", True, 20),
        ("paid_on", "收款日期", "DATE", True, 30),
    ],
    "INSTRECOVER": [
        ("occurred_on", "回收日期", "DATE", True, 10),
        ("note", "回收说明", "TEXT", True, 20),
    ],
    "INSTRESALE": [
        ("resale_order_id", "出售订单", "SELECT", True, 10),
        ("occurred_on", "出售日期", "DATE", True, 20),
        ("note", "出售说明", "TEXT", True, 30),
    ],
    "INSTDELIVER": [
        ("delivery_mode", "交付方式", "SELECT", True, 10),
        ("delivered_on", "换绑日期", "DATE", True, 20),
        ("note", "换绑凭证", "TEXT", True, 30),
    ],
    "INSTCANCEL": [
        ("cancelled_on", "取消日期", "DATE", True, 10),
        ("reason", "取消原因", "TEXT", True, 20),
    ],
    "INSTSETTLE": [
        ("paid_on", "结清日期", "DATE", True, 10),
        ("note", "备注", "TEXT", False, 20),
    ],
    "INSTDEFAULT": [
        ("reason", "违约原因", "TEXT", True, 10),
    ],
    "INSTWAIVE": [
        ("amount", "减免金额", "NUMBER", True, 10),
        ("waived_on", "减免日期", "DATE", True, 20),
        ("reason", "减免原因", "TEXT", True, 30),
    ],
    "INSTEXTEND": [
        ("new_due_on", "新到期日", "DATE", True, 10),
        ("reason", "展期原因", "TEXT", True, 20),
    ],
    # ---- 返点 ----
    "REBATE": [
        ("source_order_id", "来源订单", "SELECT", True, 10),
        ("rebate_type", "返点类型", "SELECT", True, 20),
        ("base_amount", "返点金额", "NUMBER", True, 30),
        ("rate", "返点比例", "TEXT", False, 40),
        ("collected_on", "返点日期", "DATE", True, 50),
    ],
    "REBSETTLE": [
        ("gross_amount", "到账金额", "NUMBER", True, 10),
        ("platform_fee", "平台手续费", "NUMBER", False, 20),
        ("pool_id", "回款池", "SELECT", True, 30),
        ("settled_on", "到账日期", "DATE", True, 40),
    ],
    "REBREVERSE": [
        ("reversed_on", "冲销日期", "DATE", True, 10),
        ("reason", "冲销原因", "TEXT", True, 20),
    ],
    # ---- 资金 ----
    "FUNDDEPOSIT": [
        ("pool_id", "资金池", "SELECT", True, 10),
        ("counterparty_id", "对手方 ID", "TEXT", False, 20),
        ("source_order_id", "来源订单 ID", "TEXT", False, 30),
        ("amount", "占用金额", "NUMBER", True, 40),
        ("paid_on", "占用日期", "DATE", True, 50),
        ("expected_release_on", "预计释放日期", "DATE", False, 60),
        ("note", "说明", "TEXT", False, 70),
    ],
    "FUNDFLOW": [
        ("pool_id", "资金池", "SELECT", True, 10),
        ("occurred_on", "发生日期", "DATE", True, 20),
        ("direction", "收支方向", "SELECT", True, 30),
        ("fund_nature", "资金性质", "SELECT", True, 40),
        ("accounting_attribute", "核算属性", "SELECT", True, 50),
        ("category", "类别", "TEXT", True, 60),
        ("amount", "金额", "NUMBER", True, 70),
        ("note", "摘要", "TEXT", True, 80),
    ],
    "FUNDTRANSFER": [
        ("source_pool_id", "转出资金池", "SELECT", True, 10),
        ("target_pool_id", "转入资金池", "SELECT", True, 20),
        ("amount", "划转金额", "NUMBER", True, 30),
        ("occurred_on", "划转日期", "DATE", True, 40),
        ("note", "说明", "TEXT", False, 50),
    ],
    "FUNDRECON": [
        ("pool_id", "资金池", "SELECT", True, 10),
        ("reconciled_on", "对账日期", "DATE", True, 20),
        ("account_label", "对账账户", "TEXT", True, 30),
        ("statement_balance", "账面余额", "NUMBER", True, 40),
        ("unmatched_flow_ids", "未达流水 ID", "TEXT", False, 50),
        ("reason", "差异原因", "TEXT", False, 60),
        ("note", "说明", "TEXT", False, 70),
    ],
    "FUNDCLEAR": [
        ("reason", "处理说明", "TEXT", True, 10),
    ],
    "FUNDREJECT": [
        ("reason", "拒绝原因", "TEXT", True, 10),
    ],
    "FUNDREVERSE": [
        ("reversed_on", "冲销日期", "DATE", True, 10),
        ("reason", "冲销原因", "TEXT", True, 20),
    ],
    "FUNDRELEASE": [
        ("amount", "释放金额", "NUMBER", True, 10),
        ("released_on", "释放日期", "DATE", True, 20),
    ],
    "FUNDLOSS": [
        ("amount", "损失金额", "NUMBER", True, 10),
        ("lost_on", "损失日期", "DATE", True, 20),
        ("category", "费用分类", "TEXT", True, 30),
        ("reason", "损失原因", "TEXT", True, 40),
    ],
    "FUNDREPAIR": [
        ("counterpart_pool_id", "缺失对端资金池", "SELECT", True, 10),
        ("reason", "修复原因", "TEXT", True, 20),
    ],
    "FUNDLOCK": [
        ("period", "会计账期", "TEXT", True, 10),
        ("note", "说明", "TEXT", False, 20),
    ],
}


def upgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        existing = {
            (row.order_type_code, row.field_key)
            for row in session.scalars(select(OrderFormField))
        }
        rows = []
        for code, fields in SEED.items():
            for key, label, ftype, required, order in fields:
                if (code, key) in existing:
                    continue
                rows.append(
                    OrderFormField(
                        order_type_code=code,
                        field_key=key,
                        label=label,
                        field_type=ftype,
                        required=required,
                        is_active=True,
                        sort_order=order,
                        locked=False,
                        created_by="system",
                        updated_by="system",
                    )
                )
        if rows:
            session.add_all(rows)
            session.commit()
    finally:
        session.close()


def downgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)
    try:
        for row in session.scalars(
            select(OrderFormField).where(OrderFormField.order_type_code.in_(SEED))
        ):
            session.delete(row)
        session.commit()
    finally:
        session.close()
