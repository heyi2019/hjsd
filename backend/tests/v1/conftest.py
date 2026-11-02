"""tests/v1 共享夹具：PostgreSQL 测试库（绝不用生产库）。

- 测试库只认 `TEST_DATABASE_URL`（**刻意不回落 `DATABASE_URL`**），库名必须含 `test`
  且不得命中 release/prod 等黑名单、不得与 `DATABASE_URL` 同库——夹具会 `TRUNCATE`
  全表，误指业务库即数据全毁，故在会话开始前硬校验；
- 每个 session 对测试库 `create_all`（幂等）；用例之间 `TRUNCATE ... RESTART IDENTITY`；
- 种子数据放独立 schema `seed_template`，每用例跨 schema 回放（纯 SQL，无 ORM 开销）；
- `client` 把 `core.database.get_db` 覆盖到测试会话；
- 登录态用 `X-Dev-User`（dev 直通），或真实 JWT 走 `Authorization: Bearer`。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

BACKEND_DIR = Path(__file__).resolve().parents[2]  # tests/v1 -> backend


def _initial_markers_for_file(filename: str) -> set[str]:
    """按现有文件命名给存量测试补初始分类，不改变测试行为。

    这是过渡性的文件级分类：后续遇到跨域或命名不准确的文件，可在测试模块内
    用 pytestmark 补充或覆盖。未能可靠判断的文件保持未分类，避免把业务语义猜错。
    """
    markers: set[str] = set()

    if filename in {
        "test_money.py",
        "test_money_float_guard.py",
        "test_numbering.py",
        "test_state_machine.py",
        "test_game_types.py",
        "test_product_alias_compat.py",
    }:
        markers.add("unit")

    if (
        filename.endswith("_contract.py")
        or filename in {
            "test_api_contract.py",
            "test_order_types_api.py",
            "test_pools_api.py",
            "test_request_schema_contract.py",
            "test_orders_router_guard.py",
            "test_orders_guard.py",
            "test_parties_policy_guard.py",
            "test_quality_guard.py",
            "test_report_export_columns.py",
            "test_list_columns.py",
            "test_list_custom_columns.py",
            "test_list_export_csv.py",
        }
    ):
        markers.add("contract")

    if any(
        token in filename
        for token in (
            "_service.py",
            "orders.py",
            "parties.py",
            "finance_",
            "reporting_",
            "installments_",
            "inventory_execution",
            "accounts_",
            "auth_",
            "backup_restore",
            "migration",
            "notifications_",
            "attachments_",
            "quality_",
            "search_",
            "settings",
        )
    ):
        markers.add("integration")

    if any(
        token in filename
        for token in (
            "bughunt",
            "_gaps",
            "unreachable_status_paths",
            "repair_baseline_schema",
            "coverage_gate",
            "deploy_script_contract",
            "account_stock_no",
        )
    ):
        markers.add("regression")

    if any(
        token in filename
        for token in (
            "auth",
            "policy",
            "security",
            "ratelimit",
            "permission",
            "audit",
        )
    ):
        markers.add("security")

    if filename in {"test_backup_scripts.py", "test_migration.py", "test_coverage_gate.py"}:
        markers.add("slow")

    return markers


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """给存量测试提供可查询的初始类型标签。"""
    for item in items:
        filename = Path(str(item.fspath)).name
        for marker in _initial_markers_for_file(filename):
            item.add_marker(getattr(pytest.mark, marker))


# 正常环境：把 backend 根置顶，保证 `import app` 走原始代码。
# mutmut 会在 sys.path 注入 mutants/ 并移除 backend 根；此时若仍 insert(0, backend)，
# `import app` 会命中原始 backend/app，导致所有变异失效。故检测到 mutants 已在 sys.path
# （即 mutmut 运行环境）时不再抢占 [0]，让变异后的 mutants/app 优先。
# 对正常 pytest 零行为变化：正常环境 sys.path 中不含 mutants，逻辑与原先一致。
if str(BACKEND_DIR) not in sys.path:
    _mutant_env = any("mutants" in p for p in sys.path)
    if not _mutant_env:
        sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("APP_ENV", "development")

from app.api_v1 import create_app  # noqa: E402
from app.core.database import Base, get_db  # noqa: E402
from app.core.security import CurrentUser, DEV_USERS, build_access_token  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain import attachments, foundation, imports, notifications, options, parties, quality, trade, users  # noqa: E402,F401  注册全部 v1 表
from app.foundation.seeds import seed_foundation  # noqa: E402


def seed_default_users(db: Session) -> None:
    """补齐测试常用的占位用户（id 1..9）。

    迁移 0008 给 orders.owner_id / customers.owner_id / order_profit_allocations.user_id
    补了指向 users 的外键，故测试里直接写死的 user_id/owner_id（如 1/2/3/7/9）必须对应真实用户，
    否则触发 FOREIGN KEY 约束失败。这里集中造一批占位用户，避免每个用例各自造。
    """
    for uid in range(1, 10):
        if db.get(users.User, uid) is None:
            db.add(users.User(
                id=uid,
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


# 上线准备库 / 生产库一律不得作为测试目标，即便库名里带 test 也拒绝。
_DENIED_DB_KEYWORDS = ("release", "prod", "production", "live", "rehearsal")


def _test_database_url() -> str:
    """测试库 URL：环境变量 `TEST_DATABASE_URL` 优先，其次 `.env` 的同名项。

    **刻意不回落 `DATABASE_URL`**：2026-11-02 的事故就是回落导致的——`.env` 只配了
    `DATABASE_URL`，夹具回落到它，而库名 `heijin_erp_test` 恰好含 test 通过校验，
    于是开发后端与 pytest 共用同一个库，跑一次测试清空一次，118 单丢失。
    现在缺配置只会拒绝运行，不会"猜一个库去清空"。

    硬校验两条：必须 PostgreSQL、库名必须含 `test`。夹具会 TRUNCATE 全表，
    误指生产库即数据全毁——宁可在 collect 前直接退出，也不做"尽力而为"。
    """
    settings = get_settings()
    url = os.environ.get("TEST_DATABASE_URL") or settings.test_database_url
    if not url:
        pytest.exit(
            "未配置测试库：请在 .env 设置 TEST_DATABASE_URL（库名须含 test），"
            "或在环境变量中提供。不要与 DATABASE_URL 指向同一个库。",
            returncode=1,
        )
    if not url.startswith("postgresql"):
        pytest.exit(
            "测试夹具要求 PostgreSQL：请设置 TEST_DATABASE_URL（库名须含 test）。"
            "SQLite 支持已移除。",
            returncode=1,
        )
    database = make_url(url).database or ""
    lowered = database.lower()
    if "test" not in lowered:
        pytest.exit(
            f"拒绝在库 `{database}` 上跑测试（库名须含 test）：夹具会 TRUNCATE 全表。",
            returncode=1,
        )
    # 显式黑名单：库名同时含 test 与 release/prod 时（如 heijin_erp_test_release），
    # 只靠「含 test」会放行——但那可能是上线准备库，清掉就没有可上线的数据了。
    denied = [word for word in _DENIED_DB_KEYWORDS if word in lowered]
    if denied:
        pytest.exit(
            f"拒绝在库 `{database}` 上跑测试（命中黑名单 {denied}）：夹具会 TRUNCATE 全表。"
            "上线准备库与生产库不允许参与任何自动化测试。",
            returncode=1,
        )
    # 本地必须物理分离。CI 的 postgres service 只建一个一次性的临时库，
    # 两个变量同库无害，故 CI 环境跳过（`CI` 由 GitHub Actions 自动注入）。
    if not os.environ.get("CI"):
        base_url = os.environ.get("DATABASE_URL") or settings.database_url
        base_database = make_url(base_url).database if base_url else ""
        if base_database and base_database == database:
            pytest.exit(
                f"TEST_DATABASE_URL 与 DATABASE_URL 指向同一个库 `{database}`："
                "夹具每用例都会 TRUNCATE 全表，等于让测试反复清空业务库。"
                "请在 .env 把两者分成两个库。",
                returncode=1,
            )
    return url


@pytest.fixture(scope="session")
def v1_engine():
    """会话级测试引擎：连测试库并确保 schema 就绪（create_all 幂等）。

    起点必须清一次：SQLite 时代每次都是全新临时文件，天然干净；PG 测试库是
    持久库，上次会话（或本地手工初始化）留下的行会污染第一个用例——实测残留
    `document_sequences.current_value=56` 让「分配应得 HS0001」直接变成 HS0057。
    """
    engine = create_engine(_test_database_url(), future=True, pool_pre_ping=True)
    Base.metadata.create_all(bind=engine)
    _truncate_all(engine)
    yield engine
    engine.dispose()


def _truncate_all(engine) -> None:
    """清库到「空表 + 序列归位」状态。

    注：被测代码里有 `session.commit()`，savepoint 拦不住，因此改用「每条用例后
    物理清空」的隔离策略。PG 的 TRUNCATE 换 relfilenode 是 O(1)，比逐表 DELETE
    快一个量级；`RESTART IDENTITY` 让自增序列一起归位，避免用例间主键漂移。
    """
    names = ", ".join(f'public."{table.name}"' for table in Base.metadata.sorted_tables)
    with engine.begin() as connection:
        connection.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))


@pytest.fixture()
def db(v1_engine):
    """函数级会话：用例结束后清库，互不污染。"""
    connection = v1_engine.connect()
    Testing = sessionmaker(bind=connection, autoflush=False, autocommit=False, future=True)
    session: Session = Testing()
    try:
        yield session
    finally:
        session.close()
        # 先归还连接再 TRUNCATE：PG 下残留事务会持有表锁，让 TRUNCATE 阻塞到超时。
        connection.close()
        _truncate_all(v1_engine)


SEED_SCHEMA = "seed_template"


@pytest.fixture(scope="session")
def seed_template(v1_engine):
    """会话级种子模板 schema：只 seed 一次，之后每个用例跨 schema 回放。

    SQLite 时代用 `ATTACH DATABASE` 做跨库拷贝；PG 没有 ATTACH，改用同库独立
    schema `seed_template`——回放是 `INSERT INTO public.X SELECT * FROM
    seed_template.X`，同样是纯 SQL、不走 ORM（seed_foundation 单次 ~40-95ms
    × 近千个种子用例，逐次重 seed 曾是全量运行的最大 CPU 项）。
    """
    with v1_engine.begin() as connection:
        connection.execute(text(f"DROP SCHEMA IF EXISTS {SEED_SCHEMA} CASCADE"))
        connection.execute(text(f"CREATE SCHEMA {SEED_SCHEMA}"))
    template_engine = v1_engine.execution_options(schema_translate_map={None: SEED_SCHEMA})
    Base.metadata.create_all(bind=template_engine)
    session = sessionmaker(bind=template_engine, autoflush=False, autocommit=False, future=True)()
    try:
        seed_foundation(session, actor="pytest")
        seed_default_users(session)
        session.commit()
    finally:
        session.close()
    yield SEED_SCHEMA
    with v1_engine.begin() as connection:
        connection.execute(text(f"DROP SCHEMA IF EXISTS {SEED_SCHEMA} CASCADE"))


# 序列归位：seed 行带显式主键，回放后序列仍停在初始值，后续插入必然主键冲突。
# 统一 setval(seq, COALESCE(MAX(col), 0) + 1, false)——is_called=false 让下一个
# nextval 正好返回该值，空表也自然落到 1。这是 SQLite 没有、PG 必须补的语义差异。
_RESET_SEQUENCES_SQL = text("""
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT quote_ident(c.relname) AS tbl,
           quote_ident(a.attname) AS col,
           pg_get_serial_sequence(
             quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname
           ) AS seq
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND pg_get_serial_sequence(
            quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname
          ) IS NOT NULL
  LOOP
    EXECUTE format(
      'SELECT setval(%L, COALESCE((SELECT MAX(%s) FROM public.%s), 0) + 1, false)',
      r.seq, r.col, r.tbl
    );
  END LOOP;
