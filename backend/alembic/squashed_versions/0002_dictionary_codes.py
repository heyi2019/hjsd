"""0002：迁移可配置字典编码，保留历史订单名称与资金归属。

本版本包含不可逆的数据编码转换；升级前必须备份并在副本上演练。
映射不明确时整个迁移事务失败，版本号保持不变。
"""
from __future__ import annotations

from collections import defaultdict
import re
from typing import Any
from uuid import uuid4

from alembic import context, op
from sqlalchemy import delete, inspect, select, text
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.domain.enums import AuditAction
from app.domain.foundation import GameTypeOption, Pool
from app.domain.lists import ListCustomColumn
from app.domain.options import OptionSet
from app.domain.parties import Counterparty, Customer, CustomerLead, OrderCounterpartyRole, OrderCustomerRole
from app.domain.trade import Account, Cashflow, Deposit, Installment, Order, OrderEvent, OrderFormField, RebateRecord, Reconciliation
from app.domain.users import Team
from app.shared.audit import record_audit
from app.shared.game_references import archive_game_references
from app.shared.numbering import allocate_number, ensure_sequence
from app.shared.option_codes import allocate_option_code, sync_option_sequence
from app.shared.option_snapshots import option_label_maps
from app.business.shared.listing_state import active_listings_from_events

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

MARKER = "DICTIONARY_CODE_MIGRATION_V1"
CONSIGNMENT_MARKER = "CONSIGNMENT_CODE_MIGRATION_V1"
GROUPS = {
    "customer_source": "CUSTOMER_SOURCE",
    "dg_customer_source": "CUSTOMER_SOURCE",
    "supplier_source": "SUPPLIER_SOURCE",
    "intermediary_platform": "INTERMEDIARY_PLATFORM",
    "intermediary_type": "INTERMEDIARY_TYPE",
    "compensation_type": "COMPENSATION_TYPE",
}
OPTION_GROUPS = set(GROUPS.values()) | {"STUDIO_EXPENSE_ITEM"}
YES_NO = {"有": "Y", "对": "Y", "是": "Y", "无": "N", "否": "N", "不": "N", "Y": "Y", "N": "N"}
WALLET = {"已注销": "Y", "未注销": "N", "Y": "Y", "N": "N"}
BEHAVIORS = {
    ("CUSTOMER_SOURCE", "其他"): "OTHER",
    ("SUPPLIER_SOURCE", "其他"): "OTHER",
    ("INTERMEDIARY_PLATFORM", "其他"): "OTHER",
    ("INTERMEDIARY_TYPE", "包赔"): "COMPENSATION",
}


def _mapping_error(kind: str, value: Any) -> Validation:
    return Validation(f"历史{kind}无法唯一匹配，请先核对", details={"value": value})


def relax_attachment_number(connection: Connection) -> bool:
    """保留历史附件编号及唯一约束，允许新附件不再发放编号。"""
    if connection.dialect.name != "postgresql":
        raise RuntimeError("附件历史字段调整仅支持 PostgreSQL")
    not_null = connection.execute(text("""
        SELECT attnotnull FROM pg_attribute
        WHERE attrelid = to_regclass('public.attachments')
          AND attname = 'attachment_no' AND NOT attisdropped
    """)).scalar_one_or_none()
    if not_null is None:
        raise RuntimeError("未找到附件历史编号字段，请先核对数据库结构")
    if not not_null:
        return False
    connection.execute(text("SET LOCAL lock_timeout = '5s'"))
    connection.execute(text("ALTER TABLE public.attachments ALTER COLUMN attachment_no DROP NOT NULL"))
    return True


