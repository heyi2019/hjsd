"""T01 / SYS-01-01：配置必须来自**根目录 .env**，且不得指向旧库。"""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api_v1 import create_app
from app.core.settings import (
    BACKEND_DIR,
    PROJECT_ROOT,
    Settings,
    get_settings,
    locate_env_file,
)

SECURE_TEST_SECRET = "test-production-secret-0123456789-abcdef"


def test_default_application_version_is_semver_without_release_prefix():
    """API 对外使用 SemVer；V 前缀只属于系统发布标签。

    版本号的唯一事实源是 `app/version.py`：这里断言"配置默认值 == 事实源"，
    再校验格式。发版只改 version.py，本测试无需跟着改，但能挡住手滑写坏。
    """
    from app.version import __version__ as release_version

    assert Settings().app_version == release_version
    assert re.fullmatch(r"\d+\.\d+\.\d+", release_version), "必须是 x.y.z 形式，且不带 v 前缀"


def test_frontend_version_matches_backend_release_version():
    """前后端版本必须同源，否则线上无法判断前端跑的是哪份代码。

    典型漂移：只改 `backend/app/version.py` 就发版 → 前端包版本仍是旧的，
    页面/构建产物与 `/health` 报的版本号打架。发版请走
    `scripts/ops/bump_version.sh`，它一次改齐三处（version.py / package.json /
    package-lock.json），本断言是事后兜底。
    """
    import json

    from app.version import __version__ as release_version

    pkg_path = PROJECT_ROOT / "frontend" / "package.json"
    lock_path = PROJECT_ROOT / "frontend" / "package-lock.json"
    assert pkg_path.is_file(), f"缺少前端 package.json：{pkg_path}"

    pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    assert pkg["version"] == release_version, (
        f"frontend/package.json={pkg['version']} 与 backend/app/version.py="
        f"{release_version} 不一致，请运行 scripts/ops/bump_version.sh"
    )

    if lock_path.is_file():
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        assert lock["version"] == release_version, "package-lock.json 顶层版本未同步"
        assert lock["packages"][""]["version"] == release_version, (
            "package-lock.json 根包版本未同步"
        )


def test_env_file_is_project_root_dotenv():
    """本地开发与联调指南 §1：必须读根目录 .env，而不是 backend/.env。"""
    path = locate_env_file()
    assert path is not None, "根目录缺少 .env，请从 .env.example 复制后替换 JWT 密钥"
    assert path.parent == PROJECT_ROOT
    assert path.name == ".env"


def test_settings_loads_from_root_env():
    settings = get_settings()
    assert settings.env_file_path is not None
    assert settings.env_file_path.parent == PROJECT_ROOT
    assert settings.api_prefix == "/api/v1"
    assert settings.access_token_expire_minutes >= 1


def test_sqlite_path_is_resolved_under_backend(tmp_path):
    settings = Settings(database_url=f"sqlite:///{tmp_path}/x.db")
    assert settings.sqlite_file == tmp_path / "x.db"

    relative = Settings(database_url="sqlite:///./data/tmp_probe.db")
    assert relative.sqlite_file is not None
    assert relative.sqlite_file.is_absolute()
    assert relative.sqlite_file.parent == BACKEND_DIR / "data"


def test_default_database_is_independent_v1_file():
    """v1 默认库不得是旧 heijin.db / heijin_v2.db。"""
    settings = get_settings()
    sqlite_file = settings.sqlite_file
    assert sqlite_file is not None
    assert sqlite_file.name not in {"heijin.db", "heijin_v2.db"}
    assert sqlite_file.name == "heijin_erp_v1.db"


@pytest.mark.parametrize("legacy", ["heijin.db", "heijin_v2.db"])
def test_legacy_database_url_is_rejected(legacy):
    """V15/V17：把 v1 指向旧库必须在配置层炸掉。"""
    with pytest.raises(ValidationError) as exc:
        Settings(database_url=f"sqlite:///./data/{legacy}")
    assert "旧库" in str(exc.value)


def test_memory_database_allowed():
    settings = Settings(database_url="sqlite:///:memory:")
    assert settings.sqlite_file is None
    assert settings.sqlalchemy_url == "sqlite:///:memory:"


def test_describe_does_not_leak_secret():
    payload = get_settings().describe()
    assert isinstance(payload, dict)
    for key, value in payload.items():
        assert "secret" not in key.lower()
        assert isinstance(value, str)


