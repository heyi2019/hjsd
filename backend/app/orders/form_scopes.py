"""orders.form_scopes：表单作用域注册表（全站单一事实源）。

设置页「表单字段」的作用域清单由此定义，经 GET /order-form-fields/scopes 下发；
前端只消费接口返回的作用域，不再维护第二份清单。
每个作用域对应一个可配置字段的业务表单（弹窗/面板），种子字段见各迁移。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FormScope:
    code: str
    label: str
    group: str


# 分组展示顺序即清单顺序；group code 由各前端映射为中文分组名。
GROUP_ORDER = "ORDER"
GROUP_ORDER_OP = "ORDEROP"
GROUP_INVENTORY = "INVENTORY"
GROUP_INVENTORY_OP = "INVOP"
GROUP_CUSTOMER = "CUSTOMER"
GROUP_PARTY = "PARTY"
GROUP_INSTALLMENT = "INSTALLMENT"
GROUP_FUND = "FUND"
GROUP_STUDIO = "STUDIO"

FORM_SCOPES: list[FormScope] = [
    # ---- 建单表单（迁移 0002）----
    FormScope("HS", "回收建单", GROUP_ORDER),
    FormScope("TH", "提号建单", GROUP_ORDER),
    FormScope("DG", "代挂建单", GROUP_ORDER),
    # ---- 订单操作（迁移 0019）----
    FormScope("ORDERCANC", "取消", GROUP_ORDER_OP),
    FormScope("ORDEREDIT", "编辑订单", GROUP_ORDER_OP),
    FormScope("ORDERLINK", "订单关联", GROUP_ORDER_OP),
    FormScope("ALLOCATION", "订单分润", GROUP_ORDER_OP),
    FormScope("REFUND", "资金收支", GROUP_ORDER_OP),
    # ---- 库存中心（迁移 0003；按库存中心页面操作顺序）----
    FormScope("SALE", "售出", GROUP_INVENTORY),
    FormScope("CONSIGN", "寄售", GROUP_INVENTORY),
    FormScope("INVREBATE", "返点", GROUP_INVENTORY),
    FormScope("INVREFUND", "取消", GROUP_INVENTORY),
    FormScope("INVEDIT", "编辑", GROUP_INVENTORY),
    FormScope("INVOID", "下架", GROUP_INVENTORY),
    # ---- 客户（迁移 0003 / 0004）----
    FormScope("LEAD", "客户需求池", GROUP_CUSTOMER),
    FormScope("LEADCLOSE", "关闭需求", GROUP_CUSTOMER),
    FormScope("LEADCONVERT", "需求转单", GROUP_CUSTOMER),
    # ---- 客户与合作方（迁移 0012）----
    FormScope("CUSTOMER", "客户建档", GROUP_PARTY),
    FormScope("COUNTERPARTY", "合作方建档", GROUP_PARTY),
    # ---- 分期（迁移 0003）----
    FormScope("INSTPAY", "分期收款", GROUP_INSTALLMENT),
    FormScope("INSTRECOVER", "分期回收", GROUP_INSTALLMENT),
    FormScope("INSTRESALE", "分期出售登记", GROUP_INSTALLMENT),
    FormScope("INSTDELIVER", "交付换绑", GROUP_INSTALLMENT),
    FormScope("INVCANCEL", "取消", GROUP_INSTALLMENT),
    FormScope("INSTCANCEL", "取消退款", GROUP_INSTALLMENT),
    FormScope("INSTSETTLE", "提前结清", GROUP_INSTALLMENT),
    FormScope("INSTDEFAULT", "违约登记", GROUP_INSTALLMENT),
    FormScope("INSTWAIVE", "减免", GROUP_INSTALLMENT),
    FormScope("INSTEXTEND", "展期", GROUP_INSTALLMENT),
    # ---- 资金（迁移 0003）----
    FormScope("FUNDDEPOSIT", "押金占用", GROUP_FUND),
    FormScope("FUNDFLOW", "录入流水", GROUP_FUND),
    FormScope("FUNDTRANSFER", "资金划转", GROUP_FUND),
    FormScope("FUNDRECON", "对账", GROUP_FUND),
    FormScope("FUNDCLEAR", "核销", GROUP_FUND),
    FormScope("FUNDREJECT", "拒绝", GROUP_FUND),
    FormScope("FUNDREVERSE", "资金冲销", GROUP_FUND),
    FormScope("FUNDRELEASE", "释放", GROUP_FUND),
    FormScope("FUNDLOSS", "损失", GROUP_FUND),
    FormScope("FUNDREPAIR", "划转修复", GROUP_FUND),
    FormScope("FUNDCANCEL", "取消押金", GROUP_FUND),
    # ---- 工作室（迁移 0019）----
    FormScope("STUDIOEXP", "工作室收支登记", GROUP_STUDIO),
    FormScope("STUDIOREJ", "工作室拒绝", GROUP_STUDIO),
    FormScope("STUDIOREV", "工作室冲销", GROUP_STUDIO),
]

SCOPE_CODES: frozenset[str] = frozenset(scope.code for scope in FORM_SCOPES)


def list_scopes() -> list[dict[str, str]]:
    """按分组聚合的清单，供响应模型直接使用。"""
    return [{"code": s.code, "label": s.label, "group": s.group} for s in FORM_SCOPES]


__all__ = ["FORM_SCOPES", "FormScope", "SCOPE_CODES", "list_scopes"]