def _options(session: Session, namespace: str, prefix: str, options: list,
             *, group: str | None = None) -> tuple[list[dict], dict[str, tuple[str, str]]]:
    result: list[dict] = []
    mapping: dict[str, tuple[str, str]] = {}
    used = [str(item.get("value", "")) for item in options if isinstance(item, dict)]
    seen: set[str] = set()
    for item in options:
        if not isinstance(item, dict) or not isinstance(item.get("value"), str) or not isinstance(item.get("label"), str):
            raise _mapping_error("字典选项", item)
        old, label = item["value"].strip(), item["label"].strip()
        if not old or not label or old in seen:
            raise _mapping_error("字典选项", old)
        seen.add(old)
        if old in YES_NO:
            code = YES_NO[old]
        elif re.fullmatch(rf"{re.escape(prefix.lower())}_\d{{2,}}", old):
            code = old
        else:
            code = allocate_option_code(session, namespace, prefix, used)
            used.append(code)
        if any(row["value"] == code for row in result):
            raise _mapping_error("字典选项", old)
        migrated = {**item, "value": code, "label": label}
        behavior = BEHAVIORS.get((group, old)) or BEHAVIORS.get((group, label)) if group else None
        if behavior:
            migrated["behavior"] = behavior
        result.append(migrated)
        mapping[old] = (code, label)
        mapping[code] = (code, label)
        if label in mapping and mapping[label] != (code, label):
            raise _mapping_error("字典选项名称", label)
        mapping[label] = (code, label)
    return result, mapping


def _remap(value: Any, mapping: dict[str, tuple[str, str]], kind: str,
           *, allow_free_text: bool = False) -> tuple[Any, str | None]:
    if value is None or value == "":
        return value, None
    if not isinstance(value, str):
        raise _mapping_error(kind, value)
    found = mapping.get(value)
    if found:
        return found
    if allow_free_text:
        return value, value
    raise _mapping_error(kind, value)


def _snapshot_financial_invariants(session: Session) -> tuple[list, list]:
    flows = list(session.execute(text(
        "SELECT id,pool_id,occurred_on,ledger_type,accounting_attribute,direction,amount,"
        "source_type,source_id,order_id FROM cashflow ORDER BY id"
    )))
    orders = list(session.execute(text(
        "SELECT id,order_no,order_type,trade_date,account_id,status,owner_id FROM orders ORDER BY id"
    )))
    return flows, orders


def _assign_master_codes(session: Session, model: type, namespace: str, prefix: str, *, actor: str) -> int:
    rows = list(session.scalars(select(model).order_by(model.id)))
    existing = [row.code for row in rows]
    changed: list[tuple[Any, str, str]] = []
    for row in rows:
        if re.fullmatch(rf"{prefix}_\d{{2,}}", row.code):
            continue
        code = allocate_option_code(session, namespace, prefix, existing)
        existing.append(code)
        changed.append((row, row.code, code))
    token = uuid4().hex[:12]
    for row, _old, _code in changed:
        row.code = f"__migration_{token}_{row.id}"
    session.flush()
    for row, _old, code in changed:
        row.code = code
    session.flush()
    if model is Pool:
        for row, old, code in changed:
            record_audit(session, action=AuditAction.FIELD_DEFINITION_CHANGE, entity_type="pool_code_migration",
                         entity_id=row.id, actor=actor, before={"code": old}, after={"code": code})
    return len(changed)


