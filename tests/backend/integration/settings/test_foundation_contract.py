"""MASTER-01 foundation 主数据契约测试（BAS-02 / BAS-03）。

覆盖资金账户和业务类型的字段校验、状态筛选、更新、编号序列及相关接口。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.errors import NotFound, Validation
from app.domain.enums import PoolStatus
from app.domain.foundation import OrderTypeDef
from app.settings.field_definitions import seeds
from app.settings.field_definitions.order_types import (
    create_order_type,
    get_order_type_by_code,
    list_order_types,
    require_order_type_by_code,
    set_order_type_active,
    update_order_type,
)
from app.settings.field_definitions.pools import (
    _has_cashflow,
    create_pool,
    list_pools,
    set_pool_status,
    update_pool,
)
from app.shared.numbering import ensure_sequence, peek_number


def _pool(seeded_db, code: str, **kwargs):
    return create_pool(seeded_db, code=code, name=f"池-{code}", actor="pytest", **kwargs)


class TestPoolGuards:
    def test_invalid_code_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            create_pool(seeded_db, code="!", name="坏码池", actor="pytest")
        assert "必须为" in str(exc.value)

    def test_non_string_code_is_rejected_as_business_error(self, seeded_db):
        with pytest.raises(Validation):
            create_pool(seeded_db, code=123, name="坏类型池", actor="pytest")

    def test_pool_type_cannot_be_blank(self, seeded_db):
        with pytest.raises(Validation, match="pool_type"):
            create_pool(
                seeded_db, code="TMPPT", name="空用途池", pool_type="   ", actor="pytest"
            )

    def test_pool_name_is_required(self, seeded_db):
        with pytest.raises(Validation):
            create_pool(seeded_db, code="TMPNAME", name="   ", actor="pytest")

    def test_pool_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            update_pool(seeded_db, 999999, actor="pytest", name="不存在")
        with pytest.raises(NotFound):
            set_pool_status(seeded_db, 999999, PoolStatus.ACTIVE.value, actor="pytest")

    def test_list_pools_excludes_disabled_when_requested(self, seeded_db):
        active = _pool(seeded_db, "TMPACT")
        disabled = _pool(seeded_db, "TMPDIS")
        set_pool_status(seeded_db, disabled.id, PoolStatus.DISABLED.value, actor="pytest")
        visible = [p.id for p in list_pools(seeded_db, include_disabled=False)]
        assert active.id in visible
        assert disabled.id not in visible
        # 不停用时两个种子池 + 本用例两个全可见
        assert len(list_pools(seeded_db)) == 4

    def test_update_pool_applies_all_optional_fields(self, seeded_db):
        pool = _pool(seeded_db, "TMPUPD")
        updated = update_pool(
            seeded_db, pool.id, actor="pytest", note="改备注",
            pool_type="PROFIT",
        )
        assert updated.note == "改备注"
        assert updated.pool_type == "PROFIT"

    def test_update_pool_validates_all_fields_before_mutating(self, seeded_db):
        pool = _pool(seeded_db, "TMPATOMIC")

        with pytest.raises(Validation, match="pool_type 不能为空"):
            update_pool(
                seeded_db,
                pool.id,
                actor="operator",
                name="不应保存的新名称",
                pool_type="",
            )

        seeded_db.commit()
        seeded_db.refresh(pool)
        assert pool.name == "池-TMPATOMIC"
        assert pool.updated_by == "pytest"

    def test_invalid_pool_status_rejected(self, seeded_db):
        pool = _pool(seeded_db, "TMPSTA")
        with pytest.raises(Validation) as exc:
            set_pool_status(seeded_db, pool.id, "BOGUS", actor="pytest")
        assert "资金账户状态取值非法" in str(exc.value)

    def test_has_cashflow_returns_false_without_flows(self, seeded_db):
        # PG 下 cashflow 表恒存在；此处验证「该池无流水时返回 False」（delete_pool 据此放行）
        pool = _pool(seeded_db, "TMPCF")
        assert _has_cashflow(seeded_db, pool.id) is False


class TestOrderTypeGuards:
    def test_active_flags_must_be_boolean_in_service(self, seeded_db):
        order_type = create_order_type(
            seeded_db,
            code="TBOOL",
            name="布尔状态校验",
            actor="pytest",
        )
        with pytest.raises(Validation, match="is_active 必须为布尔值"):
            set_order_type_active(
                seeded_db, order_type.id, "false", actor="pytest"
            )

    def test_order_type_name_and_prefix_are_validated(self, seeded_db):
        with pytest.raises(Validation):
            create_order_type(
                seeded_db,
                code="TBN",
                name="   ",
                    actor="pytest",
            )
        with pytest.raises(Validation):
            create_order_type(
                seeded_db,
                code="TBP",
                name="同行代收",
                    sequence_prefix="TB-",
                actor="pytest",
            )

    def test_negative_sort_order_rejected_on_create(self, seeded_db):
        with pytest.raises(Validation) as exc:
            create_order_type(
                seeded_db,
                code="TB",
                name="同行代收",
                    sort_order=-1,
                actor="pytest",
            )
        assert "排序值不能为负数" in str(exc.value)

    def test_sort_order_must_be_an_integer(self, seeded_db):
        with pytest.raises(Validation, match="排序值必须为非负整数"):
            create_order_type(
                seeded_db,
                code="TBT",
                name="类型值校验",
                    sort_order=True,
                actor="pytest",
            )

    def test_duplicate_sequence_prefix_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            create_order_type(
                seeded_db,
                code="TB",
                name="同行代收",
                    sequence_prefix="HS",
                actor="pytest",
            )
        assert "编号前缀 HS 已存在" in str(exc.value)

    def test_negative_sort_order_rejected_on_update(self, seeded_db):
        definition = get_order_type_by_code(seeded_db, "DG")
        with pytest.raises(Validation) as exc:
            update_order_type(
                seeded_db, definition.id, actor="pytest", sort_order=-1
            )
        assert "排序值不能为负数" in str(exc.value)

    def test_database_rejects_negative_order_type_sort_order(self, seeded_db):
        with pytest.raises(IntegrityError):
            seeded_db.execute(
                OrderTypeDef.__table__.insert().values(
                    code="TB",
                    name="同行代收",
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
            update_order_type(seeded_db, 999999, actor="pytest", name="不存在")
        with pytest.raises(NotFound):
            set_order_type_active(seeded_db, 999999, False, actor="pytest")
        with pytest.raises(NotFound):
            require_order_type_by_code(seeded_db, "ZZ")

    def test_list_order_types_excludes_inactive_when_requested(self, seeded_db):
        codes = [item.code for item in list_order_types(seeded_db)]
        assert "HS" in codes
        definition = get_order_type_by_code(seeded_db, "HS")
        set_order_type_active(seeded_db, definition.id, False, actor="pytest")
        active = [item.code for item in list_order_types(seeded_db, include_inactive=False)]
        assert "HS" not in active
        assert "TH" in active

    def test_update_order_type_applies_fields(self, seeded_db):
        definition = get_order_type_by_code(seeded_db, "DG")
        updated = update_order_type(
            seeded_db, definition.id, actor="pytest", name="代挂改名",
            description="客户让我帮忙卖他的号", sort_order=99,
        )
        assert updated.name == "代挂改名"
        assert updated.description == "客户让我帮忙卖他的号"
        assert updated.sort_order == 99
        # code 与编号前缀不随更新变动（BAS-02-03）
        assert updated.code == "DG"


class TestNumberingHelpers:
    def test_ensure_and_preview_order_no(self, seeded_db):
        definition = get_order_type_by_code(seeded_db, "HS")
        sequence = ensure_sequence(seeded_db, definition.sequence_key, definition.sequence_prefix, 4)
        assert sequence.sequence_key == definition.sequence_key
        assert peek_number(seeded_db, definition.sequence_key).startswith("HS")


class TestSeedGuards:
    def test_seed_is_applied_true(self, seeded_db):
        assert seeds.seed_is_applied(seeded_db) is True



class TestFoundationApi:
    def test_update_order_type_endpoint(self, seeded_client, seeded_db, headers):
        definition = get_order_type_by_code(seeded_db, "DG")
        response = seeded_client.patch(
            f"/api/order-types/{definition.id}",
            json={"name": "代挂API", "description": "接口改名", "sort_order": 33},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["name"] == "代挂API"

    def test_sequences_endpoint_expands_at_padding_boundary(self, seeded_client, seeded_db, headers):
        from app.domain.foundation import DocumentSequence
        target = seeded_db.scalar(select(DocumentSequence).order_by(DocumentSequence.sequence_key))
        target.current_value = 10 ** target.padding - 1
        seeded_db.commit()
        response = seeded_client.get("/api/sequences", headers=headers)
        assert response.status_code == 200, response.text
        row = next(item for item in response.json() if item["sequence_key"] == target.sequence_key)
        assert row["next_number"] == f"{target.prefix}{10 ** target.padding}"

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

        response = seeded_client.get("/api/sequences", headers=headers)
        assert response.status_code == 200, response.text
        row = next(
            item for item in response.json() if item["sequence_key"] == target.sequence_key
        )
        assert row["next_number"] == "ZC10000"

    def test_sequences_endpoint_five_digit_expands(
        self, seeded_client, seeded_db, headers
    ):
        """5 位序列达到 99999 后预览自动增位。"""
        from app.domain.enums import SequenceKey
        from app.domain.foundation import DocumentSequence

        target = seeded_db.scalar(
            select(DocumentSequence).where(
                DocumentSequence.sequence_key == SequenceKey.STOCK_NO.value
            )
        )
        assert target.padding == 5
        target.current_value = 99999
        seeded_db.commit()

        response = seeded_client.get("/api/sequences", headers=headers)
        assert response.status_code == 200, response.text
        row = next(
            item for item in response.json() if item["sequence_key"] == target.sequence_key
        )
        assert row["next_number"] == "KU_100000"

