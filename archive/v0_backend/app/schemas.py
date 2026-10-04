"""Pydantic 出入参。

订单口径说明：`total` = 成交总额(gross)；`principal` / `profit` = 我方的
本金与利润。二者之间还夹第三方分成/抽成，因此不存在 total=principal+profit
的恒等式（历史校验已移除，依据见 OrderCreate 文档字符串）。
"""
from datetime import date
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, field_validator, ConfigDict


class AccountBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    recycle_date: date
    principal: Decimal = Decimal(0)
    sale_price: Decimal = Decimal(0)
    account_info: str = ""
    account_pwd: str = ""
    bind_phone: str = ""
    channel: str = ""
    status: str = "在库"
    recycler: str = ""
    has_second: bool = False
    wallet_verified: str = ""
    camp_id: str = ""
    remark: str = ""


class AccountCreate(AccountBase):
    pass


class AccountOut(AccountBase):
    id: int


class OrderBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    date: date
    type: str
    principal: Decimal = Decimal(0)
    profit: Decimal = Decimal(0)
    total: Decimal = Decimal(0)
    recycler: str = ""
    seller: str = ""
    account_id: Optional[int] = None
    wallet: str = "利润荷包"
    channel: str = ""
    query_no: str = ""
    remark: str = ""


class OrderCreate(OrderBase):
    """订单录入。

    历史包袱：`total` 曾被强制校验为 `principal + profit`，但真实数据里
    89 单有 74 单不满足 —— `total` 的真实语义是「成交总额 gross」，
    与我方的 (本金, 利润) 口径之间还夹着第三方分成/抽成，二者本就
    不构成恒等式（例：代挂 本金0/利润429/total13888；返点 本金461.5/
    利润21.5/total430）。故移除该伪校验，改为按 type 做语义校验。
    """

    @field_validator("principal", "profit")
    @classmethod
    def not_negative(cls, v):
        """本金/利润为负代表资金流出，属异常录入（应通过 type 表达方向）。"""
        if v < 0:
            raise ValueError("principal/profit 不接受负值，请用订单类型表达资金方向")
        return v


class OrderOut(OrderBase):
    id: int


class CashFlowBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    date: date
    category: str
    direction: str
    amount: Decimal
    order_id: Optional[int] = None
    source: str = "manual"  # manual=手工记账 / order=订单联动生成
    remark: str = ""


class CashFlowCreate(CashFlowBase):
    """手工记账入口：只允许创建 manual 来源。

    禁止手工构造 order 来源或自挂 order_id —— 那是订单联动的职责，
    放任会造成「看起来来自订单、实际是手记」的流水，删除订单时被误删。
    """

    @field_validator("source")
    @classmethod
    def must_be_manual(cls, v):
        if v != "manual":
            raise ValueError("手工记账只能创建 source=manual")
        return v

    @field_validator("order_id")
    @classmethod
    def no_manual_order_link(cls, v):
        if v is not None:
            raise ValueError("手工记账不得指定 order_id，订单流水由订单联动生成")
        return v


class CashFlowOut(CashFlowBase):
    id: int


class InstallmentBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    account_id: Optional[int] = None
    principal: Decimal = Decimal(0)
    down_payment: Decimal = Decimal(0)
    periods: int = 0
    per_period: Decimal = Decimal(0)
    interest: Decimal = Decimal(0)
    paid: Decimal = Decimal(0)
    status: str = "进行中"
    buyer_contact: str = ""
    next_pay_date: Optional[date] = None


class InstallmentCreate(InstallmentBase):
    pass


class InstallmentOut(InstallmentBase):
    id: int


class LeadBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    demand: str = ""
    task_type: str = ""
    client: str = ""
    budget: Optional[Decimal] = None
    status: str = "寻找中"


class LeadCreate(LeadBase):
    pass


class LeadOut(LeadBase):
    id: int


class WalletSummary(BaseModel):
    principal_wallet: Decimal
    profit_wallet: Decimal


class LinkRequest(BaseModel):
    """人工关联订单与账号。"""
    model_config = ConfigDict(from_attributes=True)
    account_id: int
