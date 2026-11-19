"""工作台聚合接口。"""
from __future__ import annotations

from datetime import date
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import CurrentUser
from app.settings.auth.session import get_current_user
from app.dashboard import schemas, service

router = APIRouter(tags=["工作台"])


@router.get("/dashboard/summary", response_model=schemas.DashboardSummaryOut)
def dashboard_summary(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    all_time: bool = Query(default=False),
) -> schemas.DashboardSummaryOut:
    return schemas.DashboardSummaryOut.model_validate(
        service.dashboard_summary(db, user=user, from_date=from_date, to_date=to_date, all_time=all_time)
    )
