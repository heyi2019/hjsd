"""T01 / SYS-01-01：配置必须来自**根目录 .env**，且不得指向旧库。"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.settings import (
    BACKEND_DIR,
    PROJECT_ROOT,
    Settings,
    get_settings,
    locate_env_file,
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


def test_production_never_widens_cors():
    """生产环境必须收紧：端口通配一律失效，且不得回落成 *。"""
    for env in ("production", "staging", "prod"):
        settings = Settings(app_env=env)
        assert settings.cors_origin_regex is None, f"{env} 不应放宽 CORS"
        assert "*" not in settings.cors_origin_list


def test_cors_origin_list_still_parses_env():
    """显式白名单仍走环境变量，不因通配而失效。"""
    settings = Settings(cors_origins="http://a.test, http://b.test ,")
    assert settings.cors_origin_list == ["http://a.test", "http://b.test"]


def test_dev_wildcard_can_be_disabled():
    """显式关闭开关后立即收紧，便于生产或收紧策略。"""
    settings = Settings(app_env="development", cors_dev_allow_any_local_port=False)
    assert settings.cors_origin_regex is None
