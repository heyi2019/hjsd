"""MASTER-01 foundation 主数据契约测试（BAS-02 / BAS-03）。

与 test_foundation_service.py / test_pools_api.py / test_order_types_api.py 的分工：
既有文件已覆盖种子幂等、池 code 不可改、V17 有流水禁删、无路由不可启用、
路由 upsert 与停用池拒绝等主路径；本文件补池/业务类型的 404 与取值校验、
列表的启用过滤、更新池全字段、业务类型更新、路由 portion 校验、
停用池不可作为默认路由、编号域两个便捷函数、种子「业务类型缺失跳过路由」
与 `seed_is_applied`，以及 2 个未测路由端点。
"""
from __future__ import annotations

import pytest
from datetime import date
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.errors import NotFound, Validation
from app.domain.enums import CapitalType, PoolOwnership, PoolStatus, Portion
from app.domain.foundation import OrderTypeDef, OrderTypePool
from app.foundation import seeds, service
from app.orders.create import create_order


def _pool(seeded_db, code: str, **kwargs):
    return service.create_pool(seeded_db, code=code, name=f"池-{code}", actor="pytest", **kwargs)


class TestPoolGuards:
    def test_invalid_code_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_pool(seeded_db, code="!", name="坏码池", actor="pytest")
        assert "必须为" in str(exc.value)

    def test_non_string_code_is_rejected_as_business_error(self, seeded_db):
        with pytest.raises(Validation):
            service.create_pool(seeded_db, code=123, name="坏类型池", actor="pytest")

    def test_pool_type_cannot_be_blank(self, seeded_db):
        with pytest.raises(Validation, match="pool_type"):
            service.create_pool(
                seeded_db, code="TMPPT", name="空用途池", pool_type="   ", actor="pytest"
            )

    def test_pool_name_is_required(self, seeded_db):
        with pytest.raises(Validation):
            service.create_pool(seeded_db, code="TMPNAME", name="   ", actor="pytest")

    def test_pool_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            service.update_pool(seeded_db, 999999, actor="pytest", name="不存在")
        with pytest.raises(NotFound):
            service.set_pool_status(seeded_db, 999999, PoolStatus.ACTIVE.value, actor="pytest")

    def test_pool_code_lookup_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            service.require_pool_by_code(seeded_db, "NO_SUCH_POOL")

    def test_list_pools_excludes_disabled_when_requested(self, seeded_db):
        active = _pool(seeded_db, "TMPACT")
        disabled = _pool(seeded_db, "TMPDIS")
        service.set_pool_status(seeded_db, disabled.id, PoolStatus.DISABLED.value, actor="pytest")
        visible = [p.id for p in service.list_pools(seeded_db, include_disabled=False)]
        assert active.id in visible
        assert disabled.id not in visible
        # 不停用时两个种子池 + 本用例两个全可见
        assert len(service.list_pools(seeded_db)) == 4

    def test_update_pool_applies_all_optional_fields(self, seeded_db):
        pool = _pool(seeded_db, "TMPUPD")
        updated = service.update_pool(
            seeded_db, pool.id, actor="pytest", note="改备注",
            pool_type="PROFIT", ownership=PoolOwnership.CUSTODY.value,
        )
        assert updated.note == "改备注"
        assert updated.pool_type == "PROFIT"
        assert updated.ownership == PoolOwnership.CUSTODY.value
        with pytest.raises(Validation) as exc:
            service.update_pool(seeded_db, pool.id, actor="pytest", ownership="MARS")
        assert "ownership 取值非法" in str(exc.value)

    def test_update_pool_validates_all_fields_before_mutating(self, seeded_db):
        pool = _pool(seeded_db, "TMPATOMIC")

        with pytest.raises(Validation, match="ownership"):
            service.update_pool(
                seeded_db,
                pool.id,
                actor="operator",
                name="不应保存的新名称",
                ownership="INVALID",
            )

        seeded_db.commit()
        seeded_db.refresh(pool)
        assert pool.name == "池-TMPATOMIC"
        assert pool.updated_by == "pytest"

    def test_invalid_pool_status_rejected(self, seeded_db):
        pool = _pool(seeded_db, "TMPSTA")
        with pytest.raises(Validation) as exc:
            service.set_pool_status(seeded_db, pool.id, "BOGUS", actor="pytest")
        assert "资金池状态取值非法" in str(exc.value)

    def test_has_cashflow_returns_false_without_flows(self, seeded_db):
        # PG 下 cashflow 表恒存在；此处验证「该池无流水时返回 False」（delete_pool 据此放行）
        pool = _pool(seeded_db, "TMPCF")
        assert service._has_cashflow(seeded_db, pool.id) is False


