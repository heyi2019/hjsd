"""tests/v1 共享夹具：PostgreSQL 测试库（绝不用生产库）。

- 测试库只认 `TEST_DATABASE_URL`（**刻意不回落 `DATABASE_URL`**），库名必须含 `test`
  且不得命中 release/prod 等黑名单、不得与 `DATABASE_URL` 同库——夹具会 `TRUNCATE`
  全表，误指业务库即数据全毁，故在会话开始前硬校验；
- 每个 session 对测试库 `create_all`（幂等）；用例之间 `TRUNCATE ... RESTART IDENTITY`；
- 种子数据放独立 schema `seed_template`，每用例跨 schema 回放（纯 SQL，无 ORM 开销）；
- **整个会话独占测试库**（PG advisory lock）：并发跑两个 pytest 会互相 TRUNCATE /
  DROP 对方的 `seed_template`，故后到者排队等待，超时才报错；
- `client` 把 `core.database.get_db` 覆盖到测试会话；
- 登录态用 `X-Dev-User`（dev 直通），或真实 JWT 走 `Authorization: Bearer`。
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import psycopg

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"  # tests/backend -> 仓库根 -> backend


def _initial_markers_for_file(filename: str) -> set[str]:
    """按现有文件命名给存量测试补初始分类，不改变测试行为。

    这是过渡性的文件级分类：后续遇到跨域或命名不准确的文件，可在测试模块内
    用 pytestmark 补充或覆盖。未能可靠判断的文件保持未分类，避免把业务语义猜错。
    """
    markers: set[str] = set()

    if filename in {
        "test_money.py",
        "test_numbering.py",
        "test_state_machine.py",
        "test_game_types.py",
        "test_product_account_fields.py",
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
            "search_",
            "settings",
        )
    ):
        markers.add("integration")

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

    if filename in {"test_backup_scripts.py", "test_migration.py"}:
        markers.add("slow")

    return markers


# 数据库依赖标记由「夹具依赖」派生，不看目录名，也不看文件名。
#
# 唯一会创建引擎的夹具是 v1_engine；db / seed_template 直接依赖它，client / seeded_db /
# seeded_client 再逐层依赖上去。pytest 在收集期已把传递依赖展开进 item.fixturenames，
# 所以「请求过 v1_engine」等价于「这个用例一定会连库」，不需要自己写闭包推导。
#
# 为什么不用目录（原 backend/unit、backend/integration）：目录是一种声明，代码一变就过期，
# 且没有任何机制会发现它过期。派生值随代码实时变化，天然不会说谎。
# 语义分类（contract / service / flow）仍留在 _initial_markers_for_file，那是给人看的检索轴。
DB_ROOT_FIXTURE = "v1_engine"

# 收集期统计挂在 config 上，供 test_db_channel.py 校验派生机制仍在生效。
# 有人删掉下面的 hook、或把 v1_engine 改名时，守卫会变红而不是静默让通道失效。
DB_STATS_ATTR = "_hei_db_channel_stats"


# ---------------------------------------------------------------------------
# pytest-xdist 并行支持（默认串行时完全不触发，行为零变化）
#
# 原 conftest 已对 xdist 做了「跳过会话独占锁」的兼容（PYTEST_XDIST_WORKER 时
# _acquire_session_lock 直接返回 None），但注释写明「并行需要每个 worker 各自一个库，
# 不在本夹具保证范围内」——共享同一个测试库时，多个 worker 的 seed_template schema
# 会并发 DROP/CREATE、public 表会被并发 TRUNCATE，互相拆台。
#
# 这里补全这一环：xdist 模式下，每个 worker 跑前自动建「基础库名_${worker}」独立库
# （如 heijin_erp_test_gw0），并把 TEST_DATABASE_URL 指向它；跑完在 pytest_unconfigure
# 里 DROP 回收。默认串行（无 PYTEST_XDIST_WORKER）时全部跳过，v1_engine / seed_template
# / 结果记录器逻辑一字未改。
# ---------------------------------------------------------------------------
# 并行模式下每个 worker 的独立库 URL。用模块级全局而非 os.environ 承载：
# conftest 的 _test_database_url 优先读它，但测试里 `Settings(_env_file=None)` 只读
# .env + os.environ，读不到这个全局——否则 test_settings 的「缺省为空」契约在并行下会误红。
_XDIV_WORKER_URL: str | None = None


def _provision_xdist_worker_db(base_url: str) -> None:
    """xdist worker 启动时建独立库并把 URL 存进模块全局（不写 os.environ）。

    只在 PYTEST_XDIST_WORKER 存在时生效；库已存在则复用（崩溃残留不重建）。
    psycopg 不认 SQLAlchemy 的 postgresql+psycopg:// 驱动后缀，建库连接先剥掉。
    """
    global _XDIV_WORKER_URL
    worker = os.environ.get("PYTEST_XDIST_WORKER")
    if not worker:
        return
    u = make_url(base_url)
    worker_db = f"{u.database}_{worker}"
    worker_url = base_url.replace(f"/{u.database}", f"/{worker_db}")
    admin_url = base_url.replace("postgresql+psycopg", "postgresql").replace(
        f"/{u.database}", "/postgres"
    )
    with psycopg.connect(admin_url, autocommit=True, connect_timeout=10) as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (worker_db,))
        if cur.fetchone() is None:
            cur.execute(f'CREATE DATABASE "{worker_db}"')
    _XDIV_WORKER_URL = worker_url


def _drop_xdist_worker_db() -> None:
    """xdist worker 退出时回收其独立库（仅删自己那一个）。"""
    worker = os.environ.get("PYTEST_XDIST_WORKER")
    if not worker:
        return
    base = _XDIV_WORKER_URL or os.environ.get("TEST_DATABASE_URL") or ""
    if not base or "postgresql" not in base:
        return
    try:
        u = make_url(base)
        admin_url = base.replace("postgresql+psycopg", "postgresql").replace(
            f"/{u.database}", "/postgres"
        )
        with psycopg.connect(admin_url, autocommit=True, connect_timeout=10) as conn:
            cur = conn.cursor()
            cur.execute(f'DROP DATABASE IF EXISTS "{u.database}"')
    except Exception:
        # 清理失败不应让测试被判红；下次跑会复用该库（TRUNCATE 仍保证干净）
        pass


def pytest_configure(config: pytest.Config) -> None:
    settings = get_settings()
    base_url = os.environ.get("TEST_DATABASE_URL") or settings.test_database_url
    if base_url and os.environ.get("PYTEST_XDIST_WORKER"):
        _provision_xdist_worker_db(base_url)


def pytest_unconfigure(config: pytest.Config) -> None:
    _drop_xdist_worker_db()


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """给存量测试提供可查询的初始类型标签，并派生数据库依赖标记。"""
    db_marked = 0
    for item in items:
        filename = Path(str(item.fspath)).name
        for marker in _initial_markers_for_file(filename):
            item.add_marker(getattr(pytest.mark, marker))
        if DB_ROOT_FIXTURE in getattr(item, "fixturenames", ()):
            item.add_marker(pytest.mark.db)
        # 统计口径是「最终是否带 db 标记」，含模块级 pytestmark 声明的自建连接文件，
        # 否则守卫会以为那些用例凭空消失。
        if item.get_closest_marker("db") is not None:
            db_marked += 1
    setattr(config, DB_STATS_ATTR, (db_marked, len(items)))


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

from app.api import create_app  # noqa: E402
from app.core.database import get_db  # noqa: E402
from app.domain.base import Base
from app.core.security import CurrentUser, DEV_USERS, build_access_token  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain import attachments, foundation, notifications, options, parties, trade, users  # noqa: E402  注册全部 v1 表
from app.settings.field_definitions.seeds import seed_foundation  # noqa: E402

# pyflakes 不认 `# noqa`，用 __all__ 声明这些副作用导入是有意保留的（触发 ORM 模型注册进 Base.metadata）。
__all__ = [
    "attachments",
    "foundation",
    "notifications",
    "options",
    "parties",
    "trade",
    "users",
]


def seed_default_users(db: Session) -> None:
    """补齐测试常用的占位用户（id 1..9 及动作操作人别名）。

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
    for uid, username in {
        10: "pytest",
        11: "cashier",
        12: "collector",
        13: "contract-creator",
        14: "delivery",
        15: "recovery-operator",
        16: "risk",
        17: "admin",
    }.items():
        if db.get(users.User, uid) is None:
            db.add(users.User(
                id=uid,
                username=username,
                display_name=username,
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
    url = _XDIV_WORKER_URL or os.environ.get("TEST_DATABASE_URL") or settings.test_database_url
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


# 同一测试库上并发跑 pytest 会互相拆台：`v1_engine` 起手 TRUNCATE 全表、
# `seed_template` 是**会话级 schema**（起手 DROP SCHEMA CASCADE + CREATE、收尾再 DROP）、
# 每个用例收尾还 TRUNCATE 一次。两个进程交错时表现为随机的
# 「编号序列 STOCK_NO 尚未初始化」或 `INSERT ... SELECT FROM seed_template."attachments"`
# 的列错误——**单独跑或重跑就绿**，极易误判成代码缺陷。
# 故用会话级 advisory lock 把整个会话串起来：后到者排队等，而不是破坏对方。
# 锁随连接结束自动释放（进程被杀也不会留下死锁）。
_SESSION_LOCK_KEY = 20261103
_SESSION_LOCK_WAIT_SECONDS = 900


def _acquire_session_lock(engine, terminal=None):
    """拿到「本测试库独占」的 advisory lock；返回持有锁的连接（需在收尾释放）。

    等待/恢复提示走 `terminalreporter.write_line` 而不是 `print`：pytest 在用例
    通过时默认丢弃捕获的 stdout，排队等了 10 分钟却一个字都不显示，用户会以为卡死。
    """
    def notify(message: str) -> None:
        if terminal is not None:
            terminal.write_line(message)
        else:
            print(message, flush=True)

    if os.environ.get("PYTEST_XDIST_WORKER"):
        # xdist 的 worker 同属一次运行、共享同一个测试库，抢同一把锁会自锁死。
        # 并行跑需要每个 worker 各自一个库（按分片建库），不在本夹具的保证范围内。
        return None
    connection = engine.connect()
    deadline = time.monotonic() + _SESSION_LOCK_WAIT_SECONDS
    waited = False
    while True:
        acquired = connection.execute(
            text(f"SELECT pg_try_advisory_lock({_SESSION_LOCK_KEY})")
        ).scalar()
        if acquired:
            if waited:
                notify("[pytest] 已获得测试库独占，继续执行。")
            return connection
        if not waited:
            notify(
                "[pytest] 测试库正被另一个 pytest 会话占用，排队等待"
                f"（最多 {_SESSION_LOCK_WAIT_SECONDS}s）：两个会话同时 TRUNCATE "
                "全表 / DROP seed_template 会互相拆台，故串行执行。"
            )
            waited = True
        if time.monotonic() >= deadline:
            connection.close()
            pytest.exit(
                f"等待测试库独占超过 {_SESSION_LOCK_WAIT_SECONDS}s：另一个 pytest 会话"
                "仍在运行。请等它结束，或为本会话换一个独立的 TEST_DATABASE_URL。",
                returncode=1,
            )
        time.sleep(0.5)


@pytest.fixture(scope="session")
def v1_engine(request):
    """会话级测试引擎：连测试库并确保 schema 就绪（create_all 幂等）。

    起点必须清一次：SQLite 时代每次都是全新临时文件，天然干净；PG 测试库是
    持久库，上次会话（或本地手工初始化）留下的行会污染第一个用例——实测残留
    `document_sequences.current_value=56` 让「分配应得 HS0001」直接变成 HS0057。

    拿到引擎后立刻申请**会话独占锁**（见 `_acquire_session_lock`）：清库与
    `seed_template` 的建/拆都必须在独占状态下做，否则并发会话会互相清掉对方的数据。
    """
    engine = create_engine(_test_database_url(), future=True, pool_pre_ping=True)
    terminal = request.config.pluginmanager.get_plugin("terminalreporter")
    lock_connection = _acquire_session_lock(engine, terminal)
    try:
        # 测试库是持久 PG 实例；create_all 只会补表，不会修复既有表缺失的
        # CHECK/UNIQUE 约束。先删除测试库 public schema 的全部表（CASCADE 处理
        # 已退役表的外键），再按当前 ORM schema 重建，避免旧动作模型或旧约束
        # 残留污染回归结果。该库由 TEST_DATABASE_URL 独立配置。
        with engine.begin() as connection:
            for table in inspect(connection).get_table_names(schema="public"):
                connection.execute(text(f'DROP TABLE IF EXISTS public."{table}" CASCADE'))
        Base.metadata.create_all(bind=engine)
        _truncate_all(engine)
        yield engine
    finally:
        if lock_connection is not None:
            lock_connection.execute(
                text(f"SELECT pg_advisory_unlock({_SESSION_LOCK_KEY})")
            )
            lock_connection.close()
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
    """函数级会话：绑定到外层事务，用例结束整体回滚——不物理清库。

    [2026-11-03 提速] 原实现每用例 after 都 `TRUNCATE 37 张表 RESTART IDENTITY
    CASCADE`。实测单次中位 **149ms**（成本随表数线性增长 ≈4ms/表，与事务提交的
    fsync 无关，同一事务内批量做也不摊薄），1524 用例合计 **227s**，占全量
    421.93s 的 54%。

    改为「外层事务 + 会话加入该事务」后，业务代码里的 `db.commit()` 由
    `join_transaction_mode="create_savepoint"` 降级为 savepoint release，teardown
    只剩一次 `rollback()`（实测 <2ms）。

    业务写路径全部经 `get_db` 注入的会话。资金流水导出使用独立只读快照连接，
    需要跨连接读取已提交数据的导出测试使用专用临时测试库，不能依赖本夹具的未提交数据。

    差异（已确认无影响）：PG 的 `setval` 不受事务回滚影响，因此序列值不再随用例
    归零；而编号计数器 `document_sequences` 是**普通表**，仍随回滚归位。
    """
    connection = v1_engine.connect()
    transaction = connection.begin()
    session: Session = Session(
        bind=connection,
        join_transaction_mode="create_savepoint",
        autoflush=False,
        future=True,
    )
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


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
        seed_foundation(session, actor="pytest", include_example_data=True)
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


# ---------------------------------------------------------------------------
# 测试执行结果记录器（用例库与执行结果分离；历史不覆盖）
# 每次 pytest 运行 -> 一条 run_id；每个用例 -> results.jsonl 一条追加记录。
# 与 docs/testing/测试用例库.csv 通过「测试编号」关联（case_index.json: nodeid->编号）。
# 设计边界：本钩子只读/追加文件，任何异常都吞掉，绝不阻断正常测试运行。
# ---------------------------------------------------------------------------
import json as _json  # noqa: E402
from datetime import datetime as _dt  # noqa: E402
from pathlib import Path as _Path  # noqa: E402

# 与 backend/scripts 两个结果记录脚本共用同一份 HEAD 读取实现；该目录不在
# pytest 默认 sys.path 中，追加到末尾即可，不抢占既有 import 优先级。
_SCRIPTS_DIR = str(BACKEND_DIR / "scripts")
if _SCRIPTS_DIR not in sys.path:
    sys.path.append(_SCRIPTS_DIR)
from _git import git_commit  # noqa: E402

_RESULTS_DIR = _Path(__file__).resolve().parents[2] / "docs" / "testing" / "测试结果库"
_RESULTS_JSONL = _RESULTS_DIR / "results.jsonl"
_CASE_INDEX = _Path(__file__).resolve().parent / "_report" / "case_index.json"
_CASE_LIBRARY_CSV = (_Path(__file__).resolve().parents[2] / "docs" / "testing" / "测试用例库.csv")

# 运行级状态（模块级，整个 session 共享）
_RUN_STATE: dict = {"run_id": None, "case_index": {}, "rows": {}}


def _load_case_index() -> dict:
    """nodeid -> 测试编号。

    case_index.json 按设计不入库，且 backend-gate 是「测试在前、生成器在后」：
    全新 checkout / CI 跑 pytest 时这份索引尚未生成，旧实现直接返回空映射，
    当次执行记录的 case_no 会整批缺省。故缺失时从**入库的**《测试用例库.csv》
    自举同一份映射（生成器写 index 的口径即 f"{文件}::{函数标识}"）。
    两份都读不到仍返回空 dict——记录器是 best-effort 旁路，绝不阻断测试。
    """
    try:
        if _CASE_INDEX.exists():
            return _json.loads(_CASE_INDEX.read_text(encoding="utf-8"))
    except Exception:
        pass
    try:
        import csv as _csv
        out: dict = {}
        with _CASE_LIBRARY_CSV.open(encoding="utf-8-sig", newline="") as f:
            for row in _csv.DictReader(f):
                rel = row.get("自动化测试文件及函数") or ""
                name = row.get("测试函数标识") or ""
                no = row.get("测试编号") or ""
                if rel and name and no:
                    out[f"{rel}::{name}"] = no
        return out
    except Exception:
        return {}


def _env_tag() -> str:
    if os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"):
        return "ci"
    return "local"


def _mask_db(url: str) -> str:
    if not url:
        return ""
    return url.split("@")[-1] if "@" in url else url.split("://")[-1]


def pytest_sessionstart(session):  # noqa: D401
    try:
        # xdist worker 各自跑在独立库，并发写同一份 results.jsonl 会交错损坏；
        # 并行模式下的执行结果不落结果库（本就是 best-effort 旁路，非测试结论依据）。
        if os.environ.get("PYTEST_XDIST_WORKER"):
            _RUN_STATE["run_id"] = None
            return
        _RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        ts = _dt.now().strftime("%Y%m%d-%H%M%S")
        commit = git_commit(BACKEND_DIR.parent)
        _RUN_STATE["run_id"] = f"{ts}-{commit}-{os.getpid()}"
        _RUN_STATE["case_index"] = _load_case_index()
        _RUN_STATE["rows"] = {}
        _RUN_STATE["commit"] = commit
        _RUN_STATE["env"] = _env_tag()
        _RUN_STATE["db"] = _mask_db(os.environ.get("TEST_DATABASE_URL", ""))
    except Exception:
        _RUN_STATE["run_id"] = None


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):  # noqa: D401
    outcome = yield
    try:
        rep = outcome.get_result()
    except Exception:
        return
    if _RUN_STATE.get("run_id") is None:
        return
    nodeid = item.nodeid
    when = rep.when
    existing = _RUN_STATE["rows"].get(nodeid, {})
    # 以更严重的状态覆盖：ERROR > FAIL > SKIP > PASS
    rank = {"PASS": 0, "SKIP": 1, "FAIL": 2, "ERROR": 3}
    cur = existing.get("status", "PASS")
    new_status = None
    reason = ""
    if when == "setup" and rep.skipped:
        new_status, reason = "SKIP", _short_repr(rep)
    elif when == "setup" and rep.failed:
        new_status, reason = "ERROR", _short_repr(rep)
    elif when == "call":
        if rep.passed:
            new_status = "PASS"
        elif rep.failed:
            new_status, reason = "FAIL", _short_repr(rep)
        elif rep.skipped:
            new_status, reason = "SKIP", _short_repr(rep)
    elif when == "teardown" and rep.failed:
        new_status, reason = "ERROR", _short_repr(rep)
    if new_status and rank.get(new_status, 0) >= rank.get(cur, 0):
        existing = {
            "status": new_status,
            "reason": reason or existing.get("reason", ""),
            "duration": rep.duration if when == "call" else existing.get("duration", 0.0),
        }
        _RUN_STATE["rows"][nodeid] = existing


def _short_repr(rep) -> str:
    try:
        txt = str(rep.longrepr) if rep.longrepr else ""
    except Exception:
        txt = ""
    return txt[:500]


def pytest_sessionfinish(session, exitstatus):  # noqa: D401
    try:
        if _RUN_STATE.get("run_id") is None:
            return
        run_id = _RUN_STATE["run_id"]
        commit = _RUN_STATE.get("commit", "unknown")
        env = _RUN_STATE.get("env", "local")
        db = _RUN_STATE.get("db", "")
        ts = _dt.now().isoformat(timespec="seconds")
        rows = _RUN_STATE["rows"]
        idx = _RUN_STATE.get("case_index", {})
        # 兜底：把 session 收集到的全部用例都记一笔（含未触发 makereport 的 collected-only）
        lines = []
        for nodeid, rec in rows.items():
            base = nodeid.split("[")[0]  # 参数化用例 [RPT_...] 退化为函数级 nodeid 再查编号
            case_no = idx.get(nodeid) or idx.get(base, "")
            lines.append(_json.dumps({
                "run_id": run_id, "commit": commit, "env": env, "db": db,
                "time": ts, "nodeid": nodeid, "case_no": case_no,
                "status": rec.get("status", "UNKNOWN"),
                "duration": round(float(rec.get("duration", 0.0)), 4),
                "reason": rec.get("reason", ""),
                # 本记录器不生成独立日志，不能填写不存在的证据路径。
                "evidence": "",
            }, ensure_ascii=False))
        if lines:
            with _RESULTS_JSONL.open("a", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
    except Exception:
        pass
