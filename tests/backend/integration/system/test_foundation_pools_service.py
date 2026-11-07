"""MASTER-01 资金池主数据 Service：建池、停用、删除与审计。"""
from __future__ import annotations

import pytest

from app.core.errors import AppError, ErrorCode
from app.domain.enums import AuditAction, PoolOwnership, PoolStatus
from app.domain.foundation import AuditLog
from app.foundation import pools as pools_service
from app.foundation import service
from app.foundation.seeds import seed_foundation


class TestSeed:
    def test_seed_is_idempotent(self, db):
        first = seed_foundation(db, actor="pytest")
        db.commit()
        second = seed_foundation(db, actor="pytest")
        db.commit()

        assert first["pools_created"] == 2
        assert first["order_types_created"] == 3
        assert first["routes_created"] == 6
        assert second["pools_created"] == 0
        assert second["pools_skipped"] == 2
        assert second["order_types_created"] == 0
        assert second["order_types_skipped"] == 3

    def test_seeded_pools_and_order_types(self, seeded_db):
        invest = service.get_pool_by_code(seeded_db, "HJ_INVEST")
        profit = service.get_pool_by_code(seeded_db, "HJ_PROFIT")
        assert invest is not None and profit is not None
        assert invest.ownership == PoolOwnership.OWNED.value
        assert invest.pool_type == "INVEST"
        assert profit.pool_type == "PROFIT"

        expected = {
        "HS": 1,
        "TH": 2,
        "DG": 3,
        }
        codes = {item.code: item for item in service.list_order_types(seeded_db)}
        for code, _ in expected.items():
            assert codes[code].id > 0
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
        assert pool.code == "HJ_CUSTODY"
        assert pool.status == PoolStatus.ACTIVE.value

        with pytest.raises(AppError) as exc:
            service.create_pool(db, code="HJ_CUSTODY", name="重复", actor="pytest")
        assert exc.value.code == ErrorCode.DUPLICATE_CODE

    def test_pool_code_is_immutable(self, db):
        pool = service.create_pool(db, code="TMP1", name="临时池", actor="pytest")
        db.commit()
        updated = service.update_pool(db, pool.id, actor="pytest", name="临时池改名")
        assert updated.code == "TMP1"
        assert updated.name == "临时池改名"

    def test_invalid_ownership_rejected(self, db):
        with pytest.raises(AppError):
            service.create_pool(db, code="TMP2", name="坏池", actor="pytest", ownership="MARS")

    def test_delete_blocked_when_pool_has_cashflow(self, db, monkeypatch):
        pool = service.create_pool(db, code="TMP3", name="带流水池", actor="pytest")
        db.commit()
        monkeypatch.setattr(pools_service, "_has_cashflow", lambda session, pool_id: True)
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

    def test_update_pool_applies_extra_values(self, db, monkeypatch):
        """覆盖 update_pool 的 extra_values 分支（pools.py:114）。"""
        pool = service.create_pool(db, code="TMPEV", name="活字段池", actor="pytest")
        db.commit()
        captured: dict = {}

        def _spy(session, *, entity_type, entity_id, values, require_all=False):
            captured["entity_type"] = entity_type
            captured["entity_id"] = entity_id
            captured["values"] = dict(values)
            return {}

        monkeypatch.setattr(pools_service.parties_service, "set_extra_values", _spy)
        updated = service.update_pool(
            db, pool.id, actor="pytest", extra_values={"game": "王者"}
        )
        assert updated.name == "活字段池"
        assert captured["entity_type"] == "pool"
        assert captured["entity_id"] == pool.id
        assert captured["values"] == {"game": "王者"}

    def test_assert_pool_usable_returns_active_pool(self, db):
        """覆盖 assert_pool_usable 的成功返回路径（pools.py:189）。"""
        pool = service.create_pool(db, code="TMPAU", name="可用池", actor="pytest")
        db.commit()
        result = service.assert_pool_usable(db, pool.id)
        assert result.id == pool.id
        assert result.status == PoolStatus.ACTIVE.value
