"""Shared request-model behavior for the v1 API."""
from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict

T = TypeVar("T")


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


class EngineInfoOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    app_env: str
    app_name: str
    app_version: str
    api_prefix: str
    database: str
    env_file: str
    docs: str


__all__ = ["EngineInfoOut", "HealthOut", "PageOut", "RequestModel"]
