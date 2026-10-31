"""业务类型、资金路由与编号规则的 Service 测试。"""
from __future__ import annotations

import pytest

from app.core.errors import AppError, ErrorCode
from app.domain.enums import CapitalType, PoolStatus, Portion
from app.foundation import service


class TestOrderTypes:
    def test_new_business_needs_no_code_change(self, db):
        order_type = service.create_order_type(
            db, code="TB", name="同行代收", capital_type=CapitalType.STOCK.value, actor="pytest"
        )
        db.commit()
        assert order_type.is_active is False
        assert order_type.sequence_key == "ORDER_TB"
        assert order_type.sequence_prefix == "TB"

    def test_activate_without_route_is_blocked(self, db):
        order_type = service.create_order_type(
            db, code="TB", name="同行代收", capital_type=CapitalType.STOCK.value, actor="pytest"
        )
        db.commit()
        with pytest.raises(AppError) as exc:
            service.set_order_type_active(db, order_type.id, True, actor="pytest")
        assert exc.value.code == ErrorCode.POOL_ROUTE_MISSING

    def test_duplicate_business_code_rejected(self, seeded_db):
        with pytest.raises(AppError) as exc:
            service.create_order_type(
                seeded_db, code="HS", name="重复回收", capital_type=CapitalType.STOCK.value, actor="pytest"
            )
        assert exc.value.code == ErrorCode.DUPLICATE_CODE

    def test_invalid_capital_type_rejected(self, db):
        with pytest.raises(AppError):
            service.create_order_type(db, code="XX", name="坏业务", capital_type="MAGIC", actor="pytest")

    def test_retired_dfq_capital_type_rejected(self, db):
        with pytest.raises(AppError):
            service.create_order_type(db, code="DFQ", name="代分期", capital_type="CREDIT", actor="pytest")


class TestRoutes:
    def test_default_routes_of_seeded_business(self, seeded_db):
        assert service.resolve_default_pool(seeded_db, "HS", Portion.PRINCIPAL.value).code == "HJ_INVEST"
        assert service.resolve_default_pool(seeded_db, "HS", Portion.PROFIT.value).code == "HJ_PROFIT"
        assert service.resolve_default_pool(seeded_db, "DG", Portion.GROSS.value).code == "HJ_PROFIT"

    def test_missing_route_raises_pool_route_missing(self, seeded_db):
        with pytest.raises(AppError) as exc:
            service.require_default_pool(seeded_db, "DG", Portion.PRINCIPAL.value)
        assert exc.value.code == ErrorCode.POOL_ROUTE_MISSING
        assert exc.value.http_status == 422

    def test_route_is_upsert_by_business_and_portion(self, seeded_db):
        order_type = service.require_order_type_by_code(seeded_db, "HS")
        before_total = len(service.list_routes(seeded_db, order_type_id=order_type.id))
        service.set_route(
            seeded_db,
            order_type_code="HS",
            portion=Portion.PRINCIPAL.value,
            pool_code="HJ_PROFIT",
            actor="pytest",
        )
        seeded_db.commit()
        after_total = len(service.list_routes(seeded_db, order_type_id=order_type.id))
        assert before_total == after_total
        assert service.resolve_default_pool(seeded_db, "HS", Portion.PRINCIPAL.value).code == "HJ_PROFIT"

    def test_fund_nature_route_precedes_legacy_portion_route(self, seeded_db):
        service.set_route(
            seeded_db,
            order_type_code="HS",
            portion=Portion.PRINCIPAL.value,
            fund_nature="BUSINESS",
            pool_code="HJ_PROFIT",
            actor="pytest",
        )
        seeded_db.commit()

        assert (
            service.resolve_default_pool(
                seeded_db,
                "HS",
                Portion.PRINCIPAL.value,
                fund_nature="BUSINESS",
            ).code
            == "HJ_PROFIT"
        )
        assert service.resolve_default_pool(seeded_db, "HS", Portion.PRINCIPAL.value).code == "HJ_INVEST"

    def test_route_to_disabled_pool_rejected(self, seeded_db):
        service.set_pool_status(
            seeded_db,
            service.get_pool_by_code(seeded_db, "HJ_PROFIT").id,
            PoolStatus.DISABLED.value,
            actor="pytest",
        )
        seeded_db.commit()
        with pytest.raises(AppError) as exc:
            service.set_route(
                seeded_db,
                order_type_code="HS",
                portion=Portion.PROFIT.value,
                pool_code="HJ_PROFIT",
                actor="pytest",
            )
        assert exc.value.code == ErrorCode.POOL_DISABLED


class TestOrderTypeValidationGuards:
    """补齐 create_order_type / set_route / route_impact_preview /
    resolve_default_pool 中仅经 service 直调才可触达的防御校验分支。"""

    def test_create_rejects_non_string_sequence_prefix(self, db):
        with pytest.raises(AppError):
            service.create_order_type(
                db,
                code="QX",
                name="非串前缀",
                capital_type=CapitalType.STOCK.value,
                sequence_prefix=123,
                actor="pytest",
            )

    def test_set_route_rejects_invalid_fund_nature(self, seeded_db):
        with pytest.raises(AppError) as exc:
            service.set_route(
                seeded_db,
                order_type_code="HS",
                portion=Portion.PRINCIPAL.value,
                pool_code="HJ_INVEST",
                fund_nature="BOGUS",
                actor="pytest",
            )
        assert "fund_nature" in str(exc.value)

    def test_impact_preview_rejects_invalid_portion(self, seeded_db):
        with pytest.raises(AppError) as exc:
            service.route_impact_preview(
                seeded_db,
                order_type_code="HS",
                portion="BOGUS",
                pool_code="HJ_INVEST",
            )
        assert "portion" in str(exc.value)

    def test_impact_preview_rejects_invalid_fund_nature(self, seeded_db):
        with pytest.raises(AppError) as exc:
            service.route_impact_preview(
                seeded_db,
                order_type_code="HS",
                portion=Portion.PRINCIPAL.value,
                pool_code="HJ_INVEST",
                fund_nature="BOGUS",
            )
        assert "fund_nature" in str(exc.value)

    def test_impact_preview_rejects_disabled_pool(self, seeded_db):
        pool = service.get_pool_by_code(seeded_db, "HJ_INVEST")
        service.set_pool_status(seeded_db, pool.id, PoolStatus.DISABLED.value, actor="pytest")
        seeded_db.commit()
        with pytest.raises(AppError) as exc:
            service.route_impact_preview(
                seeded_db,
                order_type_code="HS",
                portion=Portion.PRINCIPAL.value,
                pool_code="HJ_INVEST",
            )
        assert "已停用" in str(exc.value)

    def test_resolve_default_pool_rejects_invalid_fund_nature(self, seeded_db):
        with pytest.raises(AppError) as exc:
            service.resolve_default_pool(
                seeded_db, "HS", Portion.PRINCIPAL.value, fund_nature="BOGUS"
            )
        assert "fund_nature" in str(exc.value)
