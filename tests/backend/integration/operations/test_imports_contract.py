"""IMPORT-01 导入契约测试（MIG-01 守卫分支）。

与 test_import_lifecycle.py / test_import_mapping.py / test_import_landing.py 的分工：
既有文件已覆盖建批、映射依据必填、前态留存、提交转未映射留痕、
预览/对账主路径、回滚与更正主路径；本文件补各函数的 NotFound/空入参守卫、
`list_batches`、跳过行、提交时 SKIPPED 跳过、
预览空批次/空值计数、对账金额解析的两个容错分支，以及 8 个未测路由端点。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
from app.domain.enums import AuditAction, ImportBatchStatus, ImportRowStatus, ImportSourceKind
from app.domain.foundation import AuditLog
from app.domain.imports import ImportBatch, ImportRow
from app.imports import _shared as imp__shared
from app.imports import batches as imp_batches
from app.imports import rows as imp_rows

ROWS = [
    {"日期": "2026/07/14", "交易金额": 13888, "利润": 429, "订单类型": "代挂", "本金": 0},
    {"日期": "2026/07/15", "交易金额": 20000, "利润": 1200, "订单类型": "回收", "本金": 18800},
]


def _batch(seeded_db, rows=None, source_name="orders.xlsx"):
    return imp_batches.create_batch(
        seeded_db, source_name=source_name, rows=rows if rows is not None else ROWS,
        actor="pytest",
    )


def _first_row_id(seeded_db, batch_id: int) -> int:
    return imp_rows.list_rows(seeded_db, batch_id)[0]["id"]


def test_reject_draft_batch(seeded_db):
    batch = _batch(seeded_db)
    out = imp_batches.reject_batch(
        seeded_db, batch["id"], reason="源文件口径错误", actor="pytest"
    )
    assert out["status"] == ImportBatchStatus.REJECTED.value


def test_reject_committed_batch_is_forbidden(seeded_db):
    batch = _batch(seeded_db)
    imp_rows.commit_batch(seeded_db, batch["id"], actor="pytest")
    with pytest.raises(Validation):
        imp_batches.reject_batch(
            seeded_db, batch["id"], reason="已确认不可驳回", actor="pytest"
        )


def test_reject_batch_is_not_repeatable(seeded_db):
    batch = _batch(seeded_db)
    imp_batches.reject_batch(
        seeded_db, batch["id"], reason="首次驳回", actor="pytest"
    )
    with pytest.raises(Validation):
        imp_batches.reject_batch(
            seeded_db, batch["id"], reason="重复驳回", actor="pytest"
        )


# ------------------------------------------------------------------ 建批守卫
class TestCreateBatchGuards:
    def test_empty_source_name_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            imp_batches.create_batch(seeded_db, source_name="  ", rows=ROWS, actor="pytest")
        assert "source_name 不能为空" in str(exc.value)

    def test_text_inputs_are_business_errors(self, seeded_db):
        with pytest.raises(Validation, match="source_name 不能为空"):
            imp_batches.create_batch(
                seeded_db, source_name=123, rows=ROWS, actor="pytest"
            )

        batch = _batch(seeded_db)
        row_id = _first_row_id(seeded_db, batch["id"])
        with pytest.raises(Validation, match="补录关联必须填写依据"):
            imp_rows.assign_mapping(
                seeded_db, row_id, basis=123, actor="pytest"
            )

    def test_empty_rows_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            imp_batches.create_batch(seeded_db, source_name="orders.xlsx", rows=[])
        assert "导入内容为空" in str(exc.value)

    def test_each_import_row_must_be_an_object(self, seeded_db):
        with pytest.raises(Validation) as exc:
            imp_batches.create_batch(
                seeded_db,
                source_name="orders.xlsx",
                rows=[{"订单号": "HS0001"}, ["不是对象"]],
                actor="pytest",
            )
        assert "每行必须为对象" in str(exc.value)

    def test_source_kind_is_closed_to_standard_values(self, seeded_db):
        with pytest.raises(Validation) as exc:
            imp_batches.create_batch(
                seeded_db,
                source_name="orders.xlsx",
                rows=ROWS,
                source_kind="LEGACY_ORDER",
            )
        assert exc.value.details == {
            "field": "source_kind",
            "value": "LEGACY_ORDER",
        }

        batch = imp_batches.create_batch(
            seeded_db,
            source_name="accounts.xlsx",
            rows=ROWS,
            source_kind=ImportSourceKind.ACCOUNT.value,
            actor="pytest",
        )
        assert batch["source_kind"] == ImportSourceKind.ACCOUNT.value


# ------------------------------------------------------------------ 批次/行查询
class TestBatchQueries:
    def test_list_batches_newest_first(self, seeded_db):
        first = _batch(seeded_db, source_name="第一批")
        second = _batch(seeded_db, source_name="第二批")
        listed = imp_batches.list_batches(seeded_db)
        assert [item["batch_no"] for item in listed] == [
            second["batch_no"], first["batch_no"]
        ]
        assert listed[0]["source_name"] == "第二批"

    def test_list_rows_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            imp_rows.list_rows(seeded_db, 999999)

    def test_list_rows_filters_by_status(self, seeded_db):
        batch = _batch(seeded_db)
        row_id = _first_row_id(seeded_db, batch["id"])
        imp_rows.skip_row(seeded_db, row_id, reason="口径不明", actor="pytest")
        skipped = imp_rows.list_rows(seeded_db, batch["id"], status="skipped")
        assert [row["id"] for row in skipped] == [row_id]
        assert skipped[0]["issue_note"] == "口径不明"
        remaining = imp_rows.list_rows(
            seeded_db, batch["id"], status=ImportRowStatus.UNMAPPED.value
        )
        assert len(remaining) == len(ROWS) - 1


# ------------------------------------------------------------------ 映射守卫
class TestAssignMappingGuards:
    def test_row_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            imp_rows.assign_mapping(seeded_db, 999999, basis="人工核对", actor="pytest")

    def test_mapping_ids_must_be_positive_in_service(self, seeded_db):
        batch = _batch(seeded_db, rows=[{"订单号": "HS0001"}])
        row_id = _first_row_id(seeded_db, batch["id"])
        with pytest.raises(Validation, match="订单 ID 必须为正整数"):
            imp_rows.assign_mapping(
                seeded_db,
                row_id,
                order_id=0,
                basis="人工核对",
                actor="pytest",
            )

    def test_imported_row_cannot_be_remapped(self, seeded_db):
        from app.orders.create import create_order
        from datetime import date

        order = create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest"
        )
        batch = _batch(seeded_db)
        row_id = _first_row_id(seeded_db, batch["id"])
        imp_rows.assign_mapping(
            seeded_db, row_id, order_id=order.id, basis="订单号一致", actor="pytest"
        )
        imp_rows.commit_batch(seeded_db, batch["id"], actor="pytest")
        with pytest.raises(Validation) as exc:
            imp_rows.assign_mapping(
                seeded_db, row_id, order_id=order.id, basis="改一次", actor="pytest"
            )
        assert "已导入的导入行不可再改映射" in str(exc.value)

    def test_committed_unmapped_row_is_read_only(self, seeded_db):
        batch = _batch(seeded_db, rows=[{"订单号": "待人工确认"}])
        row_id = _first_row_id(seeded_db, batch["id"])
        imp_rows.commit_batch(seeded_db, batch["id"], actor="pytest")

        with pytest.raises(Validation, match="已确认批次的导入行不可修改"):
            imp_rows.assign_mapping(
                seeded_db, row_id, basis="提交后补录", actor="pytest"
            )
        with pytest.raises(Validation, match="已确认批次的导入行不可修改"):
            imp_rows.skip_row(seeded_db, row_id, reason="提交后跳过", actor="pytest")
        with pytest.raises(Validation, match="已确认批次的导入行不可修改"):
            imp_batches.mark_unlinked_transfer(seeded_db, row_id, actor="pytest")

    def test_unknown_order_rejected(self, seeded_db):
        batch = _batch(seeded_db)
        row_id = _first_row_id(seeded_db, batch["id"])
        with pytest.raises(NotFound) as exc:
            imp_rows.assign_mapping(
                seeded_db, row_id, order_id=999999, basis="人工核对", actor="pytest"
            )
        assert "订单" in str(exc.value)

    def test_unknown_account_rejected(self, seeded_db):
        batch = _batch(seeded_db)
        row_id = _first_row_id(seeded_db, batch["id"])
        with pytest.raises(NotFound) as exc:
            imp_rows.assign_mapping(
                seeded_db, row_id, account_id=999999, basis="人工核对", actor="pytest"
            )
        assert "账号" in str(exc.value)


# ------------------------------------------------------------------ 跳过行
class TestSkipRow:
    def test_empty_reason_rejected(self, seeded_db):
        batch = _batch(seeded_db)
        row_id = _first_row_id(seeded_db, batch["id"])
        with pytest.raises(Validation) as exc:
            imp_rows.skip_row(seeded_db, row_id, reason="  ", actor="pytest")
        assert "跳过导入行必须填写理由" in str(exc.value)

    def test_row_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            imp_rows.skip_row(seeded_db, 999999, reason="口径不明", actor="pytest")

    def test_skip_updates_row_and_unmapped_count(self, seeded_db):
        batch = _batch(seeded_db)
        row_id = _first_row_id(seeded_db, batch["id"])
        skipped = imp_rows.skip_row(
            seeded_db, row_id, reason="口径不明", actor="pytest"
        )
        assert skipped["status"] == ImportRowStatus.SKIPPED.value
        # 刷新未映射计数：跳过行不再计入 unmapped
        refreshed = imp_batches.list_batches(seeded_db)[0]
        assert refreshed["unmapped_count"] == len(ROWS) - 1

    def test_imported_row_cannot_be_skipped_and_skip_is_audited(self, seeded_db):
        from datetime import date

        from app.orders.create import create_order

        order = create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest"
        )
        batch = _batch(seeded_db, rows=[{"订单号": order.order_no}])
        row_id = _first_row_id(seeded_db, batch["id"])
        imp_rows.assign_mapping(
            seeded_db, row_id, order_id=order.id, basis="订单号一致", actor="pytest"
        )
        imp_rows.commit_batch(seeded_db, batch["id"], actor="pytest")

        with pytest.raises(Validation, match="已导入的导入行不可跳过"):
            imp_rows.skip_row(seeded_db, row_id, reason="再次核对", actor="pytest")

        row = seeded_db.get(ImportRow, row_id)
        assert row is not None
        assert row.status == ImportRowStatus.IMPORTED.value

        batch2 = _batch(seeded_db, rows=[{"订单号": "HS-待判断"}])
        row2_id = _first_row_id(seeded_db, batch2["id"])
        imp_rows.skip_row(seeded_db, row2_id, reason="口径不明", actor="pytest")
        audit = seeded_db.scalar(
            select(AuditLog)
            .where(
                AuditLog.action == AuditAction.IMPORT_SKIP.value,
                AuditLog.entity_id == str(row2_id),
            )
            .order_by(AuditLog.id.desc())
        )
        assert audit is not None


# ------------------------------------------------------------------ 提交守卫
class TestCommitGuards:
    def test_batch_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            imp_rows.commit_batch(seeded_db, 999999, actor="pytest")

    @pytest.mark.parametrize(
        "status",
        [
            ImportBatchStatus.REJECTED.value,
            ImportBatchStatus.ROLLED_BACK.value,
            ImportBatchStatus.CORRECTED.value,
        ],
    )
    def test_terminal_batch_cannot_be_committed_again(self, seeded_db, status):
        batch = _batch(seeded_db)
        item = seeded_db.get(ImportBatch, batch["id"])
        assert item is not None
        item.status = status
        seeded_db.flush()

        with pytest.raises(Validation, match="只有未确认批次可提交"):
            imp_rows.commit_batch(seeded_db, batch["id"], actor="pytest")

    def test_skipped_rows_are_not_imported(self, seeded_db):
        from app.orders.create import create_order
        from datetime import date

        order = create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest"
        )
        batch = _batch(seeded_db)
        rows = imp_rows.list_rows(seeded_db, batch["id"])
        imp_rows.assign_mapping(
            seeded_db, rows[0]["id"], order_id=order.id, basis="订单号一致", actor="pytest"
        )
        imp_rows.skip_row(seeded_db, rows[1]["id"], reason="口径不明", actor="pytest")

        result = imp_rows.commit_batch(seeded_db, batch["id"], actor="pytest")
        assert (result["imported"], result["unmapped"]) == (1, 0)
        statuses = {
            row["id"]: row["status"]
            for row in imp_rows.list_rows(seeded_db, batch["id"])
        }
        assert statuses[rows[0]["id"]] == ImportRowStatus.IMPORTED.value
        # SKIPPED 行保持跳过，不转为未映射
        assert statuses[rows[1]["id"]] == ImportRowStatus.SKIPPED.value


# ------------------------------------------------------------------ 单边划转
class TestMarkUnlinkedGuards:
    def test_row_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            imp_batches.mark_unlinked_transfer(seeded_db, 999999, actor="pytest")


# ------------------------------------------------------------------ 预览守卫
class TestPreviewGuards:
    def test_batch_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            imp_rows.preview_mapping(seeded_db, 999999)

    def test_empty_batch_returns_zero_rows(self, seeded_db):
        # create_batch 拒绝空行，空批次只能直插（对账/预览均须容忍零行批次）
        empty = ImportBatch(
            batch_no="IMP-EMPTY",
            source_name="empty.xlsx",
            source_kind="STANDARD_ORDER",
            status=ImportBatchStatus.DRAFT.value,
            row_count=0,
            unmapped_count=0,
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(empty)
        seeded_db.flush()
        preview = imp_rows.preview_mapping(seeded_db, empty.id)
        assert preview["total_rows"] == 0
        assert preview["columns"] == []
        # 零行批次走短路分支：不含核心列缺失统计（非空批次才有）
        assert "missing_core_columns" not in preview["abnormal"]
        assert preview["blockers"] == []

    def test_empty_values_counted(self, seeded_db):
        batch = _batch(
            seeded_db,
            rows=[{"日期": None, "交易金额": 13888}, {"日期": "", "交易金额": 20000}],
        )
        preview = imp_rows.preview_mapping(seeded_db, batch["id"])
        assert preview["abnormal"]["empty_value"] == 2
        column = {
            item["source_column"]: item for item in preview["columns"]
        }["交易金额"]
        assert column["filled_count"] == 2
        assert column["fill_rate"] == 100.0


# ------------------------------------------------------------------ 对账守卫
class TestReconciliationGuards:
    def test_batch_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            imp_rows.reconciliation_report(seeded_db, 999999)

    def test_amount_parsing_tolerates_list_and_garbage(self, seeded_db):
        # 480：数组列（如回款账户）跳过；483-484：无法转金额的值跳过而非崩
        batch = _batch(
            seeded_db,
            rows=[
                {"交易金额": ["13888"], "本金": "abc", "利润": 100},
                {"交易金额": 20000, "本金": 1000, "利润": "3.5"},
            ],
        )
        report = imp_rows.reconciliation_report(seeded_db, batch["id"])
        assert report["amounts"]["before"]["交易金额"] == "20000.00"
        assert report["amounts"]["before"]["本金"] == "1000.00"
        assert report["amounts"]["before"]["利润"] == "103.50"


# ------------------------------------------------------------------ 回滚/更正守卫
class TestRollbackAndCorrectionGuards:
    def test_rollback_batch_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            imp_batches.rollback_batch(seeded_db, 999999, reason="导错", actor="pytest")

    def test_correction_batch_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            imp_batches.create_correction_batch(
                seeded_db, 999999, rows=ROWS, reason="少导一行", actor="pytest"
            )

    def test_draft_batch_cannot_be_corrected(self, seeded_db):
        batch = _batch(seeded_db)
        with pytest.raises(Validation, match="只有已提交批次可更正"):
            imp_batches.create_correction_batch(
                seeded_db, batch["id"], rows=ROWS, reason="少导一行", actor="pytest"
            )

    def test_rejected_batch_cannot_be_rolled_back_again(self, seeded_db):
        batch = _batch(seeded_db)
        item = seeded_db.get(ImportBatch, batch["id"])
        assert item is not None
        item.status = ImportBatchStatus.REJECTED.value
        seeded_db.flush()
        with pytest.raises(Validation, match="只有未确认批次可回滚"):
            imp_batches.rollback_batch(seeded_db, batch["id"], reason="再次回滚", actor="pytest")


# ------------------------------------------------------------------ service 内部守卫（MIG-01 守门分支，提升 imports/service.py 覆盖）
class TestImportServiceInternalGuards:
    def test_assert_batch_editable_rejects_missing_batch(self, seeded_db):
        # service.py:52 的 NotFound 守卫：所有公开调用方虽都前置拦截 batch
        # 存在性，但该函数自身仍应独立守卫；直接调用传入不存在的 batch_id
        # 验证其抛 NotFound（保留防御、零源码改动）。
        with pytest.raises(NotFound):
            imp__shared._assert_batch_editable(seeded_db, 999999)

    def test_skip_row_rejects_rolled_back_row(self, seeded_db):
        batch = _batch(seeded_db)
        rows = imp_rows.list_rows(seeded_db, batch["id"])
        row_id = rows[0]["id"]
        item = seeded_db.get(ImportRow, row_id)
        assert item is not None
        item.status = ImportRowStatus.ROLLED_BACK.value
        seeded_db.flush()

        with pytest.raises(Validation, match="已回滚的导入行不可跳过"):
            imp_rows.skip_row(seeded_db, row_id, reason="口径不明", actor="pytest")

    def test_create_correction_rejects_non_object_rows(self, seeded_db):
        batch = _batch(seeded_db)
        imp_rows.commit_batch(seeded_db, batch["id"], actor="pytest")
        with pytest.raises(Validation, match="每行必须为对象"):
            imp_batches.create_correction_batch(
                seeded_db,
                batch["id"],
                rows=[{"日期": "2026/07/14", "交易金额": 1}, "NOT_A_DICT"],
                reason="少导一行",
                actor="pytest",
            )


# ------------------------------------------------------------------ 路由层
class TestImportApi:
    def test_import_requests_reject_unknown_fields(self, seeded_client, headers):
        response = seeded_client.post(
            "/api/v1/imports/batches",
            json={
                "source_name": "strict.xlsx",
                "rows": [{"a": 1}],
                "source_field": "must not be ignored",
            },
            headers=headers,
        )
        assert response.status_code == 422
        assert response.json()["code"] == "VALIDATION_ERROR"

    def test_list_batches_endpoint(self, seeded_client, seeded_db, headers):
        _batch(seeded_db, source_name="第一批")
        response = seeded_client.get("/api/v1/imports/batches", headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["total"] == 1

    def test_assign_mapping_endpoint(self, seeded_client, seeded_db, headers):
        batch = _batch(seeded_db)
        row_id = _first_row_id(seeded_db, batch["id"])
        response = seeded_client.post(
            f"/api/v1/imports/rows/{row_id}/map",
            json={"order_id": None, "account_id": None, "basis": "人工核对"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["mapping_basis"] == "人工核对"

    def test_skip_row_endpoint(self, seeded_client, seeded_db, headers):
        batch = _batch(seeded_db)
        row_id = _first_row_id(seeded_db, batch["id"])
        response = seeded_client.post(
            f"/api/v1/imports/rows/{row_id}/skip",
            json={"reason": "口径不明"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["status"] == ImportRowStatus.SKIPPED.value

    def test_preview_endpoint(self, seeded_client, seeded_db, headers):
        batch = _batch(seeded_db)
        response = seeded_client.get(
            f"/api/v1/imports/batches/{batch['id']}/preview", headers=headers
        )
        assert response.status_code == 200, response.text
        assert response.json()["total_rows"] == len(ROWS)

    def test_reconciliation_endpoint(self, seeded_client, seeded_db, headers):
        batch = _batch(seeded_db)
        response = seeded_client.get(
            f"/api/v1/imports/batches/{batch['id']}/reconciliation", headers=headers
        )
        assert response.status_code == 200, response.text
        assert response.json()["rows"]["source_total"] == len(ROWS)

    def test_mark_unlinked_endpoint(self, seeded_client, seeded_db, headers):
        batch = _batch(seeded_db)
        row_id = _first_row_id(seeded_db, batch["id"])
        response = seeded_client.post(
            f"/api/v1/imports/rows/{row_id}/unlinked-transfer",
            json={"note": "单边划转待裁决"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["unlinked_transfer"] is True

    def test_rollback_endpoint(self, seeded_client, seeded_db, headers):
        batch = _batch(seeded_db)
        response = seeded_client.post(
            f"/api/v1/imports/batches/{batch['id']}/rollback",
            json={"reason": "导错文件"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["status"] == ImportBatchStatus.ROLLED_BACK.value

    def test_correction_endpoint(self, seeded_client, seeded_db, headers):
        batch = _batch(seeded_db)
        imp_rows.commit_batch(seeded_db, batch["id"], actor="pytest")
        response = seeded_client.post(
            f"/api/v1/imports/batches/{batch['id']}/corrections",
            json={"rows": ROWS, "reason": "少导一行"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["corrects_batch_id"] == batch["id"]
