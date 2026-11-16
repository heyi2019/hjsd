"""工作台聚合接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import CurrentUser, get_current_user
from app.workbench import schemas, service

router = APIRouter(tags=["工作台"])


@router.get("/dashboard/summary", response_model=schemas.DashboardSummaryOut)
def dashboard_summary(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.DashboardSummaryOut:
    return schemas.DashboardSummaryOut.model_validate(
        service.dashboard_summary(db, user=user)
    )
