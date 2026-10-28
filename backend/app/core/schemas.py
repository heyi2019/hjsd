"""Shared request-model behavior for the v1 API."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict

T = TypeVar("T")


def normalize_product_aliases(value: object) -> object:
    """将产品口径别名归一化为历史 API 字段名。

    ``game_account`` 是单一交易实体（产品），``game_type`` 是产品类型。
    接口继续输出并存储历史字段名，同时接受产品口径客户端提交的
    ``product`` / ``product_type``，避免两套字段形成双事实源。
    """
    if not isinstance(value, Mapping):
        return value
    data = dict(value)
    for alias, canonical in (("product", "game_account"), ("product_type", "game_type")):
        if alias not in data:
            continue
        alias_value = data.pop(alias)
        if canonical in data and data[canonical] not in (None, alias_value):
            raise ValueError(f"{canonical} 与 {alias} 不能同时填写不同值")
        data.setdefault(canonical, alias_value)
    return data


class RequestModel(BaseModel):
    """Reject fields outside the published request contract."""

    model_config = ConfigDict(extra="forbid")


class PageOut(BaseModel, Generic[T]):
    """统一列表响应：分页元数据与数据项始终同层返回。"""

    model_config = ConfigDict(extra="forbid")

    items: list[T]
    total: int
    limit: int
    offset: int


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


__all__ = ["EngineInfoOut", "HealthOut", "PageOut", "RequestModel", "normalize_product_aliases"]
