"""将搜索框中的完整金额解析为精确数值。"""
from __future__ import annotations

import re
from decimal import Decimal

_AMOUNT = re.compile(r"^(?:\d{1,16}|\d{1,3}(?:,\d{3}){1,5})(?:\.\d{1,2})?$")


def amount_keyword(keyword: str) -> Decimal | None:
    value = keyword.strip()
    if not _AMOUNT.fullmatch(value):
        return None
    amount = Decimal(value.replace(",", ""))
    return amount if amount < Decimal("10000000000000000") else None
