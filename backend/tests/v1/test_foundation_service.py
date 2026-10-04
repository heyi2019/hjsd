"""T02 / BAS-02 / BAS-03：资金池、业务类型、路由的 Service 层。

覆盖：V17（有流水禁删）、V18（code 不可改）、V32（业务是主数据）、
V33（路由不写死）、BAS-02-02（无路由不可启用）、审计留痕。
"""
from __future__ import annotations

import pytest

from app.core.errors import AppError, ErrorCode
from app.domain.enums import AuditAction, CapitalType, PoolOwnership, PoolStatus, Portion
from app.domain.foundation import AuditLog
from app.foundation import service
from app.foundation.seeds import seed_foundation


class TestSeed:
    def test_seed_is_idempotent(self, db):
        first = seed_foundation(db, actor="pytest")
        db.commit()
        second = seed_foundation(db, actor="pytest")
        db.commit()

        assert first["pools_created"] == 2
        assert first["order_types_created"] == 4
        assert first["routes_created"] == 8
        assert second["pools_created"] == 0
        assert second["pools_skipped"] == 2
        assert second["order_types_created"] == 0
        assert second["order_types_skipped"] == 4

    def test_seeded_pools_and_order_types(self, seeded_db):
        invest = service.get_pool_by_code(seeded_db, "HJ_INVEST")
        profit = service.get_pool_by_code(seeded_db, "HJ_PROFIT")
        assert invest is not None and profit is not None
        assert invest.ownership == PoolOwnership.OWNED.value
        assert invest.pool_type == "INVEST"
        assert profit.pool_type == "PROFIT"

        expected = {
            "HS": (CapitalType.STOCK.value, 1),
            "TH": (CapitalType.PASS_THRU.value, 2),
            "DG": (CapitalType.ZERO.value, 3),
            "DFQ": (CapitalType.CREDIT.value, 4),
        }
        codes = {item.code: item for item in service.list_order_types(seeded_db)}
        for code, (capital_type, _) in expected.items():
            assert codes[code].capital_type == capital_type
            assert codes[code].is_active is True

    def test_seed_writes_audit(self, seeded_db):
        count = (
            seeded_db.query(AuditLog)
            .filter(AuditLog.entity_type == "Seed", AuditLog.entity_id == "M0")
            .count()
        )
        assert count >= 1


class TestPools:
    def test_create_pool_and_duplicate_code(self, db):
        pool = service.create_pool(
            db, code="hj_custody", name="代客保管池", actor="pytest", ownership="CUSTODY"
        )
        db.commit()
        assert pool.code == "HJ_CUSTODY"  # 代码统一大写
        assert pool.status == PoolStatus.ACTIVE.value

        with pytest.raises(AppError) as exc:
            service.create_pool(db, code="HJ_CUSTODY", name="重复", actor="pytest")
        assert exc.value.code == ErrorCode.DUPLICATE_CODE

    def test_pool_code_is_immutable(self, db):
        """V18：code 只能新建，接口层不提供改 code 的入口。"""
        pool = service.create_pool(db, code="TMP1", name="临时池", actor="pytest")
        db.commit()
        updated = service.update_pool(db, pool.id, actor="pytest", name="临时池改名")
        assert updated.code == "TMP1"
        assert updated.name == "临时池改名"

    def test_invalid_ownership_rejected(self, db):
        with pytest.raises(AppError):
            service.create_pool(db, code="TMP2", name="坏池", actor="pytest", ownership="MARS")

    def test_delete_blocked_when_pool_has_cashflow(self, db, monkeypatch):
        """V17：有流水的池只能停用。"""
        pool = service.create_pool(db, code="TMP3", name="带流水池", actor="pytest")
        db.commit()
        monkeypatch.setattr(service, "_has_cashflow", lambda session, pool_id: True)
        with pytest.raises(AppError) as exc:
            service.delete_pool(db, pool.id, actor="pytest")
        assert exc.value.code == ErrorCode.POOL_HAS_TRANSACTIONS

    def test_delete_allowed_when_empty(self, db):
        pool = service.create_pool(db, code="TMP4", name="空池", actor="pytest")
        db.commit()
        service.delete_pool(db, pool.id, actor="pytest")
        db.commit()
        assert service.get_pool_by_code(db, "TMP4") is None

    def test_disable_pool_blocks_new_usage(self, db):
        pool = service.create_pool(db, code="TMP5", name="将停用", actor="pytest")
        db.commit()
        service.set_pool_status(db, pool.id, PoolStatus.DISABLED.value, actor="pytest")
        db.commit()
        with pytest.raises(AppError) as exc:
            service.assert_pool_usable(db, pool.id)
        assert exc.value.code == ErrorCode.POOL_DISABLED

    def test_pool_update_writes_audit(self, db):
        pool = service.create_pool(db, code="TMP6", name="审计池", actor="pytest")
        db.commit()
        service.update_pool(db, pool.id, actor="pytest", note="改备注")
        db.commit()
        rows = (
            db.query(AuditLog)
            .filter(AuditLog.entity_type == "Pool", AuditLog.entity_id == str(pool.id))
            .all()
        )
        actions = {row.action for row in rows}
        assert AuditAction.POOL_CREATE.value in actions
        assert AuditAction.POOL_UPDATE.value in actions


class TestOrderTypes:
    def test_new_business_needs_no_code_change(self, db):
        """V32/BAS-02-02：新增业务只是主数据一行。"""
        order_type = service.create_order_type(
            db, code="TB", name="同行代收", capital_type=CapitalType.PASS_THRU.value, actor="pytest"
        )
        db.commit()
        assert order_type.is_active is False, "启用前必须先配置资金路由"
        assert order_type.sequence_key == "ORDER_TB"
        assert order_type.sequence_prefix == "TB"

    def test_activate_without_route_is_blocked(self, db):
        order_type = service.create_order_type(
            db, code="TB", name="同行代收", capital_type=CapitalType.PASS_THRU.value, actor="pytest"
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


class TestRoutes:
    def test_default_routes_of_seeded_business(self, seeded_db):
        """V33：路由来自主数据，不在代码里写死。"""
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
        assert before_total == after_total, "同一业务同一份额只能有一条默认路由"
        assert service.resolve_default_pool(seeded_db, "HS", Portion.PRINCIPAL.value).code == "HJ_PROFIT"

    def test_route_to_disabled_pool_rejected(self, seeded_db):
        service.set_pool_status(
            seeded_db, service.get_pool_by_code(seeded_db, "HJ_PROFIT").id, PoolStatus.DISABLED.value, actor="pytest"
        )
        seeded_db.commit()
        with pytest.raises(AppError) as exc:
            service.set_route(
                seeded_db, order_type_code="HS", portion=Portion.PROFIT.value, pool_code="HJ_PROFIT", actor="pytest"
            )
        assert exc.value.code == ErrorCode.POOL_DISABLED
