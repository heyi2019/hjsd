"""core.settings：v1 唯一配置入口。

约束（工程启动契约）：
1. 必须读取**仓库根目录** `.env`（`.env.example` 只是模板，不得当成已生效配置）。
2. 数据库统一 PostgreSQL（SQLite 支持已彻底下线，2026-11-02）：缺 `.env` 时回落到本机 PG 默认地址，
   连不上会明确报错，而不是静默在 `data/` 下新建一个 SQLite 文件。
3. `.env` 不入库；缺文件时回落到安全默认值 + APP_ENV=development。
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.version import __version__

BACKEND_DIR = Path(__file__).resolve().parents[2]  # app/core/settings.py -> backend
PROJECT_ROOT = BACKEND_DIR.parent  # 黑金时代/

# 缺 `.env` 时的本机兜底地址。刻意不带口令：连不上就明确报错，
# 好过静默在 data/ 下新建一个 SQLite 文件、把真实数据写进没人知道的角落。
DEFAULT_DEV_DATABASE_URL = "postgresql+psycopg://erp_app@127.0.0.1:5432/heijin_erp_dev"


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


def redact_database_url(url: str) -> str:
    """把连接串降级成「方言://主机:端口/库名」。

    健康检查与日志会原样输出这个字符串，因此**绝不能**带口令：PG 的 URL 形如
    `postgresql+psycopg://user:pass@host:5432/db`，直接回显等于把生产库口令写进
    接口响应体与日志。
    """
    try:
        from sqlalchemy.engine import make_url

        parsed = make_url(url)
    except Exception:  # pragma: no cover - 非法 URL 交由上层报错
        return "<unparsable>"
    host = parsed.host or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return f"{parsed.get_backend_name()}://{host}/{parsed.database or ''}"


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
    app_version: str = __version__
    log_level: str = "INFO"
    api_prefix: str = "/api/v1"

    # security
    jwt_secret_key: str = "dev-insecure-secret-not-for-production-use!!"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 480

    # 登录限流（仅生产生效，防 PBKDF2 暴力破解挤占 2 核 CPU）
    # 默认每客户端 IP 每分钟 10 次登录；开发/测试环境（app_env != production）自动绕过，
    # 避免打断本地开发与 k6 压测。多 worker 下各进程独立计数（登录防暴破足够）。
    login_rate_limit_enabled: bool = True
    login_rate_limit_per_minute: int = 10

    # database：统一 PostgreSQL（SQLite 已下线）。缺 .env 时用下面的本机兜底地址。
    database_url: str = DEFAULT_DEV_DATABASE_URL

    # 测试库：**必须与 database_url 分开**。pytest 夹具每个 session 会 TRUNCATE 全表 +
    # 序列归位，一旦回落指向开发库/正式库就是数据全毁（2026-11-02 已真实发生过一次：
    # .env 只配了 DATABASE_URL，夹具回落到它，把开发库 118 单清空）。
    # 空字符串表示未单独配置——此时夹具会拒绝运行，不静默回落。
    test_database_url: str = ""

    # 说明：原 SQLITE_SYNCHRONOUS / CACHE_SIZE_KB / MMAP_SIZE_MB / TEMP_STORE /
    # BUSY_TIMEOUT_MS 五个 PRAGMA 旋钮已随连接级 PRAGMA 应用函数一并下线；
    # 配置里若仍残留这些键会被 extra="ignore" 静默忽略，不再有任何效果。

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

    # attachments：业务附件独立于数据库文件保存，路径可由部署环境覆盖。
    attachment_storage_dir: str = "data/attachments"

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

    @field_validator("login_rate_limit_per_minute")
    @classmethod
    def _validate_non_negative(cls, value: int) -> int:
        """负值会让限流窗口失效（计数永远打不满），在配置层直接拒绝。"""
        if value < 0:
            raise ValueError("登录限流次数不得为负数（0 表示每个窗口一律拒绝，请确认意图）")
        return value

    @property
    def is_production(self) -> bool:
        """是否生产环境（统一口径）。

        登录限流、mock 短信回显、CORS 放行等安全开关都以此为准，避免散落的
        `app_env == "production"` 字符串比较漏判大小写/空白导致生产被当成开发。
        大小写与首尾空白归一：PRODUCTION / " production " 均识别为生产。
        """
        return self.app_env.strip().lower() == "production"

    @property
    def env_file_path(self) -> Path | None:
        return locate_env_file()

    @property
    def alembic_url(self) -> str:
        """供 engine / Alembic 使用的连接串（PG 下与 DATABASE_URL 一致）。"""
        return self.database_url

    @property
    def attachment_storage_path(self) -> Path:
        path = Path(self.attachment_storage_dir).expanduser()
        if not path.is_absolute():
            path = BACKEND_DIR / path
        return path

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
        return self.app_env.strip().lower() in {"development", "dev", "local"}

    def describe(self) -> dict[str, str]:
        """健康检查/排障用：不泄露密钥原文，也不回显连接串里的口令。"""
        return {
            "app_env": self.app_env,
            "app_name": self.app_name,
            "app_version": self.app_version,
            "api_prefix": self.api_prefix,
            "database": redact_database_url(self.database_url),
            "env_file": str(self.env_file_path) if self.env_file_path else "<none>",
        }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """进程内单例；测试用 get_settings.cache_clear() 重置。"""
    return Settings()


__all__ = [
    "BACKEND_DIR",
    "DEFAULT_DEV_DATABASE_URL",
    "PROJECT_ROOT",
    "Settings",
    "get_settings",
    "locate_env_file",
    "redact_database_url",
]
