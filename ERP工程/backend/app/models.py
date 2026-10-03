"""数据模型：accounts / orders / cashflow / installments / leads。
核心约束：Order 强制 principal + profit 双字段，total = principal + profit。
双荷包(本金荷包/利润荷包)是聚合视图(ProfitService)，非物理表。
枚举值统一用 String 存，取值见《数据字典》。
"""
from datetime import date
from decimal import Decimal

from sqlalchemy import (
    Boolean, Date, ForeignKey, Integer, Numeric, String, Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Account(Base):
    __tablename__ = "accounts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    recycle_date: Mapped[date] = mapped_column(Date, nullable=False)
    principal: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(0))
    sale_price: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(0))
    account_info: Mapped[str] = mapped_column(Text, default="")
    account_pwd: Mapped[str] = mapped_column(String(64), default="")
    bind_phone: Mapped[str] = mapped_column(String(20), default="")
    channel: Mapped[str] = mapped_column(String(32), default="")  # 盼之/螃蟹/千寻/同行/氪金联盟
    status: Mapped[str] = mapped_column(String(16), default="在库")  # 在库/已售/分期中/已退
    recycler: Mapped[str] = mapped_column(String(32), default="")
    has_second: Mapped[bool] = mapped_column(Boolean, default=False)
    wallet_verified: Mapped[str] = mapped_column(String(16), default="")  # 已注销/未注销
    camp_id: Mapped[str] = mapped_column(String(32), default="")
    remark: Mapped[str] = mapped_column(Text, default="")

    orders: Mapped[list["Order"]] = relationship(back_populates="account")


class Order(Base):
    __tablename__ = "orders"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    type: Mapped[str] = mapped_column(String(32))  # 回收/代挂/氪金联盟提号/代分期/转续保/返点
    principal: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(0))
    profit: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(0))
    total: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(0))
    recycler: Mapped[str] = mapped_column(String(32), default="")
    seller: Mapped[str] = mapped_column(String(32), default="")
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=True)
    wallet: Mapped[str] = mapped_column(String(16), default="利润荷包")  # 本金荷包/利润荷包
    channel: Mapped[str] = mapped_column(String(32), default="")
    query_no: Mapped[str] = mapped_column(String(64), default="")
    remark: Mapped[str] = mapped_column(Text, default="")

    account: Mapped["Account"] = relationship(back_populates="orders")
    cashflows: Mapped[list["CashFlow"]] = relationship(back_populates="order")


class CashFlow(Base):
    __tablename__ = "cashflow"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    category: Mapped[str] = mapped_column(String(32))  # 投资款/房租日用/办公用品/运营/员工薪资/其他
    direction: Mapped[str] = mapped_column(String(8))  # 收入/支出
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), nullable=True)
    remark: Mapped[str] = mapped_column(Text, default="")

    order: Mapped["Order"] = relationship(back_populates="cashflows")


class Installment(Base):
    __tablename__ = "installments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=True)
    principal: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(0))
    down_payment: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(0))
    periods: Mapped[int] = mapped_column(Integer, default=0)
    per_period: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(0))
    interest: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(0))
    paid: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(0))
    status: Mapped[str] = mapped_column(String(16), default="进行中")  # 进行中/断分期/已完成
    buyer_contact: Mapped[str] = mapped_column(String(64), default="")
    next_pay_date: Mapped[date] = mapped_column(Date, nullable=True)


class Lead(Base):
    __tablename__ = "leads"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    demand: Mapped[str] = mapped_column(Text, default="")
    task_type: Mapped[str] = mapped_column(String(16), default="")  # 代蹲/定找/代出
    client: Mapped[str] = mapped_column(String(32), default="")
    budget: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="寻找中")  # 寻找中/已完成
