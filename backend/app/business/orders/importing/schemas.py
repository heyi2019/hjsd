"""订单导入预检与执行的响应契约。"""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ImportRowOut(BaseModel):
    sheet: str
    row: int
    order_no: str
    action: Literal["create", "update", "inventory", "skip", "error"]
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ImportDetailErrorOut(BaseModel):
    sheet: str
    row: int | None = None
    message: str


class ImportPreviewOut(BaseModel):
    rows: list[ImportRowOut]
    available_sections: dict[str, int]
    selected_sections: list[Literal["details", "events", "cashflows", "rebates"]]
    detail_errors: list[ImportDetailErrorOut]


class ImportRenumberedCashflowOut(BaseModel):
    source: str
    current: str


class ImportResultOut(BaseModel):
    batch_id: int
    created: int
    updated: int
    skipped: int
    inventories_created: int = 0
    events_created: int
    events_matched: int
    cashflows_created: int
    cashflows_matched: int
    cashflows_renumbered: list[ImportRenumberedCashflowOut]
    rebates_created: int
    rebates_updated: int
    rows: list[ImportRowOut]


class ImportHistoryOut(BaseModel):
    id: int
    file_name: str
    actor: str
    imported_at: datetime
    created: int
    updated: int
    skipped: int
    inventories_created: int
    status: Literal["imported", "reverted"]
    reversible: bool
    reason: str | None = None
