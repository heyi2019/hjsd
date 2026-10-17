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


__all__ = ["HealthOut", "RequestModel"]
