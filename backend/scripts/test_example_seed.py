"""隔离测试环境使用的示例主数据；不进入生产镜像。"""
from copy import deepcopy
from sqlalchemy.orm import Session

from app.settings.field_definitions.game_types import create_game_type, list_game_types
from app.settings.field_definitions.pools import create_pool, get_default_pool, get_pool_by_code


def seed_example_data(session: Session, *, actor: str, stats: dict[str, int]) -> None:
    for code, name, pool_type in (("pool_01", "投资款荷包", "INVEST"), ("pool_02", "利润荷包", "PROFIT")):
        if get_pool_by_code(session, code) is not None:
            stats["pools_skipped"] += 1
            continue
        create_pool(session, name=name, actor=actor, pool_type=pool_type, note="测试示例")
        stats["pools_created"] += 1
    if get_default_pool(session) is None:
        invest = get_pool_by_code(session, "pool_01")
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


_EXAMPLE_OPTION_SETS = {'CUSTOMER_SOURCE': [{'value': 'customer_source_01', 'label': '自营'},
                     {'value': 'customer_source_02', 'label': '微博'},
                     {'value': 'customer_source_03', 'label': '小红书'},
                     {'value': 'customer_source_04', 'label': '闲鱼'},
                     {'value': 'customer_source_05', 'label': '同行推荐'},
                     {'value': 'customer_source_06', 'label': '其他', 'behavior': 'OTHER'}],
 'INTERMEDIARY_PLATFORM': [{'value': 'intermediary_platform_01', 'label': '千寻'},
                           {'value': 'intermediary_platform_02', 'label': '盼之'},
                           {'value': 'intermediary_platform_03', 'label': '白情'},
                           {'value': 'intermediary_platform_04', 'label': '螃蟹'},
                           {'value': 'intermediary_platform_05', 'label': '私下'},
                           {'value': 'intermediary_platform_06', 'label': '其他', 'behavior': 'OTHER'}],
 'STUDIO_EXPENSE_ITEM': [{'value': 'studio_expense_item_01', 'label': '房租'},
                         {'value': 'studio_expense_item_02', 'label': '日用'},
                         {'value': 'studio_expense_item_03', 'label': '水电'},
                         {'value': 'studio_expense_item_04', 'label': '物业'},
                         {'value': 'studio_expense_item_05', 'label': '其他'}],
 'STUDIO_EXPENSE_POOL': [{'value': 'HJ_RUN', 'label': '经营资金池'}],
 'SUPPLIER_SOURCE': [{'value': 'supplier_source_01', 'label': '自营'},
                     {'value': 'supplier_source_02', 'label': '微博'},
                     {'value': 'supplier_source_03', 'label': '小红书'},
                     {'value': 'supplier_source_04', 'label': '闲鱼'},
                     {'value': 'supplier_source_05', 'label': '同行推荐'},
                     {'value': 'supplier_source_06', 'label': '其他', 'behavior': 'OTHER'}],
 'COMPENSATION_TYPE': [{'value': 'compensation_type_01', 'label': '首保'},
                       {'value': 'compensation_type_02', 'label': '续保'},
                       {'value': 'compensation_type_03', 'label': '转续'}],
 'INTERMEDIARY_TYPE': [{'value': 'intermediary_type_01', 'label': '普中'},
                       {'value': 'intermediary_type_02', 'label': '包赔', 'behavior': 'COMPENSATION'}],
 'QUALITY_SEVERITY': [{'value': 'LOW', 'label': '低'},
                      {'value': 'MEDIUM', 'label': '中'},
                      {'value': 'HIGH', 'label': '高'},
                      {'value': 'CRITICAL', 'label': '严重'}],
 'REFUND_RESPONSIBILITY': [{'value': 'COMPANY', 'label': '公司'},
                           {'value': 'CUSTOMER', 'label': '客户'},
                           {'value': 'CONSIGNOR', 'label': '寄售方'},
                           {'value': 'PLATFORM', 'label': '平台'},
                           {'value': 'OTHER', 'label': '其他'}]}

_EXAMPLE_FORM_FIELDS = {('CONSIGN', 'platform_ids'): [{'value': 'panzhi', 'label': '盼之'}, {'value': 'pangxie', 'label': '螃蟹'}],
 ('CUSTOMER', 'game_category'): [{'value': 'game_category_01', 'label': '王者荣耀'},
                                 {'value': 'game_category_02', 'label': '和平精英'},
                                 {'value': 'game_category_03', 'label': '原神'},
                                 {'value': 'game_category_04', 'label': '英雄联盟'},
                                 {'value': 'game_category_05', 'label': '其他'}],
 ('DG', 'dg_customer_source'): [{'value': 'customer_source_01', 'label': '自营'},
                                {'value': 'customer_source_02', 'label': '微博'},
                                {'value': 'customer_source_03', 'label': '小红书'},
                                {'value': 'customer_source_04', 'label': '闲鱼'},
                                {'value': 'customer_source_05', 'label': '同行推荐'},
                                {'value': 'customer_source_06', 'label': '其他'}],
 ('HS', 'customer_source'): [{'value': 'customer_source_01', 'label': '自营'},
                             {'value': 'customer_source_02', 'label': '微博'},
                             {'value': 'customer_source_03', 'label': '小红书'},
                             {'value': 'customer_source_04', 'label': '闲鱼'},
                             {'value': 'customer_source_05', 'label': '同行推荐'},
                             {'value': 'customer_source_06', 'label': '其他'}],
 ('TH', 'supplier_source'): [{'value': 'supplier_source_01', 'label': '自营'},
                             {'value': 'supplier_source_02', 'label': '微博'},
                             {'value': 'supplier_source_03', 'label': '小红书'},
                             {'value': 'supplier_source_04', 'label': '闲鱼'},
                             {'value': 'supplier_source_05', 'label': '同行推荐'},
                             {'value': 'supplier_source_06', 'label': '其他'}]}


def seed_example_catalog(session: Session) -> None:
    """仅向临时测试库填入示例词典，供测试真实交互。"""
    from sqlalchemy import select
    from app.domain.options import OptionSet
    from app.domain.trade import OrderFormField

    for code, options in _EXAMPLE_OPTION_SETS.items():
        row = session.scalar(select(OptionSet).where(OptionSet.code == code))
        if row is not None and not row.options:
            row.options = deepcopy(options)
    for (scope, key), options in _EXAMPLE_FORM_FIELDS.items():
        row = session.scalar(select(OrderFormField).where(
            OrderFormField.order_type_code == scope, OrderFormField.field_key == key
        ))
        if row is not None and not row.options:
            row.options = deepcopy(options)
    session.flush()
