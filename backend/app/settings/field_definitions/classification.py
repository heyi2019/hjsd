"""固定业务分类口径：业务模式、业务类型与增值服务分层。"""
from __future__ import annotations

from typing import TypedDict


class BusinessClassification(TypedDict):
    business_mode: str
    business_type: str
    value_added_service: str | None


BUSINESS_CLASSIFICATION: dict[str, BusinessClassification] = {
    "HS": {"business_mode": "SELF", "business_type": "RECOVERY", "value_added_service": None},
    "TH": {"business_mode": "DISTRIBUTION", "business_type": "PICKUP", "value_added_service": None},
    "DG": {"business_mode": "DISTRIBUTION", "business_type": "CONSIGNMENT", "value_added_service": None},
}


def classification_for_order_type(code: str) -> BusinessClassification | None:
    """返回固定业务类型的分类；自定义业务未纳入 P0 分类口径。"""
    return BUSINESS_CLASSIFICATION.get(code.upper())


__all__ = ["BUSINESS_CLASSIFICATION", "BusinessClassification", "classification_for_order_type"]