def repair_consignment_codes(session: Session, *, actor: str) -> dict[str, Any]:
    """统一寄售上架和下架的平台编码，并校验有效上架状态不变。"""
    with session.begin_nested():
        session.execute(text("LOCK TABLE option_sets,order_form_fields,order_events IN ACCESS EXCLUSIVE MODE"))
        labels = option_label_maps(session, {"INTERMEDIARY_PLATFORM"})
        mapping: dict[str, tuple[str, str]] = {}
        for (group, code), label in labels.items():
            del group
            for key in (code, label):
                if key in mapping and mapping[key] != (code, label):
                    raise _mapping_error("寄售平台", key)
                mapping[key] = (code, label)
        events = list(session.scalars(select(OrderEvent).where(OrderEvent.event_type == "OPERATE").order_by(OrderEvent.id)))
        by_order: dict[int, list[OrderEvent]] = defaultdict(list)
        for event in events:
            by_order[event.order_id].append(event)
        before = {order_id: {(event_id, _remap(platform, mapping, "寄售平台")[0])
                             for event_id, platform in active_listings_from_events(items)}
                  for order_id, items in by_order.items()}
        changed = 0
        for event in events:
            extra = event.form_extra or {}
            platforms = extra.get("consignment_platforms")
            if platforms is None:
                continue
            if not isinstance(platforms, list):
                raise _mapping_error("寄售平台", platforms)
            old_labels = extra.get("consignment_platform_labels")
            snapshots = dict(old_labels) if isinstance(old_labels, dict) else {}
            converted = []
            for old in platforms:
                code, label = _remap(old, mapping, "寄售平台")
                if not code or code in converted:
                    raise _mapping_error("寄售平台", old)
                converted.append(code)
                snapshots.setdefault(code, old if old != code else label)
            updated = {**extra, "consignment_platforms": converted, "consignment_platform_labels": snapshots}
            if updated != extra:
                event.form_extra = updated
                changed += 1
        field_count = 0
        for field in session.scalars(select(OrderFormField).where(
            OrderFormField.order_type_code == "CONSIGN", OrderFormField.field_key == "platform_ids"
        )):
            if not field.options:
                continue
            converted = []
            for item in field.options:
                if not isinstance(item, dict):
                    raise _mapping_error("寄售平台字段", item)
                old = item.get("value")
                found = mapping.get(old) or mapping.get(item.get("label"))
                if found is None or any(existing["value"] == found[0] for existing in converted):
                    raise _mapping_error("寄售平台字段", old)
                converted.append({**item, "value": found[0]})
            if field.options != converted:
                field.options = converted
                field_count += 1
        session.flush()
        after = {order_id: active_listings_from_events(items) for order_id, items in by_order.items()}
        if before != after:
            raise Validation("寄售平台有效上架状态发生变化，迁移已回滚")
        result = {"events": changed, "fields": field_count, "active_listings": sum(len(items) for items in after.values())}
        record_audit(session, action=AuditAction.FIELD_DEFINITION_CHANGE, entity_type="dictionary_migration",
                     entity_id="0002:consignment", actor=actor, after=result)
        return result


