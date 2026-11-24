"""隔离测试环境使用的示例主数据；不进入生产镜像。"""
from sqlalchemy.orm import Session

from app.settings.field_definitions.game_types import create_game_type, list_game_types
from app.settings.field_definitions.pools import create_pool, get_default_pool, get_pool_by_code


def seed_example_data(session: Session, *, actor: str, stats: dict[str, int]) -> None:
    for code, name, pool_type in (("HJ_INVEST", "投资款荷包", "INVEST"), ("HJ_PROFIT", "利润荷包", "PROFIT")):
        if get_pool_by_code(session, code) is not None:
            stats["pools_skipped"] += 1
            continue
        create_pool(session, code=code, name=name, actor=actor, pool_type=pool_type, note="测试示例")
        stats["pools_created"] += 1
    if get_default_pool(session) is None:
        invest = get_pool_by_code(session, "HJ_INVEST")
        if invest is not None:
            invest.is_default = True
            session.flush()
            stats["default_pool_marked"] += 1
    for name, sort_order, is_default in (("王者荣耀", 10, True), ("原神", 20, False)):
        if any(item.name == name for item in list_game_types(session)):
            stats["game_types_skipped"] += 1
            continue
        create_game_type(session, name=name, sort_order=sort_order, is_default=is_default, actor=actor)
        stats["game_types_created"] += 1
