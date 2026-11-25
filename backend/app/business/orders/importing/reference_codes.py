"""把导入文件里的游戏与渠道名称解析为已配置的稳定编码。"""
from __future__ import annotations

from sqlalchemy import String, and_, cast, or_, select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog, GameTypeOption, Pool


def resolve_pool_code(session: Session, code: str) -> Pool | None:
    """按当前编码或迁移前审计记录定位资金账户；存在歧义时拒绝导入。"""
    if not code:
        return None
    previous_ids = select(AuditLog.entity_id).where(or_(
        and_(AuditLog.entity_type == "pool_code_migration",
             AuditLog.action == AuditAction.FIELD_DEFINITION_CHANGE.value,
             AuditLog.before_json["code"].as_string() == code),
        and_(AuditLog.entity_type == "Pool", AuditLog.action == AuditAction.POOL_CREATE.value,
             AuditLog.after_json["code"].as_string() == code),
    ))
    matches = session.scalars(select(Pool).where(or_(Pool.code == code, cast(Pool.id, String).in_(previous_ids)))).all()
    if len(matches) > 1:
        raise Validation("资金账户编码对应多个账户，请核对导入文件", details={"code": code})
    return matches[0] if matches else None


def resolve_new_account_references(session: Session, game_type: str, channel: object) -> tuple[str, str | None]:
    if not game_type:
        if channel:
            raise Validation("导入渠道时须填写已配置的游戏类型")
        return "", None
    games = [game for game in session.scalars(select(GameTypeOption).where(GameTypeOption.is_active.is_(True)))
             if game_type in (game.value, game.name)]
    if len(games) != 1:
        raise Validation("游戏类型不存在或不唯一，请先在配置中心核对", details={"game_type": game_type})
    game = games[0]
    if not channel:
        return game.value, None
    if not isinstance(channel, str):
        raise Validation("渠道／区服无效")
    matches = [item["value"] for item in game.channel_regions or []
               if channel in (item["value"], item["label"])]
    if len(matches) != 1:
        raise Validation("渠道／区服不存在或不唯一，请先在配置中心核对", details={"channel_region": channel})
    return game.value, matches[0]
