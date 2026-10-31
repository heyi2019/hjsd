"""M4：R1-R5 报表 / 审计查询 / P2 导入。

功能编号：RPT-01-01~06、MIG-01-01~08、BAS-05-03
"""
from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy.exc import IntegrityError

from app.stocks import service as stocks_service
from app.domain.enums import ImportRowStatus
from app.domain.imports import ImportBatch, ImportRow
from app.imports import service as import_service
from app.orders import service as order_service
from app.reporting import service as reporting_service

REPORTS = "/api/v1/reports"


# --------------------------------------------------------------------- 报表
class TestReports:
    def test_r1_excludes_th_and_zero_cost(self, seeded_db):
        data = reporting_service.r1_inventory_health(seeded_db)
        for item in data["items"]:
            assert item["status"] == "IN_STOCK"

    def test_r2_operating_expense_excludes_account_cost(self, seeded_db):
        """账号 COST 只能进直接成本，不能进运营费用（R2 验收口径）。"""
        from datetime import date

        account = stocks_service.create_account(
            seeded_db,
            game_account="m4-r2-account",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        order = order_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=date(2026, 10, 4),
            actor="pytest",
            account_id=account.id,
        )
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="1000.00",
            occurred_on=date(2026, 10, 4),
            actor="pytest",
        )
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="COST",
            amount="300.00",
            occurred_on=date(2026, 10, 4),
            actor="pytest",
        )
        data = reporting_service.r2_monthly_pnl(seeded_db)
        month = [i for i in data["items"] if i["month"] == "2026-10"]
        assert month
        assert month[0]["account_direct_cost"] == 1300
        assert month[0]["operating_expense"] == 0

    def test_r5_uncollected_rebate_is_separate_column(self, seeded_db):
        data = reporting_service.r5_business_pnl(seeded_db)
        for item in data["items"]:
            assert "uncollected_rebate" in item
            # 完整收益只加已结算返点，不摊未归集
            assert item["full_income"] == item["main_profit"] + item["settled_rebate"]

    def test_daily_funds_matches_pool_balance(self, seeded_db):
        from datetime import date

        report = reporting_service.daily_funds_report(seeded_db, on=date(2026, 10, 4))
        assert report["items"]
        for item in report["items"]:
            assert "available" in item and "th_advance" not in item
        assert report["total"]["available"] == sum(item["available"] for item in report["items"])

    def test_order_profit_totals_are_consistent(self, seeded_db):
        data = reporting_service.order_profit_detail(seeded_db)
        for item in data["items"]:
            assert item["net_profit"] == (
                item["income"] - item["buy_amount"] - item["direct_cost"] + item["rebate"]
            )

    def test_r3_drills_down_to_orders(self, seeded_db):
        data = reporting_service.r3_commission_reconciliation(seeded_db)
        for person in data["groups"]:
            assert person["orders"]
            assert sum(o["profit_base"] for o in person["orders"]) == person["profit_base"]
        assert data["total"]["order_count"] == len(data["items"])