class TestOrderTypeGuards:
    def test_active_flags_must_be_boolean_in_service(self, seeded_db):
        order_type = service.create_order_type(
            seeded_db,
            code="TBOOL",
            name="布尔状态校验",
            capital_type=CapitalType.STOCK.value,
            actor="pytest",
        )
        with pytest.raises(Validation, match="is_active 必须为布尔值"):
            service.set_order_type_active(
                seeded_db, order_type.id, "false", actor="pytest"
            )
        with pytest.raises(Validation, match="is_active 必须为布尔值"):
            service.set_route(
                seeded_db,
                order_type_code=order_type.code,
                portion=Portion.PRINCIPAL.value,
                pool_code="HJ_INVEST",
                is_active="false",
                actor="pytest",
            )

    def test_activation_requires_an_active_route_to_an_active_pool(self, seeded_db):
        order_type = service.create_order_type(
            seeded_db,
            code="TBR",
            name="路由状态校验",
            capital_type=CapitalType.STOCK.value,
            actor="pytest",
        )
        service.set_route(
            seeded_db,
            order_type_code=order_type.code,
            portion=Portion.PRINCIPAL.value,
            pool_code="HJ_INVEST",
            is_active=False,
            actor="pytest",
        )
        with pytest.raises(Validation, match="启用中的资金池路由"):
            service.set_order_type_active(seeded_db, order_type.id, True, actor="pytest")

    def test_order_type_name_and_prefix_are_validated(self, seeded_db):
        with pytest.raises(Validation):
            service.create_order_type(
                seeded_db,
                code="TBN",
                name="   ",
                capital_type=CapitalType.STOCK.value,
                actor="pytest",
            )
        with pytest.raises(Validation):
            service.create_order_type(
                seeded_db,
                code="TBP",
                name="同行代收",
                capital_type=CapitalType.STOCK.value,
                sequence_prefix="TB-",
                actor="pytest",
            )

    def test_negative_sort_order_rejected_on_create(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_order_type(
                seeded_db,
                code="TB",
                name="同行代收",
                capital_type=CapitalType.STOCK.value,
                sort_order=-1,
                actor="pytest",
            )
        assert "排序值不能为负数" in str(exc.value)

    def test_sort_order_must_be_an_integer(self, seeded_db):
        with pytest.raises(Validation, match="排序值必须为非负整数"):
            service.create_order_type(
                seeded_db,
                code="TBT",
                name="类型值校验",
                capital_type=CapitalType.STOCK.value,
                sort_order=True,
                actor="pytest",
            )

    def test_duplicate_sequence_prefix_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_order_type(
                seeded_db,
                code="TB",
                name="同行代收",
                capital_type=CapitalType.STOCK.value,
                sequence_prefix="HS",
                actor="pytest",
            )
        assert "编号前缀 HS 已存在" in str(exc.value)

    def test_negative_sort_order_rejected_on_update(self, seeded_db):
        definition = service.get_order_type_by_code(seeded_db, "DG")
        with pytest.raises(Validation) as exc:
            service.update_order_type(
                seeded_db, definition.id, actor="pytest", sort_order=-1
            )
        assert "排序值不能为负数" in str(exc.value)

    def test_database_rejects_negative_order_type_sort_order(self, seeded_db):
        with pytest.raises(IntegrityError):
            seeded_db.execute(
                OrderTypeDef.__table__.insert().values(
                    code="TB",
                    name="同行代收",
                    capital_type=CapitalType.STOCK.value,
                    sequence_prefix="TB",
                    sequence_key="ORDER_TB",
                    is_active=False,
                    sort_order=-1,
                    created_by="pytest",
                    updated_by="pytest",
                )
            )

    def test_database_rejects_duplicate_sequence_prefix(self, seeded_db):
        with pytest.raises(IntegrityError):
            seeded_db.execute(
                OrderTypeDef.__table__.insert().values(
                    code="TB",
                    name="同行代收",
                    capital_type=CapitalType.STOCK.value,
                    sequence_prefix="HS",
                    sequence_key="ORDER_TB",
                    is_active=False,
                    sort_order=0,
                    created_by="pytest",
                    updated_by="pytest",
                )
            )

    def test_order_type_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            service.update_order_type(seeded_db, 999999, actor="pytest", name="不存在")
        with pytest.raises(NotFound):
            service.set_order_type_active(seeded_db, 999999, False, actor="pytest")
        with pytest.raises(NotFound):
            service.require_order_type_by_code(seeded_db, "ZZ")

    def test_list_order_types_excludes_inactive_when_requested(self, seeded_db):
        codes = [item.code for item in service.list_order_types(seeded_db)]
        assert "HS" in codes
        definition = service.get_order_type_by_code(seeded_db, "HS")
        service.set_order_type_active(seeded_db, definition.id, False, actor="pytest")
        active = [item.code for item in service.list_order_types(seeded_db, include_inactive=False)]
        assert "HS" not in active
        assert "TH" in active

    def test_update_order_type_applies_fields(self, seeded_db):
        definition = service.get_order_type_by_code(seeded_db, "DG")
        updated = service.update_order_type(
            seeded_db, definition.id, actor="pytest", name="代挂改名",
            description="客户让我帮忙卖他的号", sort_order=99,
        )
        assert updated.name == "代挂改名"
        assert updated.description == "客户让我帮忙卖他的号"
        assert updated.sort_order == 99
        # code / capital_type 不随更新变动（BAS-02-03）
        assert updated.code == "DG"


class TestRouteGuards:
    def test_negative_priority_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.set_route(
                seeded_db,
                order_type_code="HS",
                portion=Portion.PRINCIPAL.value,
                pool_code="HJ_INVEST",
                priority=-1,
                actor="pytest",
            )
        assert "优先级不能为负数" in str(exc.value)

    def test_database_rejects_negative_route_priority(self, seeded_db):
        order_type = service.require_order_type_by_code(seeded_db, "HS")
        pool = service.require_pool_by_code(seeded_db, "HJ_INVEST")
        with pytest.raises(IntegrityError):
            seeded_db.execute(
                OrderTypePool.__table__.insert().values(
                    order_type_id=order_type.id,
                    pool_id=pool.id,
                    portion=Portion.GROSS.value,
                    priority=-1,
                    is_active=True,
                )
            )

    def test_invalid_portion_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.set_route(
                seeded_db, order_type_code="HS", portion="BOGUS",
                pool_code="HJ_INVEST", actor="pytest",
            )
        assert "portion 取值非法" in str(exc.value)

    def test_default_pool_resolved_for_seeded_route(self, seeded_db):
        pool = service.require_default_pool(seeded_db, "HS", "PRINCIPAL")
        assert pool.code == "HJ_INVEST"

    def test_disabled_pool_cannot_be_default_route(self, seeded_db):
        invest = service.require_pool_by_code(seeded_db, "HJ_INVEST")
        service.set_pool_status(seeded_db, invest.id, PoolStatus.DISABLED.value, actor="pytest")
        with pytest.raises(Validation) as exc:
            service.require_default_pool(seeded_db, "HS", "PRINCIPAL")
        assert "已停用" in str(exc.value)

    def test_unknown_order_type_route_returns_none(self, seeded_db):
        with pytest.raises(NotFound):
            service.resolve_default_pool(seeded_db, "ZZ", "PRINCIPAL")

    def test_invalid_portion_in_default_pool_lookup_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.resolve_default_pool(seeded_db, "HS", "BOGUS")
        assert "portion 取值非法" in str(exc.value)


class TestNumberingHelpers:
    def test_ensure_and_preview_order_no(self, seeded_db):
        definition = service.get_order_type_by_code(seeded_db, "HS")
        sequence = service.ensure_order_sequence(seeded_db, definition)
        assert sequence.sequence_key == definition.sequence_key
        assert service.preview_order_no(seeded_db, definition).startswith("HS")


class TestSeedGuards:
    def test_seed_skips_route_when_order_type_missing(self, db, monkeypatch):
        # 路由种子遇到不存在的业务类型时跳过而不是崩
        monkeypatch.setattr(
            seeds,
            "SEED_ROUTES",
            seeds.SEED_ROUTES + (("ZZ", "PRINCIPAL", "HJ_INVEST"),),
        )
        stats = seeds.seed_foundation(db, actor="pytest")
        db.commit()
        assert stats["pools_created"] == 2
        assert service.get_order_type_by_code(db, "ZZ") is None

    def test_seed_is_applied_true(self, seeded_db):
        assert seeds.seed_is_applied(seeded_db) is True

    def test_seed_is_applied_false_when_route_missing(self, seeded_db):
        # 池与业务类型齐全但缺一条种子路由 → 判定未落地（_all_seed_routes_ready 短路）
        route = seeded_db.scalars(select(OrderTypePool)).first()
        seeded_db.delete(route)
        seeded_db.flush()
        assert seeds.seed_is_applied(seeded_db) is False


class TestFoundationApi:
    def test_update_order_type_endpoint(self, seeded_client, seeded_db, headers):
        definition = service.get_order_type_by_code(seeded_db, "DG")
        response = seeded_client.patch(
            f"/api/v1/order-types/{definition.id}",
            json={"name": "代挂API", "description": "接口改名", "sort_order": 33},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["name"] == "代挂API"

    def test_sequences_endpoint_marks_exhausted(self, seeded_client, seeded_db, headers):
        """序列耗尽时 next_number 渲染为占位提示。

        设真实序列行到上限来触发分支，而不是 mock 路由层内部符号：
        这样断言的是对外行为，重构内部实现（如改为按已加载行直接格式化）不会误伤。
        """
        from app.core.numbering import MAX_SEQUENCE_VALUE
        from app.domain.foundation import DocumentSequence

        target = seeded_db.scalar(
            select(DocumentSequence).order_by(DocumentSequence.sequence_key)
        )
        target.current_value = MAX_SEQUENCE_VALUE
        seeded_db.commit()

        response = seeded_client.get("/api/v1/sequences", headers=headers)
        assert response.status_code == 200, response.text
        row = next(
            item for item in response.json() if item["sequence_key"] == target.sequence_key
        )
        assert row["next_number"] == f"<已达上限 {MAX_SEQUENCE_VALUE}>"

    def test_sequences_endpoint_five_digit_not_exhausted_at_9999(
        self, seeded_client, seeded_db, headers
    ):
        """5 位序列（ZC/SR/KU_）到 9999 时 next_number 应显示 10000，不误报上限。"""
        from app.domain.enums import SequenceKey
        from app.domain.foundation import DocumentSequence

        target = seeded_db.scalar(
            select(DocumentSequence).where(
                DocumentSequence.sequence_key == SequenceKey.CASHFLOW_OUT.value
            )
        )
        assert target.padding == 5
        target.current_value = 9999
        seeded_db.commit()

        response = seeded_client.get("/api/v1/sequences", headers=headers)
        assert response.status_code == 200, response.text
        row = next(
            item for item in response.json() if item["sequence_key"] == target.sequence_key
        )
        assert row["next_number"] == "ZC10000"

    def test_sequences_endpoint_five_digit_exhausted_text(
        self, seeded_client, seeded_db, headers
    ):
        """5 位序列真耗尽时占位文本写真实上限 99999（非硬编码 9999）。"""
        from app.core.numbering import sequence_max
        from app.domain.enums import SequenceKey
        from app.domain.foundation import DocumentSequence

        target = seeded_db.scalar(
            select(DocumentSequence).where(
                DocumentSequence.sequence_key == SequenceKey.STOCK_NO.value
            )
        )
        assert target.padding == 5
        target.current_value = sequence_max(target.padding)  # 99999
        seeded_db.commit()

        response = seeded_client.get("/api/v1/sequences", headers=headers)
        assert response.status_code == 200, response.text
        row = next(
            item for item in response.json() if item["sequence_key"] == target.sequence_key
        )
        assert row["next_number"] == "<已达上限 99999>"

    def test_route_impact_preview_does_not_change_history(
        self, seeded_client, seeded_db, headers
    ):
        create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest"
        )
        response = seeded_client.get(
            "/api/v1/order-types/HS/routes/impact-preview",
            params={
                "portion": "PRINCIPAL",
                "pool_code": "HJ_PROFIT",
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["changed"] is True
        assert payload["current_route"]["pool_code"] == "HJ_INVEST"
        assert payload["proposed_route"]["pool_code"] == "HJ_PROFIT"
        assert payload["historical_impact"]["order_count"] == 1
        assert payload["historical_impact"]["unchanged"] is True

    def test_update_pool_endpoint_applies_ownership_enum_to_value(
        self, seeded_client, seeded_db, headers
    ):
        pool = _pool(seeded_db, "TMPOWN")
        response = seeded_client.patch(
            f"/api/v1/pools/{pool.id}",
            json={"ownership": "CUSTODY"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["ownership"] == "CUSTODY"