def migrate_codes(session: Session, *, actor: str) -> dict[str, Any]:
    """在调用方事务中执行；异常回滚全部修改，成功后由调用方决定提交。"""
    if session.get_bind().dialect.name != "postgresql":
        raise Validation("字典编码迁移仅支持 PostgreSQL")
    with session.begin_nested():
        session.execute(text(
            "LOCK TABLE pools,teams,game_type_options,option_sets,document_sequences,order_form_fields,list_custom_columns,"
            "stocks,orders,order_events,cashflow,customers,counterparties,customer_leads,"
            "deposits,rebate_records,installments,reconciliations,order_customer_roles,order_counterparty_roles "
            "IN ACCESS EXCLUSIVE MODE"
        ))
        session.execute(text("ALTER TABLE orders ADD COLUMN IF NOT EXISTS option_label_snapshot JSON"))
        before_flows, before_orders = _snapshot_financial_invariants(session)
        counts = {
            "pools": _assign_master_codes(session, Pool, "fund-pool", "pool", actor=actor),
            "teams": _assign_master_codes(session, Team, "team", "team", actor=actor),
        }

        dictionaries: dict[str, dict[str, tuple[str, str]]] = {}
        for row in session.scalars(select(OptionSet).where(OptionSet.code.in_(OPTION_GROUPS)).order_by(OptionSet.code)):
            row.options, dictionaries[row.code] = _options(
                session, f"option-set:{row.code}", row.code, row.options or [], group=row.code,
            )
            row.updated_by = actor

        games = list(session.scalars(select(GameTypeOption).order_by(GameTypeOption.id)))
        game_lookup: dict[str, GameTypeOption] = {}
        channels: dict[int, dict[str, tuple[str, str]]] = {}
        archived_channels: list[dict[str, str]] = []
        for game in games:
            for key in (game.name, game.value):
                if key in game_lookup and game_lookup[key].id != game.id:
                    raise _mapping_error("游戏类型", key)
                game_lookup[key] = game
            channel_map: dict[str, tuple[str, str]] = {}
            converted = []
            for item in game.channel_regions or []:
                if isinstance(item, str):
                    old, label = item.strip(), item.strip()
                    ensure_sequence(session, "GAME_CHANNEL", "channel_", 2)
                    code = allocate_number(session, "GAME_CHANNEL")
                elif isinstance(item, dict) and isinstance(item.get("value"), str) and isinstance(item.get("label"), str):
                    old, label = item["value"].strip(), item["label"].strip()
                    if not re.fullmatch(r"channel_\d{2,}", old):
                        raise _mapping_error("渠道／区服", old)
                    code = old
                else:
                    raise _mapping_error("渠道／区服", item)
                if not old or not label or old in channel_map or label in channel_map:
                    raise _mapping_error("渠道／区服", old)
                channel_map[old] = (code, label)
                channel_map[label] = (code, label)
                channel_map[code] = (code, label)
                converted.append({"value": code, "label": label})
            game.channel_regions = converted
            channels[game.id] = channel_map

        def account_values(game_value: Any, channel_value: Any, wallet: Any) -> tuple[Any, Any, Any, str | None, str | None]:
            if not game_value:
                if channel_value:
                    raise _mapping_error("游戏类型", game_value)
                game = None
            else:
                game = game_lookup.get(game_value)
                if game is None:
                    raise _mapping_error("游戏类型", game_value)
            channel_code = channel_label = None
            if channel_value:
                if not isinstance(channel_value, str) or game is None:
                    raise _mapping_error("渠道／区服", channel_value)
                found = channels[game.id].get(channel_value)
                if found is None:
                    if re.fullmatch(r"channel_\d{2,}", channel_value):
                        raise _mapping_error("渠道／区服", channel_value)
                    ensure_sequence(session, "GAME_CHANNEL", "channel_", 2)
                    code = allocate_number(session, "GAME_CHANNEL")
                    found = (code, channel_value)
                    channels[game.id][channel_value] = found
                    channels[game.id][code] = found
                    archived_channels.append({"value": code, "label": channel_value})
                channel_code, channel_label = found
            if wallet is not None and wallet != "" and wallet not in WALLET:
                raise _mapping_error("钱包实名", wallet)
            return game.value if game else None, channel_code, WALLET.get(wallet, wallet), game.name if game else None, channel_label

        accounts = list(session.scalars(select(Account).order_by(Account.id)))
        original_accounts = {account.id: (account.game_type, account.channel_region, account.wallet_realname) for account in accounts}
        for account in accounts:
            account.game_type, account.channel_region, account.wallet_realname, _, _ = account_values(*original_accounts[account.id])

        custom: dict[tuple[str, str], dict[str, tuple[str, str]]] = {}
        definitions = list(session.scalars(select(OrderFormField).order_by(OrderFormField.id)))
        for field in definitions:
            if field.is_custom and field.field_type in {"SELECT", "MULTI_SELECT"}:
                if field.options:
                    field.options, custom[(field.order_type_code, field.field_key)] = _options(
                        session, f"form:{field.order_type_code}:{field.field_key}", field.field_key, field.options,
                    )
                else:
                    custom[(field.order_type_code, field.field_key)] = {}
            elif field.field_key in {"has_secondary", "wallet_realname", *GROUPS} and field.options:
                mapping = ({value: (code, value) for value, code in YES_NO.items()} if field.field_key == "has_secondary"
                           else {value: (code, value) for value, code in WALLET.items()} if field.field_key == "wallet_realname"
                           else dictionaries.get(GROUPS[field.field_key], {}))
                field.options = [{**item, "value": _remap(item.get("value"), mapping, field.field_key)[0]} for item in field.options]

        for column in session.scalars(select(ListCustomColumn)):
            if not isinstance(column.value_labels, dict):
                continue
            mappings = [mapping for (_scope, key), mapping in custom.items() if key == column.source_key]
            candidates = sorted(
                (field for field in definitions if field.is_custom and field.is_active
                 and field.field_key == column.source_key and field.field_type in {"SELECT", "MULTI_SELECT"}),
                key=lambda field: (field.sort_order, field.id),
            )
            converted_labels: dict[str, str] = {}
            for old, label in column.value_labels.items():
                if not isinstance(old, str) or not isinstance(label, str) or not old or not label:
                    raise _mapping_error("自定义列表选项", old)
                matches = {mapping[old][0] for mapping in mappings if old in mapping}
                if len(matches) > 1:
                    raise _mapping_error("自定义列表选项", old)
                if not matches and candidates:
                    owner = candidates[0]
                    mapping = custom[(owner.order_type_code, owner.field_key)]
                    used = [code for code, _label in mapping.values()] + list(converted_labels)
                    if old in YES_NO:
                        code = YES_NO[old]
                    elif re.fullmatch(rf"{re.escape(owner.field_key.lower())}_\d{{2,}}", old):
                        code = old
                    else:
                        code = allocate_option_code(session, f"form:{owner.order_type_code}:{owner.field_key}", owner.field_key, used)
                    archived = (code, label)
                    for key in (old, label, code):
                        if key in mapping and mapping[key] != archived:
                            raise _mapping_error("自定义列表选项", old)
                        mapping[key] = archived
                    matches.add(code)
                code = next(iter(matches), old)
                if code in converted_labels and converted_labels[code] != label:
                    raise _mapping_error("自定义列表选项", old)
                converted_labels[code] = label
            column.value_labels = converted_labels

        for (scope, key), mapping in custom.items():
            if mapping:
                sync_option_sequence(session, f"form:{scope}:{key}", key, [code for code, _label in mapping.values()])

        for field in definitions:
            condition = field.required_when
            if not isinstance(condition, dict) or not isinstance(condition.get("values"), list):
                continue
            key = condition.get("field")
            mapping = custom.get((field.order_type_code, key))
            if key == "has_secondary":
                mapping = {value: (code, value) for value, code in YES_NO.items()}
            elif key == "wallet_realname":
                mapping = {value: (code, value) for value, code in WALLET.items()}
            elif key in GROUPS:
                mapping = dictionaries.get(GROUPS[key], {})
            if mapping:
                field.required_when = {**condition, "values": [_remap(value, mapping, str(key))[0] for value in condition["values"]]}

        def extras(values: Any, scopes: set[str], snapshots: dict[str, Any] | None = None) -> Any:
            if values is None:
                return None
            if not isinstance(values, dict):
                raise _mapping_error("扩展字段", type(values).__name__)
            result = dict(values)
            for key, value in values.items():
                base = key.removeprefix("sell_")
                if base in GROUPS and value is not None:
                    converted, label = _remap(value, dictionaries.get(GROUPS[base], {}), base,
                                               allow_free_text=base in {"customer_source", "dg_customer_source", "supplier_source"})
                    result[key] = converted
                    if snapshots is not None and label:
                        snapshots.setdefault(key, label)
                    continue
                maps = [mapping for (scope, field_key), mapping in custom.items() if field_key == key and scope in scopes]
                if not maps or value is None or value == "" or value == []:
                    continue
                entries = value if isinstance(value, list) else [value]
                converted_values = []
                converted_labels = {}
                for entry in entries:
                    matches = {mapping[entry] for mapping in maps if isinstance(entry, str) and entry in mapping}
                    if len(matches) != 1:
                        raise _mapping_error(f"自定义字段 {key}", entry)
                    code, label = matches.pop()
                    converted_values.append(code)
                    converted_labels[code] = label
                if snapshots is not None:
                    snapshots.setdefault(key, converted_labels if isinstance(value, list) else label)
                result[key] = converted_values if isinstance(value, list) else converted_values[0]
            return result

        for model, scopes in (
            (Customer, {"CUSTOMER"}), (Counterparty, {"COUNTERPARTY"}),
            (CustomerLead, {"LEAD", "LEADCLOSE", "LEADCONVERT"}), (Account, {"HS", "TH", "DG", "INVEDIT"}),
            (OrderEvent, {field.order_type_code for field in definitions}),
            (Cashflow, {field.order_type_code for field in definitions}),
            (Deposit, {field.order_type_code for field in definitions}),
            (RebateRecord, {field.order_type_code for field in definitions}),
            (Installment, {field.order_type_code for field in definitions}),
            (Reconciliation, {field.order_type_code for field in definitions}),
        ):
            for row in session.scalars(select(model)):
                row.form_extra = extras(row.form_extra, scopes)
                if isinstance(row, (Customer, Counterparty)) and row.source:
                    group = "CUSTOMER_SOURCE" if isinstance(row, Customer) else "SUPPLIER_SOURCE"
                    row.source = _remap(row.source, dictionaries.get(group, {}), group, allow_free_text=True)[0]
                if isinstance(row, Cashflow) and row.ledger_type == "STUDIO" and row.source_type == "MANUAL":
                    if row.direction == "OUT" and row.accounting_attribute == "OPERATING_EXPENSE":
                        row.category = _remap(row.category, dictionaries.get("STUDIO_EXPENSE_ITEM", {}), "工作室支出类别")[0]
                    elif row.direction == "IN" and row.accounting_attribute == "SELF_REVENUE":
                        income = {"货款": ("studio_income_item_01", "货款"), "其他": ("studio_income_item_02", "其他"),
                                  "studio_income_item_01": ("studio_income_item_01", "货款"), "studio_income_item_02": ("studio_income_item_02", "其他")}
                        row.category = _remap(row.category, income, "工作室收入类别")[0]

        orders = list(session.scalars(select(Order).order_by(Order.id)))
        order_by_id = {order.id: order for order in orders}
        for order in orders:
            labels = dict(order.option_label_snapshot or {})
            order.form_extra = extras(order.form_extra, {order.order_type, "SALEREC", "SALETH", "SALEDG"}, labels)
            raw = dict(order.account_snapshot or {})
            if not raw.get("game_type") and order.account_id in original_accounts:
                game_value, channel_value, wallet = original_accounts[order.account_id]
            else:
                game_value, channel_value, wallet = raw.get("game_type"), raw.get("channel_region"), raw.get("wallet_realname")
            game_code, channel_code, wallet_code, game_label, channel_label = account_values(game_value, channel_value, wallet)
            for key, value in (("game_type", game_code), ("channel_region", channel_code), ("wallet_realname", wallet_code)):
                if value is not None:
                    raw[key] = value
            if game_label:
                raw.setdefault("game_type_label", game_label)
            if channel_label:
                raw.setdefault("channel_region_label", channel_label)
            order.account_snapshot = raw or None
            order.option_label_snapshot = labels or None

        for model, relation, kind, group, fk in (
            (Customer, OrderCustomerRole, "customer", "CUSTOMER_SOURCE", OrderCustomerRole.customer_id),
            (Counterparty, OrderCounterpartyRole, "counterparty", "SUPPLIER_SOURCE", OrderCounterpartyRole.counterparty_id),
        ):
            for order_id, entity in session.execute(select(relation.order_id, model).join(model, model.id == fk)):
                if entity.source and order_id in order_by_id:
                    order = order_by_id[order_id]
                    labels = dict(order.option_label_snapshot or {})
                    labels.setdefault(f"party_source:{kind}:{entity.id}",
                                      _remap(entity.source, dictionaries.get(group, {}), group, allow_free_text=True)[1] or entity.source)
                    order.option_label_snapshot = labels
        archive_game_references(session, archived_channels, actor=actor)
        session.flush()
        counts["consignment"] = repair_consignment_codes(session, actor=actor)
        if _snapshot_financial_invariants(session) != (before_flows, before_orders):
            raise Validation("迁移前后订单或资金流水关键数据不一致，已回滚")
        counts.update({"orders": len(orders), "stocks": len(accounts), "archived_channels": len(archived_channels)})
        record_audit(session, action=AuditAction.FIELD_DEFINITION_CHANGE, entity_type="dictionary_migration",
                     entity_id="0002", actor=actor, after=counts)
        return counts


def upgrade() -> None:
    if context.is_offline_mode():
        raise RuntimeError("0002 字典编码迁移需要连接数据库执行")
    bind = op.get_bind()
    relax_attachment_number(bind)
    with Session(bind=bind) as session:
        markers = set(session.scalars(select(OptionSet.code).where(
            OptionSet.code.in_({MARKER, CONSIGNMENT_MARKER})
        )))
        if MARKER in markers:
            if "option_label_snapshot" not in {column["name"] for column in inspect(bind).get_columns("orders")}:
                raise Validation("已有迁移标记但订单快照列缺失，不能升级到 0002")
            if CONSIGNMENT_MARKER not in markers:
                repair_consignment_codes(session, actor="alembic-0002")
        else:
            if markers:
                raise Validation("已有迁移标记不完整，不能升级到 0002")
            migrate_codes(session, actor="alembic-0002")
        if markers:
            session.execute(delete(OptionSet).where(OptionSet.code.in_({MARKER, CONSIGNMENT_MARKER})))
        session.commit()


def downgrade() -> None:
    raise RuntimeError("0002 字典编码转换不能自动降级，请从迁移前备份恢复")
