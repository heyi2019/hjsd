"""pytest 共享夹具：内存库 + TestClient。

关键点：绝不使用 backend/data/heijin.db（真实经营数据）。
每个测试会话建独立内存库，用 override 替换 get_db 依赖。
"""
import os
import sys
from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

from app.db import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app import models  # noqa: F401  确保模型注册，供 create_all 建表
from app.models import CashFlow, Order  # noqa: E402


@pytest.fixture()
def session():
    """独立的内存 SQLite，会话级隔离。

    必须用 StaticPool + check_same_thread=False：SQLite 的 `:memory:` 是
    **每个连接一个独立库**，而连接池会为不同请求分配不同连接，
    不强制共用连接就会出现 "no such table: accounts"。
    """
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = TestingSession()
    try:
        yield s
    finally:
        s.close()
        engine.dispose()


@pytest.fixture()
def client(session):
    """TestClient，get_db 指向内存库。"""
    def override_get_db():
        try:
            yield session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture()
def seeded(session):
    """灌入最小可核算数据集（自洽，可手算校验）。

    设计：投资款 100000 + 回收单(本金500/利润200) + 运营支出 房租/日用 30000
    → 本金荷包 = 100000 + 500 = 100500
    → 利润荷包 = 200 - 30000 = -29800
    """
    session.add_all([
        CashFlow(date=date(2026, 7, 1), category="投资款", direction="收入", amount=Decimal("100000")),
        CashFlow(date=date(2026, 7, 2), category="房租/日用", direction="支出", amount=Decimal("30000")),
        Order(date=date(2026, 7, 3), type="回收", principal=Decimal("500"),
              profit=Decimal("200"), total=Decimal("700")),
    ])
    session.commit()
    return session
