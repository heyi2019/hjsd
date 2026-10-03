"""M0 领域模型 —— 按 PRD 002v2.0 重建。

基类用 `app.db_v2.BaseV2`，与旧库物理隔离。

与旧 models.py 的关键差异（不可回退的四项）：

1. **双资金池**：`pools` 是主数据（可创建），`cashflow.pool_id` 必填。
   旧模型只有 `category` 字符串，无法核算池余额。
2. **业务与资金池解耦**：业务类型是主数据（`order_type_defs`），可自由新增；
   与池的关系是多对多（`order_type_pools`），不写死绑定。
   返点不是业务，拆到 `rebate_records` 附属表。
3. **事件流**：`order_events` 用 5 种事件（BUY/SELL/REBATE/TRANSFER/CANCEL）
   表达业务动作，`offset_event_id` 支持过账型成对冲销。
4. **业务编号**：所有实体有 `*_no` 业务单号，唯一且创建后不可改。
   数据库自增 id 仅作内部外键，不对外暴露。

金额一律 `Numeric(12,2)`，禁止 float。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import (
    Boolean, Date, ForeignKey, Index, Integer, JSON, Numeric, String, Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db_v2 import BaseV2 as Base

# ---------------------------------------------------------------------------
# 枚举常量（封闭集合，禁止在业务代码里写字面量）
# ---------------------------------------------------------------------------

# 业务类型：这是**种子数据**而非封闭枚举。
# 业务可自由新增（见 OrderTypeDef），新增只需在 order_type_defs 建一行，
# 不改代码、不改表。返点不在此列——它是附加收入（见 RebateRecord）。
SEED_ORDER_TYPES = [
    {"code": "HS",   "name": "回收",   "capital_type": "STOCK",    "sort_order": 1},
    {"code": "TH",   "name": "提号",   "capital_type": "PASS_THRU", "sort_order": 2},
    {"code": "DG",   "name": "代挂",   "capital_type": "ZERO",     "sort_order": 3},
    {"code": "DFQ",  "name": "代分期", "capital_type": "CREDIT",   "sort_order": 4},
]

# 资金性质：注册表，可扩展。新增时在此登记。
CAPITAL_TYPES = {
    "STOCK": "库存型（买号占用资金）",
    "PASS_THRU": "过账型（资金过手不占库存）",
    "ZERO": "零本金（不动用资金）",
    "CREDIT": "垫资型（占用资金且有账期）",
}

# 事件类型
EVENT_TYPES = ("BUY", "SELL", "REBATE", "TRANSFER", "CANCEL")

# 现金流性质
NATURE_TYPES = ("EXTERNAL_IN", "BUSINESS_IN", "BUSINESS_OUT", "INTERNAL")

# 池类型。这是**注册表**而非封闭枚举：新增池类型时在此登记即可，
# 不需要改表结构。当前三类覆盖已知场景，预留扩展位。
POOL_TYPES = {
    "INVEST": "投资池",
    "PROFIT": "利润池",
    "OTHER": "其他",
}

# 事件金额拆分口径
PORTIONS = ("PRINCIPAL", "PROFIT", "GROSS")

# 池的资金归属。这是权益核算的关键维度：
# OWNED 自有（工作室的钱，计入权益）
# CUSTODY 代管（客户/同行的钱，暂存不归己，**不计入权益**）
# THIRD_PART 第三方（平台保证金等）
OWNERSHIPS = ("OWNED", "CUSTODY", "THIRD_PART")

# 账号状态
ACCOUNT_STATUS = ("在库", "已售", "分期中", "已退")

# 关联状态：禁止 AUTO_MATCHED（PRD V22）
LINK_STATUS = ("LINKED", "UNLINKED", "ORPHAN")

# 返点类型
REBATE_TYPES = ("首保", "续保", "收号")

# 风险等级
RISK_LEVELS = ("NORMAL", "SECOND", "HIGH_RISK")

# 运营消耗类别：必须与源数据逐字一致，含斜杠（PRD 警告）
OPERATING_COST_CATEGORIES = ("房租/日用", "办公用品", "员工薪资", "运营")


# ---------------------------------------------------------------------------
# 资金池（主数据，可创建）
# ---------------------------------------------------------------------------

class Pool(Base):
    """资金池。余额由cashflow 聚合得出，此处不存余额字段。

    规则：
    - code 创建后不可修改（V18），name 可改
    - 有流水后禁止物理删除，只能 status=disabled（V17）
    """

    __tablename__ = "pools"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    pool_type: Mapped[str] = mapped_column(String(16), default="OTHER")
    #: 资金归属，决定该池余额是否计入权益。代管资金不属工作室，不进权益。
    ownership: Mapped[str] = mapped_column(String(16), default="OWNED")
    status: Mapped[str] = mapped_column(String(16), default="active")
    note: Mapped[str] = mapped_column(Text, default="")

    cashflows: Mapped[list["CashFlow"]] = relationship(back_populates="pool")


# ---------------------------------------------------------------------------
# 账号（在途库存）
# ---------------------------------------------------------------------------

class Account(Base):
    """在途账号。

    双重标识（PRD §2.1.1）：
    - account_no：业务编号，对外引用
    - game_account：账号号（QQ 等），唯一索引但允许 NULL
    - bind_phone：**不可**作唯一键（实测 32 条仅 11 个不同值，V21）
    """

    __tablename__ = "accounts"
    __table_args__ = (
        Index("ix_accounts_game_account", "game_account", unique=True),
        Index("ix_accounts_status", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_no: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)

    # 账号号：允许为空（未取得账号号时先挂单）
    game_account: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None)
    game_password: Mapped[str] = mapped_column(String(128), default="")
    bind_phone: Mapped[str] = mapped_column(String(20), default="")

    buy_date: Mapped[date] = mapped_column(Date, nullable=False)
    cost_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))
    sale_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))

    status: Mapped[str] = mapped_column(String(16), default="在库")
    risk_level: Mapped[str] = mapped_column(String(16), default="NORMAL")

    # 渠道为多值集合：实测 27/36 条同时投放 3 个渠道（V8）
    channels: Mapped[list] = mapped_column(JSON, default=list)

    recycler: Mapped[str] = mapped_column(String(32), default="")
    camp_id: Mapped[str] = mapped_column(String(32), default="")
    account_info: Mapped[str] = mapped_column(Text, default="")
    wallet_verified: Mapped[str] = mapped_column(String(16), default="")
    has_second: Mapped[bool] = mapped_column(Boolean, default=False)
    remark: Mapped[str] = mapped_column(Text, default="")

    orders: Mapped[list["Order"]] = relationship(back_populates="account")
    installments: Mapped[list["Installment"]] = relationship(back_populates="account")


# ---------------------------------------------------------------------------
# 订单主表（只存汇总）
# ---------------------------------------------------------------------------

class Order(Base):
    """订单主表。只存汇总，逐笔信息在order_events。

    `order_type` 引用 `order_type_defs.code`，业务可自由新增（V24/V32）。
    返点不是业务，见 RebateRecord。
    `link_status`：历史订单无法回溯关联，标 UNLINKED，不做不可靠自动匹配（V22）。
    """

    __tablename__ = "orders"
    __table_args__ = (
        Index("ix_orders_type", "order_type"),
        Index("ix_orders_trade_date", "trade_date"),
        Index("ix_orders_link_status", "link_status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_no: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)

    #: 业务类型 code，取值来自 order_type_defs 表，不在代码里枚举。
    order_type: Mapped[str] = mapped_column(String(16), nullable=False)
    #: 资金性质，默认取业务类型定义；**可在录入时按单覆盖**（如 DG 混合单改判 STOCK）。
    capital_type: Mapped[str] = mapped_column(String(16), default="ZERO")
    status: Mapped[str] = mapped_column(String(16), default="open")

    trade_date: Mapped[date] = mapped_column(Date, nullable=False)
    gross_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))
    principal: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))
    profit: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))

    account_id: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id"), nullable=True, default=None
    )
    link_status: Mapped[str] = mapped_column(String(16), default="UNLINKED")

    # 参与人：多人订单需拆分利润（V9），两者都参与
    recycler: Mapped[str] = mapped_column(String(32), default="")
    seller: Mapped[str] = mapped_column(String(32), default="")

    # 回款归属不在订单上：钱进哪个池由order_events.pool_id 决定。
    # 早期版本在此设principal_pool_id / profit_pool_id 两个固定字段，
    # 等于把「本金→投资款池、利润→利润池」写死；新增第三个池时无法表达。
    # 池归属是**资金流属性**，属事件层，不属订单层。

    remark: Mapped[str] = mapped_column(Text, default="")

    account: Mapped[Account | None] = relationship(back_populates="orders")
    events: Mapped[list["OrderEvent"]] = relationship(
        back_populates="order", cascade="all, delete-orphan"
    )
    rebates: Mapped[list["RebateRecord"]] = relationship(back_populates="source_order")


# ---------------------------------------------------------------------------
# 订单事件流（核心）
# ---------------------------------------------------------------------------

class OrderEvent(Base):
    """动作事件流。一笔「买号→售出」= 2 条 event 挂同一 order。

    `offset_event_id`：过账型业务（TH提号）的 BUY 与 SELL 需互相引用，
    成对冲销时自动核销，避免时点错配导致库存虚增。
    """

    __tablename__ = "order_events"
    __table_args__ = (
        Index("ix_events_order", "order_id"),
        Index("ix_events_type", "event_type"),
        Index("ix_events_date", "occurred_on"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_no: Mapped[str] = mapped_column(String(48), unique=True, nullable=False)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), nullable=False)

    event_type: Mapped[str] = mapped_column(String(16), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)

    #: 金额拆分：同一SELL 事件里，本金回投资款池、利润回利润池，
    #: 需拆成两条 event（或用下列字段标记），故这里记录本条属于哪部分。
    #: PRINCIPAL 本金 / PROFIT 利润 / GROSS 全额（提号等不拆的场景）
    portion: Mapped[str] = mapped_column(String(16), default="GROSS")

    #: 本条资金流的目标池。池可自由创建，故用 FK 而非硬编码枚举。
    pool_id: Mapped[int | None] = mapped_column(ForeignKey("pools.id"), nullable=True)
    counterparty: Mapped[str] = mapped_column(String(128), default="")
    note: Mapped[str] = mapped_column(Text, default="")

    # 过账型冲销引用
    offset_event_id: Mapped[int | None] = mapped_column(
        ForeignKey("order_events.id"), nullable=True, default=None
    )

    order: Mapped[Order] = relationship(back_populates="events")


# ---------------------------------------------------------------------------
# 返点明细（附属表，非订单）
# ---------------------------------------------------------------------------

class RebateRecord(Base):
    """返点记录。**不是独立业务**，是四类业务成单后的附加收入。

    `source_order_id`：新录入必填并校验指向真实 orders.id（V25）；
    历史 19 笔允许 NULL，但须link_status=UNLINKED（Q20 已裁决：后续人工补录）。
    """

    __tablename__ = "rebate_records"
    __table_args__ = (Index("ix_rebate_source", "source_order_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id"), nullable=True, default=None
    )
    link_status: Mapped[str] = mapped_column(String(16), default="UNLINKED")

    channel: Mapped[str] = mapped_column(String(32), default="")
    rebate_type: Mapped[str] = mapped_column(String(16), default="")  # 首保/续保/收号
    rate: Mapped[Decimal] = mapped_column(Numeric(6, 4), default=Decimal(0))
    base_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))
    platform_fee: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))
    net_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))

    settled_on: Mapped[date | None] = mapped_column(Date, nullable=True, default=None)
    remark: Mapped[str] = mapped_column(Text, default="")

    source_order: Mapped[Order | None] = relationship(back_populates="rebates")


# ---------------------------------------------------------------------------
# 资金流水（唯一入口）
# ---------------------------------------------------------------------------

class CashFlow(Base):
    """资金流水。每笔必须有 pool_id（V15）。

    nature 四值：
    - EXTERNAL_IN  外部注入（股本）           影响余额，不影响损益
    - BUSINESS_IN   经营流入（售出回款/返点）  影响余额，仅差价影响损益
    - BUSINESS_OUT  经营流出（买号/运营/薪资） 影响余额，仅运营消耗影响损益
    - INTERNAL      池间划转成对增减，**不影响损益**（V16）

    transfer_id：关联成对的两条 INTERNAL 流水，保证两池增减对称可追溯。
    """

    __tablename__ = "cashflow"
    __table_args__ = (
        Index("ix_cf_pool_date", "pool_id", "occurred_on"),
        Index("ix_cf_nature", "nature"),
        Index("ix_cf_transfer", "transfer_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    flow_no: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)

    pool_id: Mapped[int] = mapped_column(ForeignKey("pools.id"), nullable=False)
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    nature: Mapped[str] = mapped_column(String(16), nullable=False)
    category: Mapped[str] = mapped_column(String(32), default="")
    direction: Mapped[str] = mapped_column(String(8), default="")  # 收入/支出
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))

    order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id"), nullable=True, default=None
    )
    # 池间划转成对关联：两条流水共享同一transfer_id
    transfer_id: Mapped[str | None] = mapped_column(String(32), nullable=True, default=None)
    source: Mapped[str] = mapped_column(String(16), default="manual")  # manual/event
    remark: Mapped[str] = mapped_column(Text, default="")

    pool: Mapped[Pool] = relationship(back_populates="cashflows")


# ---------------------------------------------------------------------------
# 分期合约
# ---------------------------------------------------------------------------

class Installment(Base):
    """代分期合约。须校验 首付 <= 本金 <= 首付 + 期数×每期（V11）。"""

    __tablename__ = "installments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    inst_no: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    account_id: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id"), nullable=True, default=None
    )
    link_status: Mapped[str] = mapped_column(String(16), default="ORPHAN")

    principal: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))
    down_payment: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))
    periods: Mapped[int] = mapped_column(Integer, default=0)
    per_period: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))
    interest: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))
    paid: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))

    status: Mapped[str] = mapped_column(String(16), default="进行中")  # 进行中/断分期/已完成
    next_pay_date: Mapped[date | None] = mapped_column(Date, nullable=True, default=None)
    rebind_date: Mapped[date | None] = mapped_column(Date, nullable=True, default=None)
    buyer_contact: Mapped[str] = mapped_column(String(128), default="")
    remark: Mapped[str] = mapped_column(Text, default="")

    account: Mapped[Account | None] = relationship(back_populates="installments")


# ---------------------------------------------------------------------------
# 需求池（被动等待业务，不占用经营池资金）
# ---------------------------------------------------------------------------

class Lead(Base):
    """客户需求。被动等待业务，不主动投入资金，与订单板块是两条独立线。"""

    __tablename__ = "leads"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    demand: Mapped[str] = mapped_column(Text, default="")
    task_type: Mapped[str] = mapped_column(String(16), default="")  # 代蹲/代出/定找
    client: Mapped[str] = mapped_column(String(32), default="")
    budget: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal(0))
    status: Mapped[str] = mapped_column(String(16), default="寻找中")
    created_on: Mapped[date | None] = mapped_column(Date, nullable=True, default=None)
    remark: Mapped[str] = mapped_column(Text, default="")


# ---------------------------------------------------------------------------
# 业务类型主数据（可新增，与资金池解耦）
# ---------------------------------------------------------------------------

class OrderTypeDef(Base):
    """业务类型定义。**业务可自由新增**，不需要改代码或改表。

    与资金池的关系是**多对多**，通过 order_type_pools 关联表表达：
    同一业务可以把本金走A 池、利润走 B 池；换一个业务也可以复用同样的池。
    两者**不写死绑定**——业务是「做什么」，池是「钱在哪」，是两个独立维度。

    字段说明：
    - code：稳定标识（HS/TH/DG/DFQ），创建后不可改
    - capital_type：该业务的**默认**资金性质，可在录入时按单覆盖
    - is_active：停用后不可用于新订单，历史保留
    """

    __tablename__ = "order_type_defs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(16), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(32), nullable=False)
    capital_type: Mapped[str] = mapped_column(String(16), default="ZERO")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str] = mapped_column(Text, default="")

    pool_links: Mapped[list["OrderTypePool"]] = relationship(
        back_populates="order_type", cascade="all, delete-orphan"
    )


class OrderTypePool(Base):
    """业务类型 ↔ 资金池 的多对多关联。

    表达「某业务的某一部分资金默认走哪个池」：
      - PRINCIPAL 部分 → 投资款池
      - PROFIT 部分 → 利润池

    一行 = 一个 (业务, 资金部分, 池) 的默认路由。
    录入订单时若未显式指定池，按此表路由；显式指定则覆盖默认值。
    """

    __tablename__ = "order_type_pools"
    __table_args__ = (
        UniqueConstraint("order_type_id", "portion", name="uq_otp_type_portion"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_type_id: Mapped[int] = mapped_column(
        ForeignKey("order_type_defs.id"), nullable=False, index=True
    )
    pool_id: Mapped[int] = mapped_column(ForeignKey("pools.id"), nullable=False)
    #: PRINCIPAL 本金部分 / PROFIT 利润部分
    portion: Mapped[str] = mapped_column(String(16), default="GROSS")

    order_type: Mapped[OrderTypeDef] = relationship(back_populates="pool_links")
    pool: Mapped[Pool] = relationship()
