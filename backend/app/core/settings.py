"""core.settings：v1 唯一配置入口。

约束（来源：ERP_本地开发与联调指南_v1.0.md §1、ERP_PRD_v1.0.md V15/V17/V18）：
1. 必须读取**仓库根目录** `.env`（`.env.example` 只是模板，不得当成已生效配置）。
2. v1 数据库与旧 `heijin.db` / `heijin_v2.db` 物理隔离：一旦指向旧库文件名立即报错。
3. `.env` 不入库；缺文件时回落到安全默认值 + APP_ENV=development。
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]  # app/core/settings.py -> backend
PROJECT_ROOT = BACKEND_DIR.parent  # 黑金时代/

# 旧库保护名单：v1 绝不允许在这些文件上建立/迁移（MIG/P2 迁移区 PRD §2.1.1）
LEGACY_SQLITE_FILENAMES = frozenset({"heijin.db", "heijin_v2.db"})
DEFAULT_DEV_DB_RELPATH = "data/heijin_erp_v1.db"


def locate_env_file() -> Path | None:
    """定位根目录 .env；允许用 ERP_ENV_FILE 覆盖（测试/多环境）。"""
    candidates: list[Path] = []
    override = os.environ.get("ERP_ENV_FILE")
    if override:
        candidates.append(Path(override).expanduser())
    candidates.extend([PROJECT_ROOT / ".env", BACKEND_DIR / ".env"])
    for path in candidates:
        if path.is_file():
            return path
    return None


class Settings(BaseSettings):
    """v1 配置项。环境变量优先级：系统环境变量 > .env > 默认值。"""

    model_config = SettingsConfigDict(
        env_file=locate_env_file(),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # application
    app_env: str = "development"
    app_name: str = "宜游轩ERP"
    app_version: str = "1.0.0"
    log_level: str = "INFO"
    api_prefix: str = "/api/v1"

    # security
    jwt_secret_key: str = "dev-insecure-secret-not-for-production-use!!"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 480

    # database（先 SQLite；生产换 PostgreSQL URL，业务代码零改动）
    database_url: str = f"sqlite:///./{DEFAULT_DEV_DB_RELPATH}"

    # cors（逗号分隔）：显式白名单，任何环境都生效
    cors_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:4173,http://127.0.0.1:4173"
    )

    # dev 端口通配：仅 development 生效，允许 localhost/127.0.0.1 任意端口。
    # 解决「换个端口起前端就静默 0 数据」——CORS 预检 400 时页面不报错，
    # 只显示空态，排查成本极高。生产环境强制忽略此项。
    cors_dev_allow_any_local_port: bool = True

    # frontend
    vite_api_base_url: str = "http://127.0.0.1:8123/api/v1"

    @model_validator(mode="after")
    def _validate_runtime_security(self) -> "Settings":
        """生产配置不得沿用开发密钥或通配 CORS。"""
        if self.is_development:
            return self
        if (
            len(self.jwt_secret_key) < 32
            or self.jwt_secret_key == "dev-insecure-secret-not-for-production-use!!"
            or self.jwt_secret_key.startswith("replace-with-")
        ):
            raise ValueError("生产环境必须配置至少 32 位随机 JWT_SECRET_KEY")
        if "*" in self.cors_origin_list:
            raise ValueError("生产环境 CORS_ORIGINS 不得使用通配符 *")
        return self

    @field_validator("database_url")
    @classmethod
    def _reject_legacy_database(cls, value: str) -> str:
        """V15/V17：禁止把 v1 指向历史库，避免覆盖真实经营数据。"""
        if not value.startswith("sqlite"):
            return value
        path = cls._extract_path(value)
        if path is None:
            return value
        filename = Path(path).name
        if filename in LEGACY_SQLITE_FILENAMES:
            raise ValueError(
                f"DATABASE_URL 不得指向旧库 {filename}；"
                "v1 必须使用独立数据库（建议使用 data/heijin_erp_v1.db）"
            )
        return value

    @staticmethod
    def _extract_path(url: str) -> str | None:
        """优先交给 SQLAlchemy 解析：`sqlite:////abs/a.db` 与 `sqlite:///./a.db` 都要正确。"""
        try:
            from sqlalchemy.engine import make_url

            database = make_url(url).database
        except Exception:  # pragma: no cover - 非法 URL 交由上层报错
            return None
        if not database or database.startswith(":"):  # sqlite:///:memory:
            return None
        return database

    @property
    def env_file_path(self) -> Path | None:
        return locate_env_file()

    @property
    def sqlite_file(self) -> Path | None:
        """返回 SQLite 数据库文件的绝对路径（非 SQLite 返回 None）。"""
        if not self.database_url.startswith("sqlite"):
            return None
        raw = self._extract_path(self.database_url)
        if raw is None:
            return None
        path = Path(raw)
        if not path.is_absolute():
            path = BACKEND_DIR / path
        return path

    @property
    def sqlalchemy_url(self) -> str:
        """供 engine / Alembic 使用的绝对 URL。"""
        sqlite_file = self.sqlite_file
        if sqlite_file is None:
            return self.database_url
        sqlite_file.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{sqlite_file}"

    @property
    def alembic_url(self) -> str:
        return self.sqlalchemy_url

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    @property
    def cors_origin_regex(self) -> str | None:
        """dev 下的本机任意端口；非 development 一律返回 None（不放宽）。"""
        if not self.cors_dev_allow_any_local_port or not self.is_development:
            return None
        return r"^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"

    @property
    def is_development(self) -> bool:
        return self.app_env.lower() in {"development", "dev", "local"}

    def describe(self) -> dict[str, str]:
        """健康检查/排障用：不泄露密钥原文。"""
        sqlite_file = self.sqlite_file
        return {
            "app_env": self.app_env,
            "app_name": self.app_name,
            "app_version": self.app_version,
            "api_prefix": self.api_prefix,
            "database": str(sqlite_file) if sqlite_file else "non-sqlite",
            "env_file": str(self.env_file_path) if self.env_file_path else "<none>",
        }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """进程内单例；测试用 get_settings.cache_clear() 重置。"""
    return Settings()


__all__ = [
    "BACKEND_DIR",
    "LEGACY_SQLITE_FILENAMES",
    "PROJECT_ROOT",
    "Settings",
    "get_settings",
    "locate_env_file",
]
