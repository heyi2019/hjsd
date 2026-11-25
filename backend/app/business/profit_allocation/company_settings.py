"""公司分润比例设置；默认值用于尚未保存设置的新系统。"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.domain.options import OptionSet
from app.domain.enums import AuditAction
from app.shared.audit import record_audit
from app.shared.fixed_option_codes import COMPANY_PROFIT_CODE


@dataclass(frozen=True)
class CompanyProfitSettings:
    profit_rate: Decimal = Decimal("40.00")
    loss_rate: Decimal = Decimal("50.00")


def _options(value: CompanyProfitSettings) -> list[dict[str, str]]:
    return [{"value": "profit_rate", "label": str(value.profit_rate)}, {"value": "loss_rate", "label": str(value.loss_rate)}]


def _parse(row: OptionSet | None) -> CompanyProfitSettings:
    if row is None:
        return CompanyProfitSettings()
    values = {item.get("value"): item.get("label") for item in row.options or []}
    try:
        profit = Decimal(values["profit_rate"])
        loss = Decimal(values["loss_rate"])
        if any(not item.is_finite() or item < 0 or item > 100 or item.as_tuple().exponent < -2 for item in (profit, loss)):
            raise ValueError
        return CompanyProfitSettings(profit_rate=profit.quantize(Decimal("0.01")), loss_rate=loss.quantize(Decimal("0.01")))
    except (KeyError, TypeError, InvalidOperation, ValueError) as exc:
        raise Validation("公司分润设置无效") from exc


def get_company_settings(session: Session) -> CompanyProfitSettings:
    return _parse(session.scalar(select(OptionSet).where(OptionSet.code == COMPANY_PROFIT_CODE)))


def update_company_settings(session: Session, values: CompanyProfitSettings, *, actor: str) -> CompanyProfitSettings:
    session.execute(pg_insert(OptionSet).values(
        code=COMPANY_PROFIT_CODE, label="公司分润", group="BUSINESS", editable=False,
        options=_options(CompanyProfitSettings()), created_by=actor, updated_by=actor,
    ).on_conflict_do_nothing(index_elements=["code"]))
    row = session.scalar(select(OptionSet).where(OptionSet.code == COMPANY_PROFIT_CODE).with_for_update())
    assert row is not None
    before = _parse(row)
    row.options = _options(values)
    row.updated_by = actor
    record_audit(session, action=AuditAction.POLICY_CHANGE, entity_type="company_profit_settings", entity_id=COMPANY_PROFIT_CODE, actor=actor,
                 before={"profit_rate": str(before.profit_rate), "loss_rate": str(before.loss_rate)},
                 after={"profit_rate": str(values.profit_rate), "loss_rate": str(values.loss_rate)})
    session.flush()
    return values
