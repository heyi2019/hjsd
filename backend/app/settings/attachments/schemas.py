"""SYS-01-03 附件接口模型。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import RequestModel


class AttachmentCreate(RequestModel):
    entity_type: str = Field(min_length=1, max_length=32)
    entity_id: str = Field(min_length=1, max_length=128)
    file_name: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=128)
    content_base64: str = Field(min_length=1)
    allow_duplicate: bool = False


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    attachment_no: str
    entity_type: str
    entity_id: str
    file_name: str
    content_type: str
    size_bytes: int
    sha256: str
    deleted_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    created_by: str
    updated_by: str


class AttachmentListOut(BaseModel):
    items: list[AttachmentOut]
    total: int


__all__ = ["AttachmentCreate", "AttachmentListOut", "AttachmentOut"]
