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
