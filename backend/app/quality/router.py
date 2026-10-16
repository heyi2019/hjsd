"""QLT-01 质量与异常工作台只读接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import PERM_REPORT_READ, CurrentUser, require_permissions
from app.quality import service

router = APIRouter(tags=["QLT-01 质量与异常"])
read_quality = require_permissions(PERM_REPORT_READ)


@router.get("/quality/issues")
def list_quality_issues(
    db: Session = Depends(get_db), user: CurrentUser = read_quality
) -> dict:
    return service.summary(db, user=user)


__all__ = ["router"]
