"""Shared request-model behavior for the v1 API."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class RequestModel(BaseModel):
    """Reject fields outside the published request contract."""

    model_config = ConfigDict(extra="forbid")


__all__ = ["RequestModel"]