END $$;
""")


def _replay_seeds(db: Session) -> None:
    """把模板 schema 的全部行回放到 public（跨 schema INSERT..SELECT，纯 SQL）。

    必须显式列举列名：模板表由 ORM `create_all` 建、public 表由 alembic 迁移建，
    两者列顺序并不保证一致，`SELECT *` 会按位置对齐——实测 `stocks.buy_date`(date)
    位置收到字符串列，PG 直接报 DatatypeMismatch。带列名插入按名对齐，顺序无关。
    """
    connection = db.connection()
    for table in Base.metadata.sorted_tables:  # 依赖序，父表先插
        columns = ", ".join(f'"{column.name}"' for column in table.columns)
        connection.execute(
            text(
                f'INSERT INTO public."{table.name}" ({columns}) '
                f'SELECT {columns} FROM {SEED_SCHEMA}."{table.name}"'
            )
        )
    connection.execute(_RESET_SEQUENCES_SQL)
    db.commit()


@pytest.fixture()
def seeded_db(db: Session, seed_template: str):
    _replay_seeds(db)
    return db


# 会话级复用：create_app 单次 ~415ms（162 条路由的 pydantic schema 注册是纯 CPU 无状态），
# 函数级重建曾占全量运行大头。共享 app 安全的前提：
# - 全库无测试直接改 app.state / 依赖覆写（conftest 的 client/seeded_client 每用例 set/clear）；
# - create_app 无 lifespan/on_event 钩子，TestClient 反复进出无状态残留；
# - 需要自定义 settings 的用例（test_settings / test_main_contract）自行 create_app，不受影响。
@pytest.fixture(scope="session")
def app():
    return create_app()


@pytest.fixture()
def client(app, db: Session):
    """TestClient：get_db 指向隔离的测试会话。"""

    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def seeded_client(app, seeded_db: Session):
    """带基础种子的 TestClient：编号域已就绪，可直接建客户/订单。"""

    def override_get_db():
        try:
            yield seeded_db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def headers() -> dict[str, str]:
    """默认管理员身份（dev 直通）。"""
    return {"X-Dev-User": "admin"}


def auth_headers(user: CurrentUser) -> dict[str, str]:
    """真实 Bearer token 头：用于验证 JWT 链路本身。"""
    return {"Authorization": f"Bearer {build_access_token(user)}"}


@pytest.fixture()
def admin_token_headers() -> dict[str, str]:
    return auth_headers(DEV_USERS["admin"])


@pytest.fixture()
def viewer_headers() -> dict[str, str]:
    return {"X-Dev-User": "viewer"}


@pytest.fixture()
def operator_headers() -> dict[str, str]:
    return {"X-Dev-User": "operator"}
