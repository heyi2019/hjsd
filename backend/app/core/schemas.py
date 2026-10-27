"""Shared request-model behavior for the v1 API."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class RequestModel(BaseModel):
    """Reject fields outside the published request contract."""

    model_config = ConfigDict(extra="forbid")


class HealthOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
    database_status: str
    app_env: str
    app_name: str
    app_version: str
    api_prefix: str
    database: str
    env_file: str
    sqlite_exists: str
    # 连接级 PRAGMA 现值（journal_mode/synchronous/cache_size/mmap_size/
    # temp_store/foreign_keys）。配置写错在 SQLite 里是静默无效，运行期现值
    # 只能这样读出来；非 SQLite 库为空 dict。
    sqlite_pragmas: dict[str, str] = {}


class EngineInfoOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    app_env: str
    app_name: str
    app_version: str
    api_prefix: str
    database: str
    env_file: str
    sqlite_exists: str
    docs: str


__all__ = ["EngineInfoOut", "HealthOut", "RequestModel"]