# --- CORS：dev 端口通配 ---------------------------------------------------
# 背景（实测事故）：前端换到 5199 端口后，CORS 预检返回 400，
# axios 全部 Failed to fetch，但页面**不报错**，只静默显示
# 「资金池数量 0 / 尚未配置资金池」，与「真的没有数据」无法区分。


def test_dev_allows_any_local_port():
    """development 下必须放行本机任意端口，避免换端口即静默失败。"""
    settings = Settings(app_env="development")
    assert settings.cors_origin_regex is not None
    assert "localhost" in settings.cors_origin_regex
    assert "127" in settings.cors_origin_regex


def test_dev_cors_middleware_accepts_frontend_port():
    settings = Settings(
        app_env="development",
        database_url="sqlite:///:memory:",
    )
    response = TestClient(create_app(settings)).options(
        "/api/v1/orders",
        headers={
            "Origin": "http://127.0.0.1:5188",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5188"


def test_production_never_widens_cors():
    """生产环境必须收紧：端口通配一律失效，且不得回落成 *。"""
    for env in ("production", "staging", "prod"):
        settings = Settings(app_env=env, jwt_secret_key=SECURE_TEST_SECRET)
        assert settings.cors_origin_regex is None, f"{env} 不应放宽 CORS"
        assert "*" not in settings.cors_origin_list


def test_production_rejects_default_jwt_secret():
    with pytest.raises(ValidationError) as exc:
        Settings(
            app_env="production",
            jwt_secret_key="dev-insecure-secret-not-for-production-use!!",
        )
    assert "JWT" in str(exc.value)


def test_production_rejects_wildcard_cors():
    with pytest.raises(ValidationError) as exc:
        Settings(
            app_env="production",
            jwt_secret_key=SECURE_TEST_SECRET,
            cors_origins="*",
        )
    assert "CORS" in str(exc.value)


def test_cors_origin_list_still_parses_env():
    """显式白名单仍走环境变量，不因通配而失效。"""
    settings = Settings(cors_origins="http://a.test, http://b.test ,")
    assert settings.cors_origin_list == ["http://a.test", "http://b.test"]


def test_dev_wildcard_can_be_disabled():
    """显式关闭开关后立即收紧，便于生产或收紧策略。"""
    settings = Settings(app_env="development", cors_dev_allow_any_local_port=False)
    assert settings.cors_origin_regex is None


class TestSqliteRuntimeKnobs:
    """SQLite 运行参数可配可回退：默认走 WAL 推荐值，写错立即报错而非静默失效。"""

    def test_defaults_match_wal_recommendation(self):
        settings = Settings()
        assert settings.sqlite_synchronous == "NORMAL"
        assert settings.sqlite_cache_size_kb == 16000
        assert settings.sqlite_mmap_size_mb == 64
        assert settings.sqlite_temp_store == "MEMORY"
        assert settings.sqlite_busy_timeout_ms == 5000

    def test_values_are_normalized_and_env_overridable(self, monkeypatch):
        monkeypatch.setenv("SQLITE_SYNCHRONOUS", "full")
        monkeypatch.setenv("SQLITE_TEMP_STORE", "file")
        monkeypatch.setenv("SQLITE_CACHE_SIZE_KB", "0")
        monkeypatch.setenv("SQLITE_MMAP_SIZE_MB", "128")
        settings = Settings()
        assert settings.sqlite_synchronous == "FULL"
        assert settings.sqlite_temp_store == "FILE"
        assert settings.sqlite_cache_size_kb == 0
        assert settings.sqlite_mmap_size_mb == 128

    @pytest.mark.parametrize(
        ("field", "value"), [("sqlite_synchronous", "FAST"), ("sqlite_temp_store", "DISK")]
    )
    def test_unknown_enum_is_rejected(self, field, value):
        """拼错必须炸：PRAGMA 写错在 SQLite 里是静默无效，只能靠这里兜住。"""
        with pytest.raises(ValidationError):
            Settings(**{field: value})

    @pytest.mark.parametrize(
        "field", ["sqlite_cache_size_kb", "sqlite_mmap_size_mb", "sqlite_busy_timeout_ms"]
    )
    def test_negative_sizes_are_rejected(self, field):
        with pytest.raises(ValidationError):
            Settings(**{field: -1})

