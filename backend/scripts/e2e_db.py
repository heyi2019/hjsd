"""E2E 隔离库：默认**不清数据**（只补表与种子），`--reset` 才重建清空。

两种模式（默认 keep 是用户裁决：E2E 库同时当「第五个可查看环境」，不能每次启动就清空）：
  - `python scripts/e2e_db.py`（默认）：create_all 补缺失表 + 幂等播种，**不删任何行**，
    已有单据/库存/流水原样保留；自动化（playwright webServer）与人工启动都走这条。
    夹具按 (business_mode, inventory_type) 补足 IN_STOCK 账号，用例消耗后下一轮自动补齐，
    故无需每轮重建也能重复跑测。
  - `python scripts/e2e_db.py --reset`（或 `E2E_RESET=1`）：drop_all + create_all + TRUNCATE，
    得到干净起点；仅供人工需要彻底清空时使用，自动化已不再注入 E2E_RESET。

注意：库 heijin_erp_e2e 一直存在，跑完的数据原样留着。CI 的 postgres service 每次是
全新空库，由默认 keep 分支的 create_all + 幂等播种完成初始化，同样不需要 --reset。


设计对齐 `tests/backend/conftest.py` 的 `v1_engine` 夹具：
  - `Base.metadata.create_all` 幂等建表（对齐压平后的 0001 基线，不跑 alembic）；
  - `TRUNCATE 全 ORM 表 RESTART IDENTITY CASCADE`（仅 `--reset` 时）清空上一轮数据；
  - `seed_foundation` + 默认用户（id 1..9）重播基础种子。

与测试库的区别 / 安全铁律：
  - **只认名字含 `e2e` 的库**：绝不允许指向 dev / release / prod / test 等业务库——
    `heijin_erp_dev` 是用户的真实沙盒数据，误清即损失。必须显式含 `e2e`，且拒绝
    deny-list 词。
  - 不回落 `DATABASE_URL`：缺 `E2E_DATABASE_URL` 时从 `DATABASE_URL` 派生（仅替换
    库名为 `heijin_erp_e2e`，保留 host/port/凭据），绝不直接用业务库。
  - `TRUNCATE ... CASCADE` 在这里是安全的：E2E 库纯由 ORM `create_all` 建出，
    无任何非 ORM 表；"TRUNCATE 不能带 CASCADE" 的铁律只针对 dev/release（那里有
    配置表要保留）。本库全清正好是要的目的。

用法（自动化与人工默认均不带额外参数）：
  python scripts/e2e_db.py               # 保留数据 + 补种子 + 补足在库账号（默认）
  python scripts/e2e_db.py --reset       # 重建 + 清空 + 种子（仅人工需要干净起点时）
  python scripts/e2e_db.py --reset-only  # 仅重建不补 E2E 业务夹具
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.core.database import Base, get_engine  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
# 这些模块只为「导入即注册 ORM 表」：Base.metadata.create_all 只会建已 import 的
# 模型，少导一个就会静默漏表（曾经表现为建单用例全部 500，报「表不存在」）。
# pyflakes 不认 `# noqa`（那是 flake8 的能力），故用 `__all__` 收口，避免被
# lint 门禁判成 unused import 而被迫删掉这些导入。
from app.domain import (  # noqa: E402
    attachments,
    foundation,
    lists,
    notifications,
    options,
    parties,
    quality,
    trade,
    users,
)
from app.foundation.seeds import seed_foundation  # noqa: E402
from app.foundation.catalog_seed import seed_catalog  # noqa: E402
from app.foundation.seed_orders import seed_order_matrix  # noqa: E402

__all__ = [
    "attachments", "foundation", "lists", "notifications",
    "options", "parties", "quality", "trade", "users",
]

# E2E 库名必须含此标记；dev/release/prod/test 业务库一律拒绝，避免误清真实数据。
_REQUIRED_MARK = "e2e"
_DENIED = ("dev", "release", "prod", "production", "live", "rehearsal", "test")


def _e2e_database_url() -> str:
    """解析 E2E 库地址：E2E_DATABASE_URL 优先；否则从 DATABASE_URL 派生（仅换库名）。

    刻意不回落到业务库本身：若 DATABASE_URL=heijin_erp_dev，派生后变成
    heijin_erp_e2e，host/port/凭据继承，库名通过下方校验才放行。
    """
    url = os.environ.get("E2E_DATABASE_URL")
    if not url:
        base = os.environ.get("DATABASE_URL") or get_settings().database_url
        if not base:
            raise SystemExit("未配置 E2E_DATABASE_URL 或 DATABASE_URL，无法派生 E2E 库。")
        # 仅替换 URL 末尾的数据库名，保留 scheme/user/password/host/port。
        if "postgresql" not in base:
            raise SystemExit("E2E 库必须是 PostgreSQL（当前 DATABASE_URL 非 PG）。")
        url = base.rsplit("/", 1)[0] + "/heijin_erp_e2e"
    if "postgresql" not in url:
        raise SystemExit("E2E_DATABASE_URL 必须是 PostgreSQL。")
    db = url.rsplit("/", 1)[-1].lower()
    if _REQUIRED_MARK not in db:
        raise SystemExit(
            f"拒绝：E2E 库名 `{db}` 必须含 `{_REQUIRED_MARK}`（一次性玩具库，"
            "绝不可指向业务库）。请将 E2E_DATABASE_URL 指向如 heijin_erp_e2e。"
        )
    hit = [w for w in _DENIED if w in db]
    if hit:
        raise SystemExit(
            f"拒绝：E2E 库名 `{db}` 命中禁用词 {hit}。E2E 会 TRUNCATE 全表，"
            "严禁指向 dev/release/prod 等业务库。"
        )
    return url


def _truncate_all(engine) -> None:
    """清空全部 ORM 表并归位序列（对齐 conftest._truncate_all）。"""
    names = ", ".join(f'public."{t.name}"' for t in Base.metadata.sorted_tables)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))


def _drop_retired_columns(engine) -> None:
    """让常驻 E2E 库追平当前 ORM，清掉已删除的非空字段。

    `keep` 模式只执行 ``create_all``，不会修改已有表；已有表可能仍保留
    已从当前模型删除、但带 NOT NULL 的 ``capital_type``，新写入订单时会被拒绝。
    """
    with engine.begin() as connection:
        connection.execute(
            text('ALTER TABLE public."order_type_defs" DROP COLUMN IF EXISTS capital_type CASCADE')
        )
        connection.execute(
            text('ALTER TABLE public."orders" DROP COLUMN IF EXISTS capital_type CASCADE')
        )


def _seed_default_users(db) -> None:
    """补齐占位用户（对齐 conftest.seed_default_users）。

    DEV 态后端以 X-Dev-User 直通，并按 id 映射 operator/finance/auditor/viewer；
    这些接口仍查真实 DB 用户行，故需存在足够活跃用户，否则 404/422。
    此处不写显式 id——交给 PG 自增序列，避免后续 API 插「无 id」记录时序列错位撞主键。
    """
    for uid in range(1, 10):
        if db.query(users.User).filter(users.User.username == f"seeduser{uid}").first() is None:
            db.add(users.User(
                username=f"seeduser{uid}",
                display_name=f"种子用户{uid}",
                password_hash="seed-not-real",
                role="ADMIN",
                owner_scope="ALL",
                pool_ids=[],
                team_ids=[],
                is_active=True,
            ))
    db.flush()


def _seed_real_admin(db) -> None:
    """造一个**真实可登录**的管理员 admin/12345678（供 auth-login 真实登录联调用例）。

    与 seeduser1..9 的假哈希不同：这里用后端同款 PBKDF2-SHA256 写真哈希，
    id 取 1001 避开门禁占位用户 1..9。仅 E2E 库存在，不污染业务库。
    """
    existing = db.query(users.User).filter(users.User.username == "admin").first()
    if existing is None:
        db.add(users.User(
            username="admin",
            display_name="系统管理员",
            password_hash=hash_password("12345678"),
            role="ADMIN",
            owner_scope="ALL",
            pool_ids=[],
            team_ids=[],
            is_active=True,
        ))
    db.flush()


def _seed_real_employee(db) -> None:
    """造一个**真实可登录**的普通员工 employee/12345678（角色 EMPLOYEE，仅业务录入）。

    用于验证「普通员工看不到经营中心/资金中心」：该角色在前后端 ROLE_PERMISSIONS
    中均不含 report.read / finance.read，故这两类导航对其隐藏。id 取 1002 避开占位用户。
    """
    existing = db.query(users.User).filter(users.User.username == "employee").first()
    if existing is None:
        db.add(users.User(
            username="employee",
            display_name="普通员工",
            password_hash=hash_password("12345678"),
            role="EMPLOYEE",
            owner_scope="ALL",
            pool_ids=[],
            team_ids=[],
            is_active=True,
        ))
    db.flush()


def _ensure_database(url: str) -> None:
    """若 E2E 库不存在则创建（本地首次运行需要；CI 的 postgres service 已建好）。

    连维护库（postgres）执行 CREATE DATABASE；该库不存在时退化为连任意一个已存在
    的业务库再建——但绝不触碰任何业务库的数据，只发一条 CREATE DATABASE。
    """
    dbname = url.rsplit("/", 1)[-1]
    maint = url.rsplit("/", 1)[0] + "/postgres"
    eng = create_engine(maint, future=True)
    try:
        with eng.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            exists = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": dbname}
            ).scalar()
            if not exists:
                conn.execute(text(f'CREATE DATABASE "{dbname}"'))
                print(f"[e2e-db] 已创建数据库 {dbname}")
    except Exception as exc:  # 维护库连不上（如 erp_app 无权连 postgres）
        raise SystemExit(
            f"[e2e-db] 无法连接维护库以创建 {dbname}：{exc}\n"
            "请先手动建库：CREATE DATABASE heijin_erp_e2e（用有权限的账号）。"
        )
    finally:
        eng.dispose()


def reset(reset_only: bool = False, keep: bool = False) -> str:
    """确保 E2E 库可用并播种基础数据；返回实际使用的库名（供诊断）。

    两种模式：
      - `keep=True`（默认，给人看数据用）：**不删任何行**。只 create_all 补齐缺失的表，
        再跑一遍播种（全部函数都有 existing 守卫，天然幂等）。已有单据/库存/流水原样保留。
      - `keep=False`（`--reset`，仅人工需要干净起点时用）：drop_all + create_all 强制把表
        结构对齐当前 ORM（含 CHECK 约束、新增列等），再 TRUNCATE 全表，得到干净起点。
        避免「库已存在 → create_all 不改旧表」导致的约束落后。

    选择默认 keep 的原因：E2E 库同时被当作第五个「可查看环境」，每次启动都清空会让人
    打开页面就看不到数据。自动化复用常驻库，靠夹具补足 IN_STOCK 账号保证可重复跑测，
    只有人工需要彻底清空时才显式传 --reset / 设 E2E_RESET=1。
    业务库绝不可走这条路（见文件头铁律）。
    """
    url = _e2e_database_url()
    _ensure_database(url)
    engine = get_engine(url)
    if keep:
        Base.metadata.create_all(bind=engine)
    else:
        Base.metadata.drop_all(bind=engine)
        Base.metadata.create_all(bind=engine)
        _truncate_all(engine)
    _drop_retired_columns(engine)
    Session = sessionmaker(bind=engine, autoflush=False, future=True)
    db = Session()
    try:
        seed_foundation(db, actor="e2e")
        # 选项词典 + 表单字段配置：资金流水方向（FUND_FLOW_DIRECTION）、返点类型
        # （rebate_type 等）的下拉依赖 option_sets / order_form_fields，缺一不可——
        # 缺失会导致 finance-write-ui 等用例下拉为空、表单无法提交。对齐真实库（dev/
        # release 首次启动即落 catalog），E2E 库 TRUNCATE 后必须重播。
        seed_catalog(db, actor="e2e")
        _seed_default_users(db)
        _seed_real_admin(db)
        _seed_real_employee(db)
        if not reset_only:
            _seed_e2e_fixtures(db)
        db.commit()
    finally:
        db.close()
    engine.dispose()
    return url.rsplit("/", 1)[-1]


def _seed_e2e_fixtures(db) -> None:
    """E2E 业务夹具：客户 + 干净在库账户，供建单 / 售出 / 资金等真实写入联调用例。

    关键修正：E2E 套件串行共享同一常驻库，用例会「消耗」在库账号（建单后出库）。
    早期实现只在 `count()==0` 时一次性补满，导致不清数据复用库时第二轮就找不到
    IN_STOCK 账号而失败——这也是当初 playwright 被迫每次 `E2E_RESET=1` 全量重建的根因。
    现改为**按 (business_mode, inventory_type) 确保每种都有足量的 IN_STOCK 账号**，
    不足即补，从而可去掉每次重建、直接复用常驻库（省 5–15s 启动 + 重播种子）。

    补足编号必须取**全库最大号 +1**，不能按类型各自维护递增段：三段起点
    20000 / 20100 / 20200 仅隔 100，而每轮消耗约 12 个账号，SELF 段涨过 20100
    就会撞上 PICKUP 已存在的 KU_20100…（stock_no 全表唯一），db.flush() 抛
    IntegrityError → webServer 启动即失败、整轮 E2E 全挂。实测常驻库曾涨到
    SELF KU_20036，距 KU_20100 仅 64 个号。
    字段严格对齐当前 ORM（见 app/domain/trade_models/account.py）。
    """
    from app.domain.parties import Customer  # noqa: E402
    from app.domain.trade_models.account import Account  # noqa: E402

    # 客户不随用例消耗而消失，仅做「空库才建」初始化（避免无限累积）。
    if db.query(Customer).count() == 0:
        # 客户编号用 9xxx 段：后端新建客户走 allocate_number 自动分配（CUS0001…），
        # 与种子客户错开，避免撞 uq_customers_no（实测 CUS0001-0003 与自动分配首值冲突）。
        for i, name in enumerate(["测试买家甲", "测试买家乙", "测试买家丙"], start=1):
            db.add(Customer(
                customer_no=f"CUS{str(9000 + i)}",
                display_name=name,
                phone=f"138{str(80000000 + i)}",
                owner_id=1,
                note="E2E 夹具",
            ))

    # 在库账号按类型补足：确保每种 (business_mode, inventory_type) 组合都有
    # _TARGET_PER_TYPE 个 IN_STOCK 账号。补足时 stock_no 接在该类型现有最大号之后递增，
    # 绝不撞号（首轮 0 段 20000/20100/20200 + 后续补足段均不重叠）。
    _GAMES = [
        "王者荣耀", "原神", "和平精英", "英雄联盟", "穿越火线",
        "崩坏星穹铁道", "蛋仔派对", "第五人格", "QQ飞车", "三国杀",
        "光遇", "明日方舟",
    ]
    _CHANNELS = ["微信区", "官服", "QQ区", "B服", "iOS", "安卓", "抖音", "TapTap"]
    _PLANS = [
        ("SELF", "RECOVERY", 20000),
        ("DISTRIBUTION", "PICKUP", 20100),
        ("DISTRIBUTION", "CONSIGNMENT", 20200),
    ]
    _TARGET_PER_TYPE = 12

    # 一次取全库账号：算全局最大编号 + 各类型在库数/总数。
    # 见函数 docstring：补足必须从**全库**最大号之后递增，否则分段号会互相撞。
    rows = db.query(
        Account.business_mode,
        Account.inventory_type,
        Account.inventory_status,
        Account.stock_no,
    ).all()
    global_max = 0
    in_stock_by_type: dict[tuple[str, str], int] = {}
    total_by_type: dict[tuple[str, str], int] = {}
    for biz_mode, inv_type, inv_status, stock_no in rows:
        key = (biz_mode, inv_type)
        total_by_type[key] = total_by_type.get(key, 0) + 1
        if inv_status == "IN_STOCK":
            in_stock_by_type[key] = in_stock_by_type.get(key, 0) + 1
        tail = str(stock_no or "").split("_")[-1]
        if tail.isdigit():
            global_max = max(global_max, int(tail))

    for biz_mode, inv_type, stock_prefix in _PLANS:
        key = (biz_mode, inv_type)
        need = _TARGET_PER_TYPE - in_stock_by_type.get(key, 0)
        if need <= 0:
            continue
        # 空库首次保留三段起点（互不重叠）；已有账号则统一从全局最大号之后递增，
        # 三个类型依次接着用，绝不重复，也永远不会爬进别的段。
        seq_start = stock_prefix if total_by_type.get(key, 0) == 0 else global_max + 1
        for j in range(need):
            suffix = seq_start + j
            global_max = max(global_max, suffix)
            db.add(Account(
                stock_no=f"KU_{suffix}",
                game_account=f"e2e_{inv_type.lower()}_{suffix}",
                camp_account=f"e2e_camp_{inv_type.lower()}_{suffix}",
                game_password="e2e-pwd",
                channel_region=_CHANNELS[j % len(_CHANNELS)],
                bound_phone="13800000000",
                has_secondary=False,
                wallet_realname="E2E",
                business_mode=biz_mode,
                inventory_type=inv_type,
                status="WAITING",
                inventory_status="IN_STOCK",
                game_type=_GAMES[j % len(_GAMES)],
                cost_amount=0,
            ))
    seed_order_matrix(db)
    db.flush()


if __name__ == "__main__":
    reset_only = "--reset-only" in sys.argv
    # 默认 keep（不清数据）；`--reset` 或 E2E_RESET=1 才走全量重建。
    keep = not ("--reset" in sys.argv or os.environ.get("E2E_RESET") == "1")
    db_name = reset(reset_only=reset_only, keep=keep)
    mode = "保留数据并补齐种子（幂等）" if keep else "已重建并清空"
    print(f"[e2e-db] {mode}：{db_name}")
