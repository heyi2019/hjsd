"""客户中心共用的创建日期筛选。"""
from datetime import date

from fastapi import Query

from app.core.errors import Validation


def created_date_filter(
    created_from: date | None = Query(default=None),
    created_to: date | None = Query(default=None),
) -> dict:
    if (created_from is None) != (created_to is None) or (created_from is not None and created_to is not None and created_from > created_to):
        raise Validation("请选择有效的创建日期范围")
    return {"created_from": created_from, "created_to": created_to}
