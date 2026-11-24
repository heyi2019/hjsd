"""隔离测试环境使用的示例主数据；不进入生产镜像。"""
from copy import deepcopy
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


_EXAMPLE_OPTION_SETS = {'CUSTOMER_SOURCE': [{'value': '自营', 'label': '自营'},
                     {'value': '微博', 'label': '微博'},
                     {'value': '小红书', 'label': '小红书'},
                     {'value': '闲鱼', 'label': '闲鱼'},
                     {'value': '同行推荐', 'label': '同行推荐'},
                     {'value': '其他', 'label': '其他'}],
 'INTERMEDIARY_PLATFORM': [{'value': '千寻', 'label': '千寻'},
                           {'value': '盼之', 'label': '盼之'},
                           {'value': '白情', 'label': '白情'},
                           {'value': '螃蟹', 'label': '螃蟹'},
                           {'value': '私下', 'label': '私下'},
                           {'value': '其他', 'label': '其他'}],
 'STUDIO_EXPENSE_ITEM': [{'value': '房租', 'label': '房租'},
                         {'value': '日用', 'label': '日用'},
                         {'value': '水电', 'label': '水电'},
                         {'value': '物业', 'label': '物业'},
                         {'value': '其他', 'label': '其他'}],
 'STUDIO_EXPENSE_POOL': [{'value': 'HJ_RUN', 'label': '经营资金池'}],
 'SUPPLIER_SOURCE': [{'value': '自营', 'label': '自营'},
                     {'value': '微博', 'label': '微博'},
                     {'value': '小红书', 'label': '小红书'},
                     {'value': '闲鱼', 'label': '闲鱼'},
                     {'value': '同行推荐', 'label': '同行推荐'},
                     {'value': '其他', 'label': '其他'}],
 'COMPENSATION_TYPE': [{'value': 'shoubao', 'label': '首保'},
                       {'value': 'xubao', 'label': '续保'},
                       {'value': 'zhuanxu', 'label': '转续'}],
 'INTERMEDIARY_TYPE': [{'value': '普中', 'label': '普中'}, {'value': '包赔', 'label': '包赔'}],
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
 ('CUSTOMER', 'game_category'): [{'value': '王者荣耀', 'label': '王者荣耀'},
                                 {'value': '和平精英', 'label': '和平精英'},
                                 {'value': '原神', 'label': '原神'},
                                 {'value': '英雄联盟', 'label': '英雄联盟'},
                                 {'value': '其他', 'label': '其他'}],
 ('DG', 'dg_customer_source'): [{'value': '自营', 'label': '自营'},
                                {'value': '微博', 'label': '微博'},
                                {'value': '小红书', 'label': '小红书'},
                                {'value': '闲鱼', 'label': '闲鱼'},
                                {'value': '同行推荐', 'label': '同行推荐'},
                                {'value': '其他', 'label': '其他'}],
 ('HS', 'customer_source'): [{'value': '自营', 'label': '自营'},
                             {'value': '微博', 'label': '微博'},
                             {'value': '小红书', 'label': '小红书'},
                             {'value': '闲鱼', 'label': '闲鱼'},
                             {'value': '同行推荐', 'label': '同行推荐'},
                             {'value': '其他', 'label': '其他'}],
 ('TH', 'supplier_source'): [{'value': '自营', 'label': '自营'},
                             {'value': '微博', 'label': '微博'},
                             {'value': '小红书', 'label': '小红书'},
                             {'value': '闲鱼', 'label': '闲鱼'},
                             {'value': '同行推荐', 'label': '同行推荐'},
                             {'value': '其他', 'label': '其他'}]}


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
