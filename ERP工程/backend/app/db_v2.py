"""M0 新库的数据库连接 —— 与旧 heijin.db 物理隔离。

旧库 data/heijin.db 保留不动（承载 v1.0 的 230 行历史数据），
新库 data/heijin_v2.db 承载按 PRD 002v2.0 重建的模型。

迁移走scripts/migrate_v2.py，读旧库→ 写新库，不覆盖。
"""
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DB_DIR, exist_ok=True)

V2_DB_PATH = os.path.join(DB_DIR, "heijin_v2.db")

engine_v2 = create_engine(
    f"sqlite:///{V2_DB_PATH}",
    connect_args={"check_same_thread": False},
    future=True,
)

SessionLocalV2 = sessionmaker(bind=engine_v2, autoflush=False, autocommit=False, future=True)


class BaseV2(DeclarativeBase):
    pass


def get_db_v2():
    db = SessionLocalV2()
    try:
        yield db
    finally:
        db.close()


#: 初始资金池。这是**种子数据**而非硬编码约束——
#: 业务上随时可调用 create_pool() 新建任意池，核算逻辑不依赖池的数量与类型。
SEED_POOLS = [
    {
        "code": "HJ_INVEST",
        "name": "投资款荷包",
        "pool_type": "INVEST",
        "ownership": "OWNED",
        "note": "本金池。又称小荷包/经营池。用于买号、代垫、付同行",
    },
    {
        "code": "HJ_PROFIT",
        "name": "利润荷包",
        "pool_type": "PROFIT",
        "ownership": "OWNED",
        "note": "利润池。接收售出差价与平台返点，用于发提成、抵运营消耗",
    },
]


def init_db_v2():
    """建表 + 写入种子池。

    模型在此处惰性导入：entities 模块依赖本模块的 BaseV2，
    若在模块顶层导入会形成循环。
    """
    from app.models_new.entities import Pool  # 惰性导入，同时触发模型注册

    BaseV2.metadata.create_all(bind=engine_v2)

    db = SessionLocalV2()
    try:
        if db.query(Pool).count() == 0:
            db.add_all([Pool(**p) for p in SEED_POOLS])
            db.commit()
        # 业务类型种子 + 默认池路由
        seed_order_types(db)
    finally:
        db.close()


def create_pool(db, code: str, name: str, pool_type: str = "OTHER",
                ownership: str = "OWNED", note: str = ""):
    """新建资金池。池可自由增删，不限于初始两个。

    规则（PRD §1.2）：
    - code 创建后不可修改（V18）
    - 有流水后禁止物理删除，只能停用（V17），故此处不提供 delete
    """
    from app.models_new.entities import Pool

    if db.query(Pool).filter(Pool.code == code).first():
        raise ValueError(f"池 code 已存在：{code}")

    p = Pool(code=code, name=name, pool_type=pool_type,
            ownership=ownership, note=note)
    db.add(p)
    db.commit()
    return p


def pool_by_code(db, code: str):
    """按 code 取池。code 是稳定标识，name 可改。"""
    from app.models_new.entities import Pool

    p = db.query(Pool).filter(Pool.code == code).first()
    if not p:
        raise ValueError(f"池不存在：{code}")
    return p


def pools_by_type(db, pool_type: str) -> list:
    """按类型取全部池。核算可按类型汇总，不依赖具体池数量。"""
    from app.models_new.entities import Pool

    return db.query(Pool).filter(Pool.pool_type == pool_type).all()


def owned_pools(db) -> list:
    """只取自有资金池。权益核算必须用这个口径，
    否则代客保管 / 平台保证金会被误算成工作室的钱。"""
    from app.models_new.entities import Pool

    return db.query(Pool).filter(Pool.ownership == "OWNED").all()


# ---------------------------------------------------------------------------
# 业务类型主数据：可自由新增，与资金池多对多
# ---------------------------------------------------------------------------

def seed_order_types(db) -> None:
    """写入种子业务类型 + 默认池路由。仅首次执行。"""
    from app.models_new.entities import OrderTypeDef, OrderTypePool, Pool, SEED_ORDER_TYPES

    if db.query(OrderTypeDef).count() > 0:
        return

    pools = {p.code: p for p in db.query(Pool).all()}
    invest = pools.get("HJ_INVEST")
    profit = pools.get("HJ_PROFIT")

    for row in SEED_ORDER_TYPES:
        d = OrderTypeDef(**row)
        db.add(d)
        db.flush()

        # 默认路由：本金部分 → 投资款池，利润部分 → 利润池。
        # 零本金业务（DG）没有本金路由。
        if row["capital_type"] != "ZERO" and invest:
            db.add(OrderTypePool(order_type_id=d.id, pool_id=invest.id,
                                 portion="PRINCIPAL"))
        if profit:
            db.add(OrderTypePool(order_type_id=d.id, pool_id=profit.id,
                                 portion="PROFIT"))
    db.commit()


def create_order_type(db, code: str, name: str, capital_type: str = "ZERO",
                      note: str = "", sort_order: int = 0):
    """新增业务类型。**不需要改代码、不需要改表。**

    新业务默认不绑池——若需要资金路由，用link_order_type_pool 单独关联。
    """
    from app.models_new.entities import OrderTypeDef

    if db.query(OrderTypeDef).filter(OrderTypeDef.code == code).first():
        raise ValueError(f"业务类型 code 已存在：{code}")

    d = OrderTypeDef(code=code, name=name, capital_type=capital_type,
                     note=note, sort_order=sort_order)
    db.add(d)
    db.commit()
    return d


def link_order_type_pool(db, order_type_code: str, portion: str, pool_code: str):
    """把「某业务的某部分资金」路由到某个池。

    业务与池是多对多：一个业务可关联多个池，多个业务也可共用同一个池。
    同一 (业务, 部分) 只能配一个默认池——要换池先删旧关联。
    """
    from app.models_new.entities import OrderTypeDef, OrderTypePool

    d = db.query(OrderTypeDef).filter(OrderTypeDef.code == order_type_code).first()
    if not d:
        raise ValueError(f"业务类型不存在：{order_type_code}")

    from app.models_new.entities import Pool
    p = db.query(Pool).filter(Pool.code == pool_code).first()
    if not p:
        raise ValueError(f"池不存在：{pool_code}")

    old = db.query(OrderTypePool).filter(
        OrderTypePool.order_type_id == d.id,
        OrderTypePool.portion == portion,
    ).first()
    if old:
        db.delete(old)
        db.flush()

    link = OrderTypePool(order_type_id=d.id, pool_id=p.id, portion=portion)
    db.add(link)
    db.commit()
    return link


def resolve_pool(db, order_type_code: str, portion: str, explicit_pool_id=None):
    """解析某笔资金的池归属。

    优先级：显式指定 > 业务默认路由 > 报错。
    这样既支持「按业务自动路由」，也支持「这一单特殊，走别的池」。
    """
    from app.models_new.entities import OrderTypeDef, OrderTypePool

    if explicit_pool_id:
        return explicit_pool_id

    d = db.query(OrderTypeDef).filter(OrderTypeDef.code == order_type_code).first()
    if not d:
        raise ValueError(f"业务类型不存在：{order_type_code}")

    link = db.query(OrderTypePool).filter(
        OrderTypePool.order_type_id == d.id,
        OrderTypePool.portion == portion,
    ).first()
    if not link:
        raise ValueError(
            f"业务 {order_type_code} 未配置 {portion} 部分的资金池；"
            f"请先link_order_type_pool，或在录入时显式指定池"
        )
    return link.pool_id
