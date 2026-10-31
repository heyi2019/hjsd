"""交易账号：库存账号主档（ACC-01）。"""

from __future__ import annotations

from app.core.database import Base
from app.core.money import Amount
from app.domain.base import AuditMixin
from app.domain.enums import (
    AccountStatus,
    BusinessMode,
    InventoryType,
    InventoryStatus,
)
from datetime import date
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    event,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import (
    Mapped,
    mapped_column,
)

class Account(Base, AuditMixin):
    """游戏账号台账：每行就是一个可独立交易的产品实体。

    ``game_account`` 是产品标识，``game_type`` 是产品类型；同一标识可因复购
    产生多条独立库存记录，彼此拥有独立成本、状态和执行流水。
    """

    __tablename__ = "stocks"
    __table_args__ = (
        CheckConstraint(
            f"status IN {AccountStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="account_status_valid",
        ),
        UniqueConstraint("stock_no", name="uq_accounts_stock_no"),
        Index("ix_accounts_status", "status"),
        CheckConstraint("cost_amount >= 0", name="cost_nonneg"),
        CheckConstraint(
            f"business_mode IS NULL OR business_mode IN {BusinessMode.values()!r}",
            name="account_business_mode_valid",
        ),
        CheckConstraint(
            f"inventory_type IS NULL OR inventory_type IN {InventoryType.values()!r}",
            name="account_inventory_type_valid",
        ),
        CheckConstraint(
            "business_mode IS NULL OR inventory_type IS NULL OR "
            "(business_mode = 'SELF' AND inventory_type = 'RECOVERY') OR "
            "(business_mode = 'DISTRIBUTION' AND inventory_type IN "
            "('PICKUP', 'CONSIGNMENT'))",
            name="account_inventory_context_valid",
        ),
        CheckConstraint(
            f"inventory_status IN {InventoryStatus.values()!r}"
            .replace("[", "(").replace("]", ")"),
            name="account_inventory_status_valid",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    game_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    business_mode: Mapped[str | None] = mapped_column(String(24), nullable=True)
    inventory_type: Mapped[str | None] = mapped_column(String(24), nullable=True)
    # 增值服务维度（与业务类型独立）：STOCK_SALE=自营分期。
    value_added_service: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 库存编号：台账唯一编码 KU + 四位流水（系统生成，不可手改）。
    stock_no: Mapped[str | None] = mapped_column(String(32), nullable=True)
    game_account: Mapped[str | None] = mapped_column(String(128), nullable=True)
    game_password: Mapped[str | None] = mapped_column(String(256), nullable=True)
    channel_region: Mapped[str | None] = mapped_column(String(128), nullable=True)
    bound_phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    has_secondary: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    platform: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=AccountStatus.WAITING.value
    )
    # 独立库存口径：只表达在库/出库；status 保留账号生命周期原因，订单和分期另有各自状态。
    inventory_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=InventoryStatus.IN_STOCK.value
    )
    buy_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    cost_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    account_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    account_images: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 表单字段配置体系：INVEDIT 等作用域自定义字段值（与 Order.form_extra 同构）。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)


def _inventory_status_for_account_status(status: object) -> str:
    return (
        InventoryStatus.IN_STOCK.value
        if status == AccountStatus.WAITING.value
        else InventoryStatus.OUT_OF_STOCK.value
    )


@event.listens_for(Account.status, "set", retval=False)
def _sync_inventory_status(target: Account, value: object, _old_value: object, _initiator: object) -> object:
    """账号生命周期变化时同步物理库存口径，避免 INSTALLMENT 被当作在库。"""
    if value is not None:
        target.inventory_status = _inventory_status_for_account_status(value)
    return value
