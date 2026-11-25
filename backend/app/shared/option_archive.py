"""保存已移除字典项的历史名称，供历史单据与导出使用。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet

OPTION_ITEM_ARCHIVE = "OPTION_ITEM_ARCHIVE"


def archive_option_items(session: Session, code: str, items: list[dict], *, actor: str) -> None:
    if not items:
        return
    row = session.scalar(select(OptionSet).where(OptionSet.code == OPTION_ITEM_ARCHIVE).with_for_update())
    if row is None:
        row = OptionSet(code=OPTION_ITEM_ARCHIVE, label="历史字典选项", group="SYSTEM", editable=False,
                        options=[], created_by=actor, updated_by=actor)
        session.add(row)
        session.flush()
    entries = {item["value"]: dict(item) for item in row.options or []}
    for item in items:
        archived = {**item, "value": f"{code}:{item['value']}"}
        entries[archived["value"]] = archived
    row.options = list(entries.values())
    row.updated_by = actor
