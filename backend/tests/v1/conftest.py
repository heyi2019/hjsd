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
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("APP_ENV", "development")

from app.api_v1 import create_app  # noqa: E402
from app.core.database import Base, get_db  # noqa: E402
from app.core.security import CurrentUser, DEV_USERS, build_access_token  # noqa: E402
from app.domain import foundation, parties, trade  # noqa: E402,F401  注册全部 v1 表
from app.foundation.seeds import seed_foundation  # noqa: E402


@pytest.fixture(scope="session")
def v1_engine(tmp_path_factory: pytest.TempPathFactory):
    db_file = tmp_path_factory.mktemp("v1") / "test_v1.db"
    # 文件型 SQLite：不使用 StaticPool（会让所有连接共用同一 DBAPI 连接，导致事务隔离失效）
    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False},
        future=True,
    )
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


@pytest.fixture()
def seeded_db(db: Session):
    seed_foundation(db, actor="pytest")
    db.commit()
    return db


@pytest.fixture()
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
