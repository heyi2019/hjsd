"""订单导入预检与执行的响应契约。"""
from typing import Literal

from pydantic import BaseModel, Field


class ImportRowOut(BaseModel):
    sheet: str
    row: int
    order_no: str
    action: Literal["create", "update", "skip", "error"]
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
    created: int
    updated: int
    skipped: int
    events_created: int
    events_matched: int
    cashflows_created: int
    cashflows_matched: int
    cashflows_renumbered: list[ImportRenumberedCashflowOut]
    rebates_created: int
    rebates_updated: int
    rows: list[ImportRowOut]
