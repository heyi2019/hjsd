"""imports 请求契约：标准导入与人工映射。"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

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


class ImportBatchOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    batch_no: str
    source_name: str
    source_kind: str
    status: str
    row_count: int
    unmapped_count: int
    committed_at: str | None = None
    rolled_back_at: str | None = None
    rolled_back_by: str | None = None
    rollback_reason: str | None = None
    corrects_batch_id: int | None = None
    note: str | None = None


class ImportBatchListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ImportBatchOut]
    total: int


class ImportRowOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    batch_id: int
    row_no: int
    raw: dict[str, Any]
    mapped_order_id: int | None = None
    mapped_account_id: int | None = None
    mapped_by: str | None = None
    mapped_at: str | None = None
    mapping_basis: str | None = None
    mapped_before: dict[str, Any] | None = None
    status: str
    unlinked_transfer: bool
    issue_note: str | None = None


class ImportRowListOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ImportRowOut]
    total: int


class ImportCommitOut(ImportBatchOut):
    imported: int
    unmapped: int


class ImportRollbackOut(ImportBatchOut):
    rolled_back_rows: int


class ImportCorrectionOut(ImportBatchOut):
    corrects_batch_no: str


class ImportPreviewColumnOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_column: str
    target_field: str | None = None
    suggested: bool
    present_count: int
    filled_count: int
    fill_rate: float
    samples: list[str]


class ImportPreviewOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    batch_id: int
    batch_no: str
    source_name: str
    total_rows: int
    columns: list[ImportPreviewColumnOut]
    abnormal: dict[str, Any]
    blockers: list[str]


class ImportReconciliationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    batch_id: int
    batch_no: str
    source_name: str
    status: str
    generated_at: str
    rows: dict[str, int]
    amounts: dict[str, Any]
    funds: dict[str, Any]
    requires_adjudication: bool


__all__ = [
    "ImportBatchCreate",
    "ImportBatchListOut",
    "ImportBatchOut",
    "ImportBatchRollback",
    "ImportCommitOut",
    "ImportCorrectionCreate",
    "ImportCorrectionOut",
    "ImportPreviewColumnOut",
    "ImportPreviewOut",
    "ImportReconciliationOut",
    "ImportRollbackOut",
    "ImportRowMapping",
    "ImportRowListOut",
    "ImportRowOut",
    "ImportRowSkip",
    "ImportRowUnlinkedTransfer",
]
