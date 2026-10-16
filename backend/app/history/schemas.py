"""history 请求契约：标准导入与人工映射。"""
from __future__ import annotations

from typing import Any

from pydantic import Field

from app.core.schemas import RequestModel
from app.domain.enums import ImportSourceKind


class ImportBatchCreate(RequestModel):
    source_name: str = Field(min_length=1, max_length=128)
    rows: list[dict[str, Any]] = Field(min_length=1)
    source_kind: str = Field(default=ImportSourceKind.ORDER.value, min_length=1, max_length=32)
    note: str | None = None


class ImportRowMapping(RequestModel):
    order_id: int | None = Field(default=None, gt=0)
    account_id: int | None = Field(default=None, gt=0)
    basis: str = Field(default="", max_length=2000)


class ImportRowSkip(RequestModel):
    reason: str = Field(default="", max_length=2000)


class ImportRowUnlinkedTransfer(RequestModel):
    note: str | None = Field(default=None, max_length=2000)


class ImportBatchRollback(RequestModel):
    reason: str = Field(default="", max_length=2000)


class ImportCorrectionCreate(RequestModel):
    rows: list[dict[str, Any]] = Field(min_length=1)
    reason: str = Field(default="", max_length=2000)


__all__ = [
    "ImportBatchCreate",
    "ImportBatchRollback",
    "ImportCorrectionCreate",
    "ImportRowMapping",
    "ImportRowSkip",
    "ImportRowUnlinkedTransfer",
]
