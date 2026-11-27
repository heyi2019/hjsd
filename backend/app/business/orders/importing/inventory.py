"""历史导入库存：校对原始凭证、保留编号并与订单关联。"""
from __future__ import annotations

from datetime import date, datetime, time
from decimal import Decimal
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.business.inventory.profile import create_account
from app.core.errors import Validation
from app.domain.enums import AccountStatus, AuditAction, SequenceKey
from app.domain.foundation import DocumentSequence
from app.domain.trade import Account, Order, OrderEvent
from app.settings.field_definitions.classification import classification_for_order_type
from app.shared.audit import record_audit

from .ledger_finance import PRICE_COLUMNS, HistoricalFinance

_STOCK_NUMBER = re.compile(r"KU_(?!00000)\d{5}$")


def imports_inventory(headers: tuple[str, ...]) -> bool:
    return bool(PRICE_COLUMNS.intersection(headers) and {"库存编号", "库存状态"}.intersection(headers))


def stock_number(record: dict[str, str]) -> str:
    number = record.get("库存编号", "").strip().upper()
    if number and not _STOCK_NUMBER.fullmatch(number):
        raise Validation("库存编号应为 KU_ 加五位数字，且不能为 00000")
    return number


def inventory_entry_time(record: dict[str, str]) -> datetime | None:
    raw = record.get("入库时间", "").strip()
    if not raw:
        return None
    try:
        value = datetime.fromisoformat(raw) if len(raw) > 10 else datetime.combine(date.fromisoformat(raw), time.min)
    except ValueError as exc:
        raise Validation("入库时间格式无效") from exc
    if value.tzinfo is not None:
        raise Validation("入库时间不支持时区")
    return value


def reserve_stock_numbers(session: Session, numbers: list[str]) -> None:
    """锁住库存序列并前移至显式导入号码之后，空号码由原编号器分配。"""
    sequence = session.scalar(select(DocumentSequence).where(
        DocumentSequence.sequence_key == SequenceKey.STOCK_NO.value,
    ).with_for_update().execution_options(populate_existing=True))
    if sequence is None or sequence.prefix != "KU_" or sequence.padding != 5:
        raise Validation("库存编号序列配置无效")
    if numbers:
        sequence.current_value = max(sequence.current_value, *(int(number[3:]) for number in numbers))
    session.flush()


def verify_existing_order(
    order: Order, record: dict[str, str], finance: HistoricalFinance | None,
    events: list[OrderEvent], profit: Decimal, game_type: str | None,
) -> None:
    """仅对与历史表事实一致的订单补库存，避免重建或修改原流水。"""
    if finance is None:
        raise Validation("补库存须提供原入库和售出金额用于核对")
    snapshot = order.account_snapshot or {}
    if (record.get("游戏账号/产品", "").strip() or None) != (snapshot.get("game_account") or None):
        raise Validation("游戏账号与已有订单不一致")
    if game_type != (snapshot.get("game_type") or None):
        raise Validation("游戏类型与已有订单不一致")
    if order.status != ("COMPLETED" if finance.sale_amount is not None else "ACTIVE"):
        raise Validation("订单状态与原表售出信息不一致")
    expected = []
    if finance.buy_amount is not None:
        expected.append(("BUY", finance.buy_amount, finance.buy_on))
    if finance.sale_amount is not None:
        expected.append(("SELL", finance.sale_amount, finance.sale_on))
    relevant = [event for event in events if event.is_posted and event.event_type in {"BUY", "SELL", "CANCEL"}]
    actual = [(event.event_type, event.amount, event.occurred_on) for event in relevant]
    if sorted(actual) != sorted(expected):
        raise Validation("已有订单的买入或售出事件与原表不一致")
    if finance.profit is not None and profit != finance.profit:
        raise Validation("已有订单利润与原表不一致")


def create_order_inventory(
    session: Session, order: Order, record: dict[str, str], *, actor: str,
    finance: HistoricalFinance | None, existing_order: bool,
) -> Account:
    classification = classification_for_order_type(order.order_type)
    if classification is None or order.account_id is not None:
        raise Validation("订单类型无效或已关联库存")
    snapshot = order.account_snapshot or {}
    account = create_account(
        session, actor=actor, game_account=snapshot.get("game_account"),
        game_type=snapshot.get("game_type"), business_mode=classification["business_mode"],
        inventory_type=classification["business_type"], game_password=snapshot.get("game_password"),
        camp_account=snapshot.get("camp_account"), channel_region=snapshot.get("channel_region"),
        bound_phone=snapshot.get("bound_phone"), has_secondary=snapshot.get("has_secondary"),
        account_description=snapshot.get("account_description"), note=snapshot.get("note"),
        extra_values=snapshot.get("extra_values"), historical_import=True,
        imported_stock_no=stock_number(record) or None,
    )
    account.inventory_entry_at = inventory_entry_time(record) or order.created_at.replace(microsecond=0)
    if existing_order:
        account.cost_amount = finance.buy_amount if finance and finance.buy_amount is not None else Decimal("0.00")
        account.buy_date = finance.buy_on if finance else None
        account.status = AccountStatus.SOLD.value if finance and finance.sale_amount is not None else AccountStatus.WAITING.value
        account.updated_by = actor
        record_audit(session, action=AuditAction.ACCOUNT_UPDATE, entity_type="account", entity_id=account.stock_no,
                     actor=actor, before={"status": "WAITING", "cost_amount": "0.00"},
                     after={"status": account.status, "inventory_status": account.inventory_status,
                            "cost_amount": str(account.cost_amount), "inventory_entry_at": account.inventory_entry_at.isoformat()},
                     reason="依据已核对的历史订单补库存")
    order.account_id = account.id
    record_audit(session, action=AuditAction.ORDER_UPDATE, entity_type="order", entity_id=order.order_no,
                 actor=actor, before={"account_id": None},
                 after={"account_id": account.id, "stock_no": account.stock_no}, reason="历史导入关联库存")
    return account
