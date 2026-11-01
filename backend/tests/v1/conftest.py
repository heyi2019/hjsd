"""tests/v1 共享夹具：临时 SQLite（文件库，绝不用 backend/data/*.db）。

- 每个 session 建独立临时库并 `create_all`；用例之间用嵌套事务回滚；
- `client` 把 `core.database.get_db` 覆盖到测试会话；
- 登录态用 `X-Dev-User`（dev 直通），或真实 JWT 走 `Authorization: Bearer`。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
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

    if filename in {"test_backup_restore.py", "test_migration.py", "test_coverage_gate.py"}:
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


@pytest.fixture(scope="session")
def v1_engine(tmp_path_factory: pytest.TempPathFactory):
    db_file = tmp_path_factory.mktemp("v1") / "test_v1.db"
    # 文件型 SQLite：不使用 StaticPool（会让所有连接共用同一 DBAPI 连接，导致事务隔离失效）
    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False},
        future=True,
    )

    # 测试库不需要崩溃安全：关 fsync + 内存 journal，消除并行跑时的 I/O 等待。
    # 仅作用于本测试引擎，不影响生产 database.py。
    from sqlalchemy import event as sa_event

    @sa_event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA synchronous=OFF")
        cursor.execute("PRAGMA journal_mode=MEMORY")
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.close()

    Base.metadata.create_all(bind=engine)
    yield engine
    engine.dispose()


def _truncate_all(engine) -> None:
    """清库到“空库 + 无编号”状态。

    注：SQLite + SQLAlchemy 的 savepoint 模式无法拦截被测代码里的 `session.commit()`，
    因此改用“每条用例后物理清空”的隔离策略，保证用例之间零污染。
    """
    with engine.begin() as connection:
        for table in reversed(Base.metadata.sorted_tables):
            connection.execute(table.delete())


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
        _truncate_all(v1_engine)
        connection.close()


@pytest.fixture(scope="session")
def seed_template_path(tmp_path_factory: pytest.TempPathFactory):
    """会话级种子模板库：只 seed 一次，之后每个用例用 ATTACH 回放（纯 SQL，无 ORM 开销）。

    seed_foundation 单次 ~40-95ms × 978 个种子用例曾是全量运行的最大 CPU 项；
    回放成本 ~几 ms，行为与逐次 seed 完全一致（同一批行、同样的主键与顺序）。
    """
    db_file = tmp_path_factory.mktemp("seed_tmpl") / "seed_template.db"
    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False},
        future=True,
    )
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)()
    seed_foundation(session, actor="pytest")
    seed_default_users(session)
    session.commit()
    session.close()
    engine.dispose()
    return str(db_file)


def _replay_seeds(db: Session, template_path: str) -> None:
    """把模板库的全部行回放到 db 所在库（ATTACH + INSERT..SELECT，走 SQLite C 层）。

    注意：DETACH 必须在 commit 之后——事务未提交时主库持有写锁，DETACH 会报 locked。
    """
    raw = db.connection().connection  # DBAPI 连接（SQLAlchemy 池代理）
    cursor = raw.cursor()
    cursor.execute("ATTACH DATABASE ? AS seed_template", (template_path,))
    try:
        for table in Base.metadata.sorted_tables:  # 依赖序，父表先插
            cursor.execute(
                f'INSERT INTO main."{table.name}" SELECT * FROM seed_template."{table.name}"'
            )
        db.commit()  # 先提交释放写锁
        cursor.execute("DETACH DATABASE seed_template")
    finally:
        cursor.close()


@pytest.fixture()
def seeded_db(db: Session, seed_template_path: str):
    _replay_seeds(db, seed_template_path)
    db.commit()
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
