"""IMPORT-01 导入的映射口径与幂等测试（MIG-01 第 2/3 步）。

守护三件事：
1. **只导口径明确的类型**——返点/蹭点必须被跳过，且跳过理由可见（不静默漏导）。
2. **金额是并列份额，不是恒等式**——gross ≠ principal + profit 是源数据事实。
3. **幂等**——重跑不得翻倍（曾经真的翻过：order_no 唯一约束拦不住业务事实重复）。
"""

from __future__ import annotations

import importlib.util
from decimal import Decimal

import pytest
from sqlalchemy import func

from app.core.money import to_money
from app.domain.enums import ImportRowStatus, LinkStatus, Portion
from app.domain.trade import Order, OrderEvent
import _repo  # 仓库根解析：向上找 pytest.ini，避免写死 parents[N]


def _load_script():
    path = _repo.BACKEND_DIR / "scripts" / "map_import_to_entities.py"
    spec = importlib.util.spec_from_file_location("map_import_to_entities", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def mapper():
    return _load_script()


def _seed_order_rows(session, rows):
    """把订单原始行灌进 import_rows（复用真实落地链路）。"""
    from app.legacy_imports import service as import_service

    batch = import_service.create_batch(
        session,
        source_name="金山文档·订单",
        rows=rows,
        source_kind="STANDARD_ORDER",
        actor="pytest",
    )
    from app.legacy_imports.models import ImportRow

    # 测试会话是 autoflush=False（见 conftest「savepoint 挡不住 commit」的说明），
    # 所以必须显式 flush，否则被测代码的查询看不到刚落库的 ImportRow。
    session.flush()
    return (
        session.query(ImportRow)
        .filter_by(batch_id=batch["id"])
        .order_by(ImportRow.row_no)
        .all()
    )


class TestTypeGate:
    """只导口径明确的类型；不明确的必须跳过且理由可见。"""

    def test_map_covers_only_known_types(self, mapper):
        assert mapper.ORDER_TYPE_MAP == {
            "回收": "HS",
            "氪金联盟提号": "TH",
            "代挂": "DG",
            "蹭点": "DG",
        }
        # 「返点」绝不能出现在可导映射里——它该走 rebate_records，不是订单类型
        assert "返点" not in mapper.ORDER_TYPE_MAP

    def test_cengdian_maps_to_dg_per_prd(self, mapper):
        """PRD §术语等价表：蹭点 = 代挂的叫法，非独立业务。

        这是主理人 2026-10-04 的裁决——源数据把「蹭点」单列，
        实际是代挂的口语叫法。数据侧佐证：该单本金为 0，与代挂同形态。
        """
        assert mapper.ORDER_TYPE_MAP["蹭点"] == "DG"
        assert "蹭点" not in mapper.SKIP_TYPES

    def test_skipped_types_have_reasons(self, mapper):
        """跳过必须带原因——静默漏导是最难查的一类问题。"""
        assert set(mapper.SKIP_TYPES) == {"返点"}
        for name, reason in mapper.SKIP_TYPES.items():
            assert reason.strip(), f"{name} 的跳过理由不能为空"

    def test_only_known_types_produce_orders(self, mapper, seeded_db):
        _seed_order_rows(
            seeded_db,
            [
                {"订单类型": "回收", "日期": "2026-06-01", "本金": 1000, "利润": 200, "交易金额": 1200},
                {"订单类型": "返点", "日期": "2026-06-02", "本金": 0, "利润": 50, "交易金额": 50},
                {"订单类型": "蹭点", "日期": "2026-06-03", "本金": 0, "利润": 80, "交易金额": 8000},
            ],
        )
        report = mapper.map_orders(seeded_db, dry_run=False)
        # 回收 + 蹭点(→DG) = 2 单；返点被跳过
        assert report["orders"] == 2
        assert report["skipped_type"] == {"返点": 1}
        types = sorted(o.order_type for o in seeded_db.query(Order).all())
        assert types == ["DG", "HS"]

    def test_unparseable_date_is_skipped_not_crashed(self, mapper, seeded_db):
        _seed_order_rows(
            seeded_db,
            [
                {"订单类型": "回收", "日期": "不是日期", "本金": 1, "利润": 1, "交易金额": 2},
                {"订单类型": "回收", "日期": "2026-06-01", "本金": 1, "利润": 1, "交易金额": 2},
            ],
        )
        report = mapper.map_orders(seeded_db, dry_run=False)
        assert report["skipped_missing_date"] == 1
        assert report["orders"] == 1


class TestAmountSemantics:
    """金额是并列份额；gross ≠ principal + profit 是源数据事实。"""

    def test_three_portions_are_independent(self, mapper, seeded_db):
        """gross(1200) ≠ principal(1000) + profit(200) 也能正常落库。"""
        _seed_order_rows(
            seeded_db,
            [{"订单类型": "回收", "日期": "2026-06-01", "本金": 1000, "利润": 200, "交易金额": 1200}],
        )
        mapper.map_orders(seeded_db, dry_run=False)
        amounts = {
            e.portion: e.amount
            for e in seeded_db.query(OrderEvent).all()
        }
        assert amounts[Portion.PRINCIPAL.value] == to_money(Decimal("1000"))
        assert amounts[Portion.PROFIT.value] == to_money(Decimal("200"))
        assert amounts[Portion.GROSS.value] == to_money(Decimal("1200"))

    def test_zero_amount_creates_no_event(self, mapper, seeded_db):
        """本金为 0 的单不生成 PRINCIPAL 事件（零额事件无意义）。"""
        _seed_order_rows(
            seeded_db,
            [{"订单类型": "代挂", "日期": "2026-06-01", "本金": 0, "利润": 500, "交易金额": 500}],
        )
        report = mapper.map_orders(seeded_db, dry_run=False)
        portions = {e.portion for e in seeded_db.query(OrderEvent).all()}
        assert Portion.PRINCIPAL.value not in portions
        assert Portion.PROFIT.value in portions
        assert report["events"] == 2

    def test_no_float_in_amount_column(self, mapper, seeded_db):
        """金额必须走 Amount（Decimal），不能是 float。"""
        _seed_order_rows(
            seeded_db,
            [{"订单类型": "回收", "日期": "2026-06-01", "本金": 1234.56, "利润": 78.9, "交易金额": 1313.46}],
        )
        mapper.map_orders(seeded_db, dry_run=False)
        for event in seeded_db.query(OrderEvent).all():
            assert isinstance(event.amount, Decimal), f"{event.portion} 不是 Decimal"

    def test_rounding_keeps_two_decimals(self, mapper, seeded_db):
        """源数据有小数，落库后不得丢精度或变成浮点尾数。"""
        _seed_order_rows(
            seeded_db,
            [{"订单类型": "回收", "日期": "2026-06-01", "本金": 0.1, "利润": 0.2, "交易金额": 0.3}],
        )
        mapper.map_orders(seeded_db, dry_run=False)
        total = (
            seeded_db.query(func.sum(OrderEvent.amount))
            .filter(OrderEvent.portion == Portion.GROSS.value)
            .scalar()
        )
        assert total == to_money(Decimal("0.3"))


class TestIdempotency:
    """重跑不得翻倍。这条曾经真的破过。"""

    def test_rerun_does_not_duplicate(self, mapper, seeded_db):
        _seed_order_rows(
            seeded_db,
            [
                {"订单类型": "回收", "日期": "2026-06-01", "本金": 1000, "利润": 200, "交易金额": 1200},
                {"订单类型": "代挂", "日期": "2026-06-02", "本金": 0, "利润": 60, "交易金额": 60},
            ],
        )
        first = mapper.map_orders(seeded_db, dry_run=False)
        seeded_db.commit()
        assert first["orders"] == 2
        orders_after_first = seeded_db.query(Order).count()
        events_after_first = seeded_db.query(OrderEvent).count()

        second = mapper.map_orders(seeded_db, dry_run=False)
        seeded_db.commit()

        assert second["orders"] == 0
        assert second["skipped_already_mapped"] == 2
        assert seeded_db.query(Order).count() == orders_after_first
        assert seeded_db.query(OrderEvent).count() == events_after_first

    def test_third_run_still_stable(self, mapper, seeded_db):
        _seed_order_rows(
            seeded_db,
            [{"订单类型": "回收", "日期": "2026-06-01", "本金": 500, "利润": 100, "交易金额": 600}],
        )
        for _ in range(3):
            mapper.map_orders(seeded_db, dry_run=False)
            seeded_db.commit()
        assert seeded_db.query(Order).count() == 1
        assert seeded_db.query(OrderEvent).count() == 3

    def test_order_no_uniqueness_would_not_catch_duplication(self, mapper, seeded_db):
        """回归说明：唯一约束拦不住业务事实重复（编号是每轮新生成的）。

        这条测试存在的意义是提醒——幂等必须靠 status 判断，
        不能指望数据库唯一约束兜底。
        """
        _seed_order_rows(
            seeded_db,
            [{"订单类型": "回收", "日期": "2026-06-01", "本金": 100, "利润": 20, "交易金额": 120}],
        )
        mapper.map_orders(seeded_db, dry_run=False)
        seeded_db.commit()
        # 手工把 status 拨回 UNMAPPED，模拟「幂等判断被绕过」
        from app.legacy_imports.models import ImportRow

        seeded_db.query(ImportRow).update({"status": ImportRowStatus.UNMAPPED.value})
        seeded_db.commit()
        mapper.map_orders(seeded_db, dry_run=False)
        seeded_db.commit()

        # 编号是每轮新生成的，唯一约束放行 → 数据翻倍（这就是当初的 bug）
        assert seeded_db.query(Order).count() == 2
        numbers = [row.order_no for row in seeded_db.query(Order).all()]
        assert len(set(numbers)) == 2, "两轮生成的编号应当不同——正因如此，唯一约束拦不住"


class TestNoAutoMatch:
    """导入实体一律 UNLINKED，绝不自动关联。"""

    def test_orders_are_unlinked_with_null_account(self, mapper, seeded_db):
        _seed_order_rows(
            seeded_db,
            [{"订单类型": "回收", "日期": "2026-06-01", "本金": 1000, "利润": 200, "交易金额": 1200}],
        )
        mapper.map_orders(seeded_db, dry_run=False)
        order = seeded_db.query(Order).one()
        assert order.link_status == LinkStatus.UNLINKED.value
        assert order.account_id is None
        assert order.owner_id is None

    def test_events_not_posted(self, mapper, seeded_db):
        """导入事件默认未登记——池余额不受导入数据影响。"""
        _seed_order_rows(
            seeded_db,
            [{"订单类型": "回收", "日期": "2026-06-01", "本金": 1000, "利润": 200, "交易金额": 1200}],
        )
        mapper.map_orders(seeded_db, dry_run=False)
        for event in seeded_db.query(OrderEvent).all():
            assert event.is_posted is False

    def test_row_status_marked_mapped_with_basis(self, mapper, seeded_db):
        rows = _seed_order_rows(
            seeded_db,
            [{"订单类型": "氪金联盟提号", "日期": "2026-06-01", "本金": 100, "利润": 20, "交易金额": 120}],
        )
        mapper.map_orders(seeded_db, dry_run=False)
        row = rows[0]
        assert row.status == ImportRowStatus.MAPPED.value
        assert "ORDER_TYPE_MAP" in row.mapping_basis
        assert "氪金联盟提号" in row.mapping_basis
        assert row.mapping_basis is not None


class TestPoolRouting:
    def test_pool_map_matches_seeds(self, mapper):
        assert mapper.POOL_MAP == {
            "投资款荷包（本金）": "HJ_INVEST",
            "利润荷包（利润）": "HJ_PROFIT",
        }

    def test_principal_goes_to_invest_pool(self, mapper, seeded_db):
        from app.domain.foundation import Pool

        _seed_order_rows(
            seeded_db,
            [
                {
                    "订单类型": "回收",
                    "日期": "2026-06-01",
                    "本金": 1000,
                    "利润": 200,
                    "交易金额": 1200,
                    "回款账户（本金/利润）": ["投资款荷包（本金）", "利润荷包（利润）"],
                }
            ],
        )
        mapper.map_orders(seeded_db, dry_run=False)
        pools = {p.code: p.id for p in seeded_db.query(Pool).all()}
        for event in seeded_db.query(OrderEvent).all():
            if event.portion == Portion.PRINCIPAL.value:
                assert event.pool_id == pools["HJ_INVEST"]
            else:
                assert event.pool_id == pools["HJ_PROFIT"]

