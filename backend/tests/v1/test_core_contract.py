"""core 基础设施契约测试（money / numbering / errors / security / settings / database）。

既有 test_money.py / test_numbering.py / test_settings.py 已覆盖金额量化与编号分配主路径；
本文件补各模块的兼容别名、类型装饰器、越界与解析失败分支、JWT 全失败分支、
作用域判定、env 定位与 URL 派生、engine 生命周期与 `get_db` 事务边界。
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core import database, money, settings as settings_module
from app.core.errors import AppError, NotFound, Validation, require_condition
from app.core.money import Amount, to_money
from app.core.numbering import MAX_SEQUENCE_VALUE, current_value, peek_number
from app.core.security import (
    ROLE_ADMIN,
    ROLE_OPERATOR,
    AuthError,
    CurrentUser,
    TokenExpired,
    decode_token,
    hash_password,
    owner_scope_filter,
    owner_scope_ids,
    require_role,
    verify_password,
)
from app.domain.foundation import DocumentSequence


# ------------------------------------------------------------------ money
class TestMoneyHelpers:
    def test_money_exposes_one_public_parser(self):
        assert not hasattr(money, "parse_amount")
        assert money.to_money("12.345") == to_money("12.345")

    def test_amount_type_decorator_edges(self):
        column_type = Amount()
        assert column_type.python_type is not None  # 91：ORM 声明用
        assert column_type.process_bind_param(None, None) is None  # 95
        assert float(column_type.process_bind_param("12.34", None)) == 12.34


# ------------------------------------------------------------------ numbering
class TestNumberingGuards:
    def test_peek_uninitialized_sequence_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            peek_number(seeded_db, "NO_SUCH_KEY")
        assert "尚未初始化" in str(exc.value)

    def test_peek_exhausted_sequence_rejected(self, seeded_db):
        seeded_db.add(
            DocumentSequence(
                sequence_key="FULL_KEY", prefix="FK", padding=4,
                current_value=MAX_SEQUENCE_VALUE,
            )
        )
        seeded_db.flush()
        with pytest.raises(Validation) as exc:
            peek_number(seeded_db, "FULL_KEY")
        assert "已达上限" in str(exc.value)

    def test_current_value_defaults_to_zero(self, seeded_db):
        seeded_db.add(
            DocumentSequence(
                sequence_key="CUR_KEY", prefix="CK", padding=4, current_value=7
            )
        )
        seeded_db.flush()
        assert current_value(seeded_db, "CUR_KEY") == 7
        assert current_value(seeded_db, "MISSING_KEY") == 0


# ------------------------------------------------------------------ errors
class TestErrorHelpers:
    def test_http_status_override_is_kept(self):
        error = AppError("自定义状态", http_status=418)
        assert error.http_status == 418
        assert error.to_payload()["message"] == "自定义状态"

    def test_require_condition_raises_given_type(self):
        with pytest.raises(Validation):
            require_condition(False, "条件不成立")
        assert require_condition(True, "条件成立") is None
        with pytest.raises(NotFound):
            require_condition(False, "找不到", error_cls=NotFound)


# ------------------------------------------------------------------ security
class TestSecurityScopes:
    def test_permission_combinators(self):
        admin = CurrentUser.build(id=1, username="admin", roles=[ROLE_ADMIN])
        assert admin.has_all(["customer.read", "order.create"]) is True
        assert admin.has_any(["customer.read", "no.such.perm"]) is True
        assert admin.has_all(["no.such.perm"]) is False
        assert admin.has_any(["no.such.perm"]) is False

    def test_can_see_owner(self):
        admin = CurrentUser.build(id=1, username="admin", roles=[ROLE_ADMIN])
        scoped = CurrentUser.build(
            id=9, username="operator", roles=[ROLE_OPERATOR], owner_scope="SELF"
        )
        assert admin.can_see_owner(4242) is True
        assert scoped.can_see_owner(9) is True
        assert scoped.can_see_owner(10) is False

    def test_owner_scope_ids_self_and_team(self, seeded_db):
        from app.domain.users import User

        admin = CurrentUser.build(id=1, username="admin", roles=[ROLE_ADMIN])
        assert owner_scope_ids(seeded_db, admin) is None  # ALL 作用域不过滤

        self_scoped = CurrentUser.build(
            id=9, username="operator", roles=[ROLE_OPERATOR], owner_scope="SELF"
        )
        assert owner_scope_ids(seeded_db, self_scoped) == {9}

        team_scoped = CurrentUser.build(
            id=9, username="operator", roles=[ROLE_OPERATOR], owner_scope="TEAM",
            team_ids=[3],
        )
        seeded_db.add(
            User(
                username="mate", display_name="同事",
                password_hash=hash_password("mate-pwd"),
                role=ROLE_OPERATOR, team_ids=[3],
            )
        )
        seeded_db.flush()
        mate_id = seeded_db.scalar(
            select(User.id).where(User.username == "mate")
        )
        assert owner_scope_ids(seeded_db, team_scoped) == {9, mate_id}
        # 无成员作用域（TEAM 但无 team_ids）退化为仅自己
        lone = CurrentUser.build(
            id=9, username="operator", roles=[ROLE_OPERATOR], owner_scope="TEAM",
            team_ids=[],
        )
        assert owner_scope_ids(seeded_db, lone) == {9}

    def test_owner_scope_filter_none_for_admin(self, seeded_db):
        from app.domain.foundation import Pool

        admin = CurrentUser.build(id=1, username="admin", roles=[ROLE_ADMIN])
        assert owner_scope_filter(Pool.id, admin, seeded_db) is None


class TestTokenGuards:
    def test_malformed_token_rejected(self):
        with pytest.raises(AuthError) as exc:
            decode_token("not-a-jwt")
        assert "登录凭证格式无效" in str(exc.value)

    def test_bad_signature_rejected(self):
        from app.core.security import build_access_token

        token = build_access_token(
            CurrentUser.build(id=1, username="admin", roles=[ROLE_ADMIN])
        )
        header, payload, signature = token.split(".")
        tampered = f"{header}.{payload}.{signature[:-4]}xxxx"
        with pytest.raises(AuthError) as exc:
            decode_token(tampered)
        assert "登录凭证校验失败" in str(exc.value)

    @staticmethod
    def _signed_token(header: dict, payload: str | dict) -> str:
        """按当前密钥签出合法签名，让校验走到解析/算法/有效期分支。"""
        import base64
        import json

        def b64(data: bytes) -> str:
            return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

        raw_payload = payload if isinstance(payload, str) else json.dumps(payload)
        head = b64(json.dumps(header).encode())
        body = b64(raw_payload.encode())
        from app.core.security import _sign, get_settings

        signature = _sign(f"{head}.{body}", get_settings().jwt_secret_key)
        return f"{head}.{body}.{signature}"

    def test_unparseable_token_rejected(self):
        token = self._signed_token({"alg": "HS256", "typ": "JWT"}, "!!!not-json!!!")
        with pytest.raises(AuthError) as exc:
            decode_token(token)
        assert "无法解析" in str(exc.value)

    def test_unexpected_algorithm_rejected(self):
        token = self._signed_token(
            {"alg": "none", "typ": "JWT"}, {"sub": "1", "exp": 4102444800}
        )
        with pytest.raises(AuthError) as exc:
            decode_token(token)
        assert "算法不被接受" in str(exc.value)

    def test_expired_token_rejected(self):
        token = self._signed_token(
            {"alg": "HS256", "typ": "JWT"}, {"sub": "1", "exp": 1000000}
        )
        with pytest.raises(TokenExpired):
            decode_token(token)

    def test_authorization_header_must_be_bearer(self, seeded_client):
        response = seeded_client.get(
            "/api/v1/orders", headers={"Authorization": "Basic abc"}
        )
        assert response.status_code == 401


class TestPasswordGuards:
    def test_short_password_rejected(self):
        with pytest.raises(ValueError) as exc:
            hash_password("short")
        assert "至少需要 8 位" in str(exc.value)

    def test_verify_wrong_password_and_bad_encoding(self):
        encoded = hash_password("correct-horse")
        assert verify_password("wrong-password", encoded) is False
        assert verify_password("correct-horse", "plain$1$x$y") is False  # 296-297
        assert verify_password("correct-horse", "broken") is False  # 302-303


class TestRequireRole:
    def test_role_dependency_allows_matching_role(self, seeded_db):
        # 依赖工厂直接调用：命中角色放行，未命中抛 PermissionDenied
        dependency = require_role(ROLE_ADMIN).dependency
        admin = CurrentUser.build(id=1, username="admin", roles=[ROLE_ADMIN])
        assert dependency(user=admin).username == "admin"
        viewer = CurrentUser.build(id=2, username="viewer", roles=["VIEWER"])
        with pytest.raises(Exception) as exc:
            dependency(user=viewer)
        assert "无权访问" in str(exc.value)

    def test_endpoint_permission_denied_for_viewer(self, seeded_client):
        # 端点级：viewer 无 pool.manage → 403
        response = seeded_client.post(
            "/api/v1/pools",
            json={"code": "TMPVIEW", "name": "越权池"},
            headers={"X-Dev-User": "viewer"},
        )
        assert response.status_code == 403


# ------------------------------------------------------------------ settings
class TestSettingsHelpers:
    def test_locate_env_file_override_and_miss(self, monkeypatch, tmp_path):
        override = tmp_path / "custom.env"
        override.write_text("APP_ENV=test\n")
        monkeypatch.setenv("ERP_ENV_FILE", str(override))
        assert settings_module.locate_env_file() == override

        monkeypatch.delenv("ERP_ENV_FILE", raising=False)
        monkeypatch.setattr(settings_module, "PROJECT_ROOT", tmp_path / "no-root")
        monkeypatch.setattr(settings_module, "BACKEND_DIR", tmp_path / "no-backend")
        assert settings_module.locate_env_file() is None

    def test_non_sqlite_url_bypasses_path_extraction(self):
        assert (
            settings_module.Settings._reject_legacy_database("postgresql://u:p@h/db")
            == "postgresql://u:p@h/db"
        )
        settings = settings_module.Settings(database_url="postgresql://u:p@h/db")
        assert settings.sqlite_file is None

    def test_sqlalchemy_url_creates_parent_dir(self, tmp_path):
        target = tmp_path / "nested" / "erp.db"
        settings = settings_module.Settings(database_url=f"sqlite:///{target}")
        assert settings.sqlalchemy_url == f"sqlite:///{target}"
        assert target.parent.is_dir()  # 130：父目录自动创建
        assert settings.alembic_url == settings.sqlalchemy_url


# ------------------------------------------------------------------ database
class TestDatabaseLifecycle:
    def test_build_engine_non_sqlite_uses_pool_ping(self, monkeypatch):
        captured: dict[str, object] = {}

        def fake_create_engine(url, **kwargs):
            captured["url"] = url
            captured.update(kwargs)
            return create_engine("sqlite://")

        monkeypatch.setattr(database, "create_engine", fake_create_engine)
        database.build_engine("postgresql://u:p@h/db")
        assert captured["url"] == "postgresql://u:p@h/db"
        assert captured["pool_pre_ping"] is True

    def test_sqlite_connect_args_and_engine_cache(self, tmp_path):
        assert database._sqlite_connect_args() == {"check_same_thread": False}
        url = f"sqlite:///{tmp_path / 'db1.sqlite'}"
        first = database.get_engine(url)
        assert first is not None
        # 无 url 时走单例缓存（可能已被其它用例构建过）
        assert database.get_engine() is not None

    def test_foreign_key_pragma_skips_non_sqlite(self):
        # 非 SQLite 方言直接跳过（事件监听对 PG/MySQL 生效但无需 PRAGMA）
        class _FakeConnection:
            __class__ = type("FakeConnection", (), {"__module__": "psycopg"})

        assert database._enable_sqlite_foreign_keys(_FakeConnection(), None) is None

    def test_session_factory_defaults_to_engine_singleton(self, tmp_path, monkeypatch):
        engine = create_engine(f"sqlite:///{tmp_path / 'db3.sqlite'}")
        monkeypatch.setattr(database, "get_engine", lambda url=None: engine)
        database._session_factory = None
        factory = database.get_session_factory()
        assert factory.kw["bind"] is engine

    def test_reset_session_factory_and_create_all(self, tmp_path):
        url = f"sqlite:///{tmp_path / 'db2.sqlite'}"
        engine = database.reset_engine(url)
        assert engine is not None
        factory = database.get_session_factory(url)
        session = factory()
        assert session.get_bind() is not None
        session.close()

        database.create_all(url)
        assert (tmp_path / "db2.sqlite").exists()
        database.dispose_engine()
        assert database._engine is None

    def test_get_db_commits_and_rolls_back(self, v1_engine, monkeypatch):
        factory = sessionmaker(
            bind=v1_engine, autoflush=False, autocommit=False, future=True
        )
        monkeypatch.setattr(database, "get_session_factory", lambda: factory)

        committed = database.get_db()
        session = next(committed)
        assert session is not None
        next(committed, None)  # 正常结束 → commit

        failed = database.get_db()
        next(failed)
        with pytest.raises(RuntimeError):
            failed.throw(RuntimeError("boom"))

    def test_describe_engine_reports_sqlite_state(self):
        info = database.describe_engine()
        assert "sqlite_exists" in info


# ------------------------------------------------------------------ 应用入口
class TestApiV1Health:
    def test_root_and_health_endpoints(self, client):
        root = client.get("/")
        assert root.status_code == 200, root.text
        assert root.json()["docs"] == "/docs"

        health = client.get("/api/v1/health")
        assert health.status_code == 200, health.text
        assert health.json()["status"] == "ok"