# --------------------------------------------------------------------- 导入
class TestImport:
    def test_import_rows_have_unique_positive_row_numbers_in_database(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="rows.xlsx", rows=[{"value": 1}], actor="pytest"
        )
        seeded_db.add(
            ImportRow(
                batch_id=batch["id"],
                row_no=1,
                raw={"duplicate": True},
                status=ImportRowStatus.UNMAPPED.value,
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

        batch = import_service.create_batch(
            seeded_db, source_name="rows-2.xlsx", rows=[{"value": 1}], actor="pytest"
        )
        seeded_db.add(
            ImportRow(
                batch_id=batch["id"],
                row_no=0,
                raw={"invalid": True},
                status=ImportRowStatus.UNMAPPED.value,
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_no_auto_matching_on_create(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db,
            source_name="source-orders.xlsx",
            rows=[{"order_no": "OLD-1", "amount": "100"}, {"order_no": "OLD-2"}],
            actor="pytest",
        )
        assert batch["unmapped_count"] == 2
        rows = import_service.list_rows(seeded_db, batch["id"])
        assert all(r["mapped_order_id"] is None for r in rows)
        assert all(r["status"] == ImportRowStatus.UNMAPPED.value for r in rows)

    def test_manual_mapping_then_commit(self, seeded_db):
        from datetime import date

        order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest"
        )
        batch = import_service.create_batch(
            seeded_db, source_name="source.xlsx", rows=[{"order_no": "OLD-9"}], actor="pytest"
        )
        row = import_service.list_rows(seeded_db, batch["id"])[0]
        mapped = import_service.assign_mapping(
            seeded_db, row["id"], order_id=order.id, basis="对账单第 9 行", actor="pytest"
        )
        assert mapped["status"] == ImportRowStatus.MAPPED.value

        committed = import_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        assert committed["imported"] == 1
        assert committed["unmapped"] == 0

    def test_unmapped_rows_stay_unmapped_not_business_data(self, seeded_db):
        from sqlalchemy import select

        from app.domain.trade import Cashflow, OrderEvent

        before_flows = len(seeded_db.scalars(select(Cashflow)).all())
        before_events = len(seeded_db.scalars(select(OrderEvent)).all())

        batch = import_service.create_batch(
            seeded_db, source_name="source.xlsx", rows=[{"x": 1}, {"y": 2}], actor="pytest"
        )
        committed = import_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        assert committed["unmapped"] == 2

        # 红线：导入不写任何业务数据，不补造划转
        assert len(seeded_db.scalars(select(Cashflow)).all()) == before_flows
        assert len(seeded_db.scalars(select(OrderEvent)).all()) == before_events

        # 未映射行保持 UNMAPPED 并在 issue_note 留痕，可见但不阻塞新业务
        rows = import_service.list_rows(seeded_db, batch["id"])
        assert all(r["status"] == ImportRowStatus.UNMAPPED.value for r in rows)
        assert all(r["issue_note"] for r in rows)

    def test_commit_is_not_repeatable(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="source.xlsx", rows=[{"x": 1}], actor="pytest"
        )
        import_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        with pytest.raises(Exception):
            import_service.commit_batch(seeded_db, batch["id"], actor="pytest")


# --------------------------------------------------------------------- API 层
class TestM4Api:
    def test_reports_endpoints_require_permission(self, seeded_client, viewer_headers):
        for path in (
            "/reports/inventory-health",
            "/reports/monthly-pnl",
            "/reports/business-pnl",
            "/reports/commission",
            "/reports/daily-funds",
            "/reports/order-profit",
        ):
            response = seeded_client.get(f"{REPORTS}{path[8:]}", headers=viewer_headers)
            assert response.status_code in (200, 403), path

    def test_audit_logs_endpoint(self, seeded_client, headers):
        response = seeded_client.get("/api/v1/audit-logs", headers=headers)
        assert response.status_code == 200
        assert "items" in response.json()

    def test_import_endpoints(self, seeded_client, headers):
        created = seeded_client.post(
            "/api/v1/imports/batches",
            json={"source_name": "api-import.xlsx", "rows": [{"a": 1}]},
            headers=headers,
        )
        assert created.status_code == 200
        batch_id = created.json()["id"]
        assert seeded_client.get(f"/api/v1/imports/batches/{batch_id}/rows", headers=headers).status_code == 200
        assert (
            seeded_client.post(
                f"/api/v1/imports/batches/{batch_id}/commit", headers=headers
            ).status_code
            == 200
        )


class TestImportClosure:
    """MIG-01 补齐验收：预览 / 对账 / 回滚 / 更正 / 补录依据 / UNLINKED 标记。

    红线复验：全流程**不得写入任何 cashflow**，导入行只作参考。
    """

    @staticmethod
    def _source_rows() -> list[dict[str, object]]:
        """按 rawdata/源表结构造行（sheet9_orders 字段名）。"""
        return [
            {"日期": "2026/07/14", "交易金额": 13888, "利润": 429, "订单类型": "代挂", "本金": 0},
            {"日期": "2026/07/15", "交易金额": 20000, "利润": 1200, "订单类型": "回收", "本金": 18800},
            {"日期": "2026/07/16", "交易金额": 5000, "利润": 300, "订单类型": "回收", "本金": 4700},
        ]

    # ── MIG-01-02 字段映射预览 ──
    def test_preview_reports_columns_samples_and_missing(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._source_rows(), actor="pytest"
        )
        preview = import_service.preview_mapping(seeded_db, batch["id"])
        assert preview["total_rows"] == 3
        cols = {c["source_column"]: c for c in preview["columns"]}
        assert cols["交易金额"]["target_field"] == "gross_amount"
        assert cols["利润"]["target_field"] == "profit"
        assert cols["交易金额"]["fill_rate"] == 100.0
        assert cols["交易金额"]["samples"]
        # 「日期」在源数据里存在但不在建议字典 → 计入 blockers（需人工确认）
        assert preview["blockers"] is not None

    def test_preview_does_not_persist_anything(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._source_rows(), actor="pytest"
        )
        before = len(import_service.list_rows(seeded_db, batch["id"]))
        import_service.preview_mapping(seeded_db, batch["id"])
        after = import_service.list_rows(seeded_db, batch["id"])
        assert len(after) == before
        assert all(r["status"] == ImportRowStatus.UNMAPPED.value for r in after)

    def test_preview_empty_batch(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="empty.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        preview = import_service.preview_mapping(seeded_db, batch["id"])
        assert preview["total_rows"] == 1

    # ── MIG-01-04 导入对账报告 ──
    def test_reconciliation_counts_and_amounts(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._source_rows(), actor="pytest"
        )
        report = import_service.reconciliation_report(seeded_db, batch["id"])
        assert report["rows"]["source_total"] == 3
        assert report["amounts"]["before"]["交易金额"] == "38888.00"
        assert report["amounts"]["before"]["利润"] == "1929.00"
        # 迁移前总额 vs 仅映射行的差额
        assert report["requires_adjudication"] is True

    def test_reconciliation_writes_no_cashflow(self, seeded_db):
        from app.domain.trade import Cashflow

        batch = import_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._source_rows(), actor="pytest"
        )
        before = seeded_db.query(Cashflow).count()
        import_service.reconciliation_report(seeded_db, batch["id"])
        import_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        assert seeded_db.query(Cashflow).count() == before, "导入绝不能写现金流"

    def test_reconciliation_does_not_scan_unrelated_source_notes(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=[{"交易金额": 100}], actor="pytest"
        )
        account = stocks_service.create_account(
            seeded_db,
            game_account="m4-unrelated-source-note",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        order = order_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=date(2026, 10, 4),
            actor="pytest",
            account_id=account.id,
        )
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="100",
            occurred_on=date(2026, 10, 4),
            actor="pytest",
            note="源订单说明，但不属于导入批次",
        )

        report = import_service.reconciliation_report(seeded_db, batch["id"])

        assert report["funds"]["linked_event_cashflow"] == 0

    # ── MIG-01-05 补录依据必填 + 前后状态留存 ──
    def test_mapping_requires_basis(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._source_rows(), actor="pytest"
        )
        row = import_service.list_rows(seeded_db, batch["id"])[0]
        with pytest.raises(Exception):
            import_service.assign_mapping(seeded_db, row["id"], basis="  ", actor="pytest")

    def test_mapping_keeps_before_snapshot(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._source_rows(), actor="pytest"
        )
        row = import_service.list_rows(seeded_db, batch["id"])[0]
        mapped = import_service.assign_mapping(
            seeded_db, row["id"], account_id=None, order_id=None, basis="无", actor="pytest"
        )
        # 首次指派留存前态：原始状态是 UNMAPPED
        assert mapped["mapped_before"]["status"] == ImportRowStatus.UNMAPPED.value
        assert mapped["mapping_basis"] == "无"

    # ── MIG-01-06 UNLINKED_TRANSFER 标记 ──
    def test_mark_unlinked_without_pairing(self, seeded_db):
        from app.domain.trade import Cashflow

        batch = import_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._source_rows(), actor="pytest"
        )
        row = import_service.list_rows(seeded_db, batch["id"])[0]
        flows_before = seeded_db.query(Cashflow).count()
        marked = import_service.mark_unlinked_transfer(seeded_db, row["id"], actor="pytest")
        assert marked["unlinked_transfer"] is True
        # 关键红线：打了标记但绝不能凭空补出配对流水
        assert seeded_db.query(Cashflow).count() == flows_before
        # 留痕落在行上，可见但不生成任何配对数据
        assert marked["issue_note"]

    def test_mark_unlinked_is_idempotent(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._source_rows(), actor="pytest"
        )
        row = import_service.list_rows(seeded_db, batch["id"])[0]
        first = import_service.mark_unlinked_transfer(seeded_db, row["id"], actor="pytest")
        second = import_service.mark_unlinked_transfer(seeded_db, row["id"], actor="pytest")
        assert first["issue_note"] == second["issue_note"], "重复标记不得改写留痕"

    # ── MIG-01-07 回滚 ──
    def test_rollback_draft_batch(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._source_rows(), actor="pytest"
        )
        rolled = import_service.rollback_batch(
            seeded_db, batch["id"], reason="源文件有误", actor="pytest"
        )
        assert rolled["status"] == "ROLLED_BACK"
        assert rolled["rolled_back_by"] == "pytest"
        assert rolled["rolled_back_at"] is not None
        rows = import_service.list_rows(seeded_db, batch["id"])
        assert all(r["status"] == ImportRowStatus.ROLLED_BACK.value for r in rows)

    def test_rollback_keeps_raw_data(self, seeded_db):
        """回滚不得删除原始行内容（只读保护 + 可追溯）。"""
        batch = import_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._source_rows(), actor="pytest"
        )
        import_service.rollback_batch(seeded_db, batch["id"], reason="x", actor="pytest")
        rows = import_service.list_rows(seeded_db, batch["id"])
        assert len(rows) == 3
        assert rows[0]["raw"]["交易金额"] == 13888

    def test_rollback_requires_reason(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        with pytest.raises(Exception):
            import_service.rollback_batch(seeded_db, batch["id"], reason="", actor="pytest")

    def test_committed_batch_cannot_rollback(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        import_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        with pytest.raises(Exception):
            import_service.rollback_batch(seeded_db, batch["id"], reason="x", actor="pytest")

    def test_rollback_twice_is_rejected(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        import_service.rollback_batch(seeded_db, batch["id"], reason="x", actor="pytest")
        with pytest.raises(Exception):
            import_service.rollback_batch(seeded_db, batch["id"], reason="y", actor="pytest")

    # ── MIG-01-08 更正批次 ──
    def test_correction_batch_links_to_origin(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=self._source_rows(), actor="pytest"
        )
        import_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        correction = import_service.create_correction_batch(
            seeded_db,
            batch["id"],
            rows=[{"日期": "2026/07/14", "交易金额": 13888, "利润": 400}],
            reason="利润算错 29 元",
            actor="pytest",
        )
        assert correction["corrects_batch_id"] == batch["id"]
        assert correction["status"] == "DRAFT"

    def test_correction_does_not_touch_origin_rows(self, seeded_db):
        """只读保护：更正批次不得改动原批次的原始行。"""
        batch = import_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=self._source_rows(), actor="pytest"
        )
        import_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        origin_rows_before = import_service.list_rows(seeded_db, batch["id"])
        import_service.create_correction_batch(
            seeded_db,
            batch["id"],
            rows=[{"交易金额": 1}],
            reason="更正",
            actor="pytest",
        )
        assert import_service.list_rows(seeded_db, batch["id"]) == origin_rows_before

    def test_correction_requires_reason_and_rows(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        import_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        with pytest.raises(Exception):
            import_service.create_correction_batch(
                seeded_db, batch["id"], rows=[{"a": 1}], reason="", actor="pytest"
            )
        with pytest.raises(Exception):
            import_service.create_correction_batch(
                seeded_db, batch["id"], rows=[], reason="r", actor="pytest"
            )

    def test_rolled_back_batch_cannot_be_corrected(self, seeded_db):
        batch = import_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        import_service.rollback_batch(seeded_db, batch["id"], reason="x", actor="pytest")
        with pytest.raises(Exception):
            import_service.create_correction_batch(
                seeded_db, batch["id"], rows=[{"a": 2}], reason="r", actor="pytest"
            )


class TestEnumConstraintDrift:
    """防回归：模型枚举与数据库 CHECK 约束必须一致。

    实测踩过：给枚举加了新值但没重建对应表，插入时 sqlite3.IntegrityError
    （CHECK constraint failed），而 `alembic check` 是「No new upgrade
    operations detected」——它不校验 CHECK 内容。
    """

    def test_every_batch_status_passes_db_check(self, seeded_db):
        from app.domain.enums import ImportBatchStatus

        for status in ImportBatchStatus:
            batch = ImportBatch(
                batch_no=f"CHK{status.value[:8]}",
                source_name="probe.xlsx",
                status=status.value,
                row_count=0,
                unmapped_count=0,
            )
            seeded_db.add(batch)
            try:
                seeded_db.flush()
            except Exception as exc:  # noqa: BLE001
                pytest.fail(f"批次状态 {status.value} 被 CHECK 拒绝：{exc}")
        seeded_db.rollback()

    def test_every_row_status_passes_db_check(self, seeded_db):
        from app.domain.enums import ImportRowStatus

        batch = import_service.create_batch(
            seeded_db, source_name="probe.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        for row_no, status in enumerate(ImportRowStatus, start=2):
            row = ImportRow(
                batch_id=batch["id"],
                row_no=row_no,
                raw={"a": 1},
                status=status.value,
            )
            seeded_db.add(row)
            try:
                seeded_db.flush()
            except Exception as exc:  # noqa: BLE001
                pytest.fail(f"行状态 {status.value} 被 CHECK 拒绝：{exc}")
            seeded_db.expunge(row)
        seeded_db.rollback()
