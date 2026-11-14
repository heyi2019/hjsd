"""SYS-01-03 订单详情附件接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.attachments import schemas, service
from app.core.database import get_db
from app.core.security import CurrentUser, get_current_user

router = APIRouter(tags=["SYS-01-03 订单详情附件"])


@router.get("/attachments", response_model=schemas.AttachmentListOut)
def list_attachments(
    entity_type: str = Query(min_length=1, max_length=32),
    entity_id: str = Query(min_length=1, max_length=128),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.AttachmentListOut:
    items = service.list_attachments(
        db, entity_type=entity_type, entity_id=entity_id, user=user
    )
    return schemas.AttachmentListOut(
        items=[schemas.AttachmentOut.model_validate(item) for item in items],
        total=len(items),
    )


@router.post("/attachments", response_model=schemas.AttachmentOut, status_code=201)
def create_attachment(
    payload: schemas.AttachmentCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.AttachmentOut:
    item = service.create_attachment(
        db,
        entity_type=payload.entity_type,
        entity_id=payload.entity_id,
        file_name=payload.file_name,
        content_type=payload.content_type,
        content_base64=payload.content_base64,
        user=user,
    )
    return schemas.AttachmentOut.model_validate(item)


@router.get("/attachments/{attachment_id}/download")
def download_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> FileResponse:
    item = service.get_attachment(db, attachment_id, user)
    return FileResponse(
        service.attachment_path(item),
        media_type=item.content_type,
        filename=item.file_name,
    )


@router.delete("/attachments/{attachment_id}", response_model=schemas.AttachmentOut)
def delete_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.AttachmentOut:
    item = service.delete_attachment(db, attachment_id, user=user)
    return schemas.AttachmentOut.model_validate(item)


__all__ = ["router"]
