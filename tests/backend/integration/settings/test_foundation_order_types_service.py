"""MASTER-01 业务类型与编号规则的 Service 测试。"""
from __future__ import annotations

import pytest

from app.core.errors import AppError, ErrorCode
from app.domain.enums import AuditAction, EventType
from app.domain.options import OptionSet
from app.domain.trade_models.form_config import OrderFormField
from app.foundation.catalog_seed import seed_catalog
from app.foundation.order_types import create_order_type


class TestOrderTypes:
    def test_catalog_seed_is_idempotent_and_sets_cancel_flow_direction(self, db):
        seed_catalog(db, actor="pytest")
        db.commit()

        first_option_count = db.query(OptionSet).count()
        first_field_count = db.query(OrderFormField).count()
        cancel_amount = db.query(OrderFormField).filter_by(
            order_type_code="ORDERCANC", field_key="cancel_amount"
        ).one()
        assert cancel_amount.flow_direction == "IN"

        seed_catalog(db, actor="second")
        db.commit()

        assert db.query(OptionSet).count() == first_option_count
        assert db.query(OrderFormField).count() == first_field_count

    def test_order_event_dictionary_excludes_retired_cost_event(self, db):
        seed_catalog(db, actor="pytest")
        db.commit()

        event_types = db.query(OptionSet).filter_by(code="ORDER_EVENT_TYPE").one()
        values = [item["value"] for item in event_types.options or []]
        labels = [item["label"] for item in event_types.options or []]
        assert values == ["BUY", "SELL", "DELIVER", "CANCEL", "OPERATE", "REBATE"]
        assert "COST" not in values
        assert "PAYMENT" not in values
        assert "REFUND" not in values
        assert "附加成本" not in labels

    def test_active_event_enum_excludes_legacy_finance_events(self):
        assert [event.value for event in EventType] == [
            "BUY", "SELL", "DELIVER", "CANCEL", "OPERATE", "REBATE"
        ]

    def test_audit_action_dictionary_matches_runtime_enum(self, db):
        seed_catalog(db, actor="pytest")
        db.commit()

        audit_actions = db.query(OptionSet).filter_by(code="AUDIT_ACTION").one()
        values = [item["value"] for item in audit_actions.options or []]
        assert values == [action.value for action in AuditAction]

    def test_new_business_needs_no_code_change(self, db):
        order_type = create_order_type(
            db, code="TB", name="同行代收", actor="pytest"
        )
        db.commit()
        assert order_type.is_active is True
        assert order_type.sequence_key == "ORDER_TB"
        assert order_type.sequence_prefix == "TB"

    def test_duplicate_business_code_rejected(self, seeded_db):
        with pytest.raises(AppError) as exc:
            create_order_type(
                seeded_db, code="HS", name="重复回收", actor="pytest"
            )
        assert exc.value.code == ErrorCode.DUPLICATE_CODE


class TestOrderTypeValidationGuards:
    """补齐 create_order_type 中仅经 service 直调才可触达的防御校验分支。"""

    def test_create_rejects_non_string_sequence_prefix(self, db):
        with pytest.raises(AppError):
            create_order_type(
                db,
                code="QX",
                name="非串前缀",
                sequence_prefix=123,
                actor="pytest",
            )
