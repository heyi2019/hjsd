"""quality 异常工作台契约测试（QLT-01）：工单筛选/闭环 + 8 类检测器循环体 + 总览聚合。

与 test_m4.py 的分工：m4 已覆盖孤儿流水首循环、负余额、幂等、assign 成功、resolve 校验/close=True、
关闭后禁指派、审计、issue_type 单筛选、空 overview；本文件补其余筛选参数、NotFound 分支、
close=False、ignore 全函数、7 个检测器循环体、overview 有数据聚合。

断言口径：run_detection 跑全部检测器会跨面串扰，一律断言 >=1 不断言精确计数。
"""
from __future__ import annotations

import itertools
from datetime import date

import pytest

from app.core.money import to_money
from app.domain.enums import (
    AccountStatus,
    CapitalType,
    Direction,
    EventType,
    InstallmentStatus,
    IssueSeverity,
    IssueStatus,
    IssueType,
    LinkStatus,
    Nature,
    RebateStatus,
    ScheduleStatus,
)
from app.domain.quality import QualityIssue
from app.domain.trade import (
    Account,
    Cashflow,
    Installment,
    InstallmentSchedule,
    OrderEvent,
    RebateRecord,
)
from app.orders import service as order_service
from app.quality import service as quality_service

TODAY = date(2026, 10, 12)
PAST = date(2026, 9, 1)
_SEQ = itertools.count(1)  # 工单号自增，避免同用例多次造数撞唯一约束


def _add_issues(seeded_db, specs: list[dict]) -> None:
    """直插工单（沿用 test_m4.TestIssuePagination._make_issues 模式）。"""
    for spec in specs:
        seq = next(_SEQ)
        seeded_db.add(
            QualityIssue(
                issue_no=f"QIC{seq:04d}",
                issue_type=spec["issue_type"],
                severity=spec["severity"],
                status=spec["status"],
                entity_type=spec.get("entity_type", "account"),
                entity_id=spec.get("entity_id", seq),
                entity_label=spec.get("entity_label", f"acc-{seq}"),
                amount=to_money(spec.get("amount", "1.00")),
                detected_on=spec["detected_on"],
            )
        )
    seeded_db.commit()


def _open_issue(seeded_db) -> dict:
    """造一条 OPEN 工单（直插，不依赖检测器）。"""
    _add_issues(
        seeded_db,
        [
            {
                "issue_type": IssueType.ACCOUNT_CONFLICT.value,
                "severity": IssueSeverity.HIGH.value,
                "status": IssueStatus.OPEN.value,
                "detected_on": TODAY,
            }
        ],
    )
    return quality_service.get_issue(seeded_db, 1)


# ------------------------------------------------------------------ 筛选参数
class TestIssueFilters:
    def test_filters_status_and_severity(self, seeded_db):
        _add_issues(
            seeded_db,
            [
                {
                    "issue_type": IssueType.ACCOUNT_CONFLICT.value,
                    "severity": IssueSeverity.HIGH.value,
                    "status": IssueStatus.OPEN.value,
                    "detected_on": TODAY,
                },
                {
                    "issue_type": IssueType.ACCOUNT_CONFLICT.value,
                    "severity": IssueSeverity.LOW.value,
                    "status": IssueStatus.CLOSED.value,
                    "detected_on": TODAY,
                },
            ],
        )
        by_status = quality_service.list_issues(
            seeded_db, status=IssueStatus.OPEN.value
        )
        assert len(by_status) == 1
        assert quality_service.count_issues(
            seeded_db, status=IssueStatus.OPEN.value
        ) == 1
        by_severity = quality_service.list_issues(
            seeded_db, severity=IssueSeverity.LOW.value
        )
        assert len(by_severity) == 1
        assert quality_service.count_issues(
            seeded_db, severity=IssueSeverity.LOW.value
        ) == 1

    def test_filters_detected_from_to(self, seeded_db):
        _add_issues(
            seeded_db,
            [
                {
                    "issue_type": IssueType.ACCOUNT_CONFLICT.value,
                    "severity": IssueSeverity.LOW.value,
                    "status": IssueStatus.OPEN.value,
                    "detected_on": date(2026, 9, 1),
                },
                {
                    "issue_type": IssueType.ACCOUNT_CONFLICT.value,
                    "severity": IssueSeverity.LOW.value,
                    "status": IssueStatus.OPEN.value,
                    "detected_on": date(2026, 10, 1),
                },
            ],
        )
        mid = date(2026, 9, 15)
        assert quality_service.count_issues(seeded_db, detected_from=mid) == 1
        assert quality_service.count_issues(seeded_db, detected_to=mid) == 1
        both = quality_service.list_issues(
            seeded_db, detected_from=date(2026, 9, 1), detected_to=date(2026, 10, 1)
        )
        assert len(both) == 2


# ------------------------------------------------------------------ 工单读写分支
class TestIssueCrudBranches:
    def test_get_issue_hit_and_notfound(self, seeded_db):
        issue = _open_issue(seeded_db)
        fetched = quality_service.get_issue(seeded_db, issue["id"])
        assert fetched["id"] == issue["id"]
        with pytest.raises(Exception) as exc:
            quality_service.get_issue(seeded_db, 999999)
        assert "不存在" in str(exc.value)

    def test_assign_issue_notfound(self, seeded_db):
        with pytest.raises(Exception) as exc:
            quality_service.assign_issue(seeded_db, 999999, 1, actor="pytest")
        assert "不存在" in str(exc.value)

    def test_resolve_issue_notfound(self, seeded_db):
        with pytest.raises(Exception) as exc:
            quality_service.resolve_issue(
                seeded_db, 999999, resolution="已处置", actor="pytest"
            )
        assert "不存在" in str(exc.value)

    def test_resolve_close_false_leaves_open_state(self, seeded_db):
        issue = _open_issue(seeded_db)
        resolved = quality_service.resolve_issue(
            seeded_db, issue["id"], resolution="已处置待复核", actor="pytest", close=False
        )
        assert resolved["status"] == IssueStatus.RESOLVED.value
        assert resolved["closed_at"] is None
        assert resolved["resolution"] == "已处置待复核"

    def test_ignore_issue_happy_path(self, seeded_db):
        from sqlalchemy import select

        from app.domain.foundation import AuditLog

        issue = _open_issue(seeded_db)
        ignored = quality_service.ignore_issue(
            seeded_db, issue["id"], reason="误报，非真实异常", actor="pytest"
        )
        assert ignored["status"] == IssueStatus.IGNORED.value
        assert ignored["resolution"] == "误报，非真实异常"
        seeded_db.commit()
        audits = seeded_db.scalars(
            select(AuditLog).where(AuditLog.entity_type == "quality_issue")
        ).all()
        assert audits

    def test_ignore_issue_empty_reason_and_notfound(self, seeded_db):
        issue = _open_issue(seeded_db)
        with pytest.raises(Exception) as exc:
            quality_service.ignore_issue(seeded_db, issue["id"], reason="  ", actor="pytest")
        assert "理由" in str(exc.value)
        with pytest.raises(Exception) as exc:
            quality_service.ignore_issue(seeded_db, 999999, reason="误报", actor="pytest")
        assert "不存在" in str(exc.value)


# ------------------------------------------------------------------ 检测器循环体
class TestDetectors:
    def test_detect_unrouted_events_no_pool(self, seeded_db):
        order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
        )
        seeded_db.add(
            OrderEvent(
                event_no="HJE9001",
                order_id=order.id,
                event_type=EventType.BUY.value,
                amount=to_money("500.00"),
                portion="PRINCIPAL",
                occurred_on=TODAY,
                pool_id=None,
                is_posted=True,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.commit()
        result = quality_service.run_detection(seeded_db, actor="pytest", today=TODAY)
        assert result["created"]["unrouted_events"] >= 1
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.UNROUTED_EVENT.value
        )
        assert issues
        assert issues[0]["entity_label"] == "HJE9001"

    def test_detect_single_sided_transfer(self, seeded_db):
        seeded_db.add(
            Cashflow(
                flow_no="HJF9200",
                pool_id=1,
                occurred_on=TODAY,
                nature=Nature.BUSINESS_IN.value,
                category="OTHER",
                direction=Direction.IN.value,
                amount=to_money("100.00"),
                transfer_id="T-CONTRACT-1",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.commit()
        result = quality_service.run_detection(seeded_db, actor="pytest", today=TODAY)
        assert result["created"]["single_sided_transfer"] >= 1
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.SINGLE_SIDED_TRANSFER.value
        )
        assert issues
        assert issues[0]["entity_label"] == "T-CONTRACT-1"

    def test_detect_single_sided_transfer_balanced_pair_is_skipped(self, seeded_db):
        # 一进一出且金额相等 → 走 continue，不建单
        for flow_no, direction in (
            ("HJF9202", Direction.IN.value),
            ("HJF9203", Direction.OUT.value),
        ):
            seeded_db.add(
                Cashflow(
                    flow_no=flow_no,
                    pool_id=1,
                    occurred_on=TODAY,
                    nature=Nature.BUSINESS_IN.value,
                    category="OTHER",
                    direction=direction,
                    amount=to_money("100.00"),
                    transfer_id="T-BALANCED-1",
                    created_by="pytest",
                    updated_by="pytest",
                )
            )
        seeded_db.commit()
        quality_service.run_detection(seeded_db, actor="pytest", today=TODAY)
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.SINGLE_SIDED_TRANSFER.value
        )
        assert all(item["entity_label"] != "T-BALANCED-1" for item in issues)

    def test_detect_th_unclosed(self, seeded_db):
        order = order_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            capital_type=CapitalType.PASS_THRU.value,
        )
        order_service.post_event(
            seeded_db,
            order.id,
            event_type=EventType.BUY.value,
            amount="1000.00",
            occurred_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()
        result = quality_service.run_detection(seeded_db, actor="pytest", today=TODAY)
        assert result["created"]["th_unclosed"] >= 1
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.TH_UNCLOSED.value
        )
        assert issues
        assert issues[0]["amount"] == "1000.00"

    def test_detect_uncollected_rebate(self, seeded_db):
        seeded_db.add(
            RebateRecord(
                rebate_group_no="RGU-CONTRACT-1",
                source_order_id=None,
                rate=to_money("0.10"),
                base_amount=to_money("100.00"),
                status=RebateStatus.OPEN.value,
                link_status=LinkStatus.UNLINKED.value,
                collected_on=TODAY,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.commit()
        result = quality_service.run_detection(seeded_db, actor="pytest", today=TODAY)
        assert result["created"]["uncollected_rebate"] >= 1
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.UNCOLLECTED_REBATE.value
        )
        assert issues
        assert issues[0]["entity_label"] == "RGU-CONTRACT-1"

    def test_detect_account_conflict_single_order_is_skipped(self, seeded_db):
        # 一单一账号（total<=1）→ 走 continue，不建单
        account = Account(
            account_no="ACC-CONTRACT-3",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("100.00"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        order_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )
        seeded_db.commit()
        quality_service.run_detection(seeded_db, actor="pytest", today=TODAY)
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.ACCOUNT_CONFLICT.value
        )
        assert all(item["entity_label"] != "ACC-CONTRACT-3" for item in issues)

    def test_detect_overdue_installment(self, seeded_db):
        order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
        )
        contract = Installment(
            inst_no="INS-CONTRACT-1",
            order_id=order.id,
            contract_type="STOCK_SALE",
            principal=to_money("1200.00"),
            down_payment=to_money("0"),
            periods=3,
            per_period=to_money("400.00"),
            paid_amount=to_money("0"),
            status=InstallmentStatus.ACTIVE.value,
            first_due_on=PAST,
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(contract)
        seeded_db.flush()
        seeded_db.add(
            InstallmentSchedule(
                installment_id=contract.id,
                period_no=1,
                due_on=PAST,
                due_amount=to_money("400.00"),
                received_amount=to_money("0"),
                status=ScheduleStatus.PENDING.value,
            )
        )
        seeded_db.commit()
        result = quality_service.run_detection(seeded_db, actor="pytest", today=TODAY)
        assert result["created"]["overdue_installment"] >= 1
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.OVERDUE_INSTALLMENT.value
        )
        assert issues
        assert issues[0]["entity_label"] == "INS-CONTRACT-1-01"
        assert issues[0]["amount"] == "400.00"

    def test_detect_account_conflict_zero_cost(self, seeded_db):
        seeded_db.add(
            Account(
                account_no="ACC-CONTRACT-1",
                status=AccountStatus.IN_STOCK.value,
                cost_amount=to_money("0"),
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.commit()
        result = quality_service.run_detection(seeded_db, actor="pytest", today=TODAY)
        assert result["created"]["account_conflict"] >= 1
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.ACCOUNT_CONFLICT.value
        )
        assert any(item["entity_label"] == "ACC-CONTRACT-1" for item in issues)

    def test_detect_account_conflict_multi_order(self, seeded_db):
        account = Account(
            account_no="ACC-CONTRACT-2",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("100.00"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()
        for _ in range(2):
            order_service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=TODAY,
                actor="pytest",
                account_id=account.id,
            )
        seeded_db.commit()
        result = quality_service.run_detection(seeded_db, actor="pytest", today=TODAY)
        assert result["created"]["account_conflict"] >= 1
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.ACCOUNT_CONFLICT.value
        )
        assert any(item["note"] and "占用" in item["note"] for item in issues)

    def test_detect_orphan_cashflow_dangling_pointer(self, seeded_db):
        # 悬空指针循环：测试库全局 PRAGMA foreign_keys=ON（core/database.py:50-59），
        # 且 Cashflow.order_event_id 是 ON DELETE SET NULL —— 正常写路径不可能留下
        # 指向不存在事件的指针。本用例在连接级临时关 FK 构造该防御态，验证循环体行为；
        # 用完立即恢复 ON（PRAGMA 为连接级设置，不影响其它用例的连接）。
        from sqlalchemy import text

        seeded_db.execute(text("PRAGMA foreign_keys=OFF"))
        seeded_db.add(
            Cashflow(
                flow_no="HJF9201",
                pool_id=1,
                occurred_on=TODAY,
                nature=Nature.BUSINESS_IN.value,
                category="OTHER",
                direction=Direction.IN.value,
                amount=to_money("66.00"),
                order_event_id=999999,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.commit()
        seeded_db.execute(text("PRAGMA foreign_keys=ON"))
        result = quality_service.run_detection(seeded_db, actor="pytest", today=TODAY)
        assert result["created"]["orphan_cashflow"] >= 1
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.ORPHAN_CASHFLOW.value
        )
        assert any(item["note"] == "流水指向的事件已不存在" for item in issues)


# ------------------------------------------------------------------ API 端点
ISSUES = "/api/v1/quality/issues"


class TestQualityApi:
    """补 router 层端点覆盖：get/assign/resolve/ignore 的 HTTP 路径。"""

    def _issue_id(self, seeded_db) -> int:
        _add_issues(
            seeded_db,
            [
                {
                    "issue_type": IssueType.ACCOUNT_CONFLICT.value,
                    "severity": IssueSeverity.HIGH.value,
                    "status": IssueStatus.OPEN.value,
                    "detected_on": TODAY,
                }
            ],
        )
        return quality_service.list_issues(seeded_db)[0]["id"]

    def test_get_issue_endpoint(self, seeded_client, seeded_db, headers):
        issue_id = self._issue_id(seeded_db)
        response = seeded_client.get(f"{ISSUES}/{issue_id}", headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["id"] == issue_id
        missing = seeded_client.get(f"{ISSUES}/999999", headers=headers)
        assert missing.status_code == 404

    def test_assign_endpoint_requires_owner_id(self, seeded_client, seeded_db, headers):
        issue_id = self._issue_id(seeded_db)
        bad = seeded_client.post(f"{ISSUES}/{issue_id}/assign", json={}, headers=headers)
        assert bad.status_code == 422
        assert bad.json()["message"] == "缺少 owner_id"
        ok = seeded_client.post(
            f"{ISSUES}/{issue_id}/assign", json={"owner_id": 7}, headers=headers
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["status"] == IssueStatus.ASSIGNED.value
        assert ok.json()["owner_id"] == 7

    def test_resolve_and_ignore_endpoints(self, seeded_client, seeded_db, headers):
        issue_id = self._issue_id(seeded_db)
        resolved = seeded_client.post(
            f"{ISSUES}/{issue_id}/resolve",
            json={"resolution": "已处置", "close": False},
            headers=headers,
        )
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["status"] == IssueStatus.RESOLVED.value

        other_id = self._issue_id(seeded_db)
        ignored = seeded_client.post(
            f"{ISSUES}/{other_id}/ignore",
            json={"reason": "误报"},
            headers=headers,
        )
        assert ignored.status_code == 200, ignored.text
        assert ignored.json()["status"] == IssueStatus.IGNORED.value
# ------------------------------------------------------------------ 总览聚合
class TestOverviewWithData:
    def test_overview_aggregates_open_and_assigned(self, seeded_db):
        _add_issues(
            seeded_db,
            [
                {
                    "issue_type": IssueType.UNROUTED_EVENT.value,
                    "severity": IssueSeverity.BLOCKER.value,
                    "status": IssueStatus.OPEN.value,
                    "detected_on": TODAY,
                },
                {
                    "issue_type": IssueType.ACCOUNT_CONFLICT.value,
                    "severity": IssueSeverity.HIGH.value,
                    "status": IssueStatus.ASSIGNED.value,
                    "detected_on": TODAY,
                },
                {
                    "issue_type": IssueType.TH_UNCLOSED.value,
                    "severity": IssueSeverity.HIGH.value,
                    "status": IssueStatus.CLOSED.value,
                    "detected_on": TODAY,
                },
            ],
        )
        data = quality_service.overview(seeded_db)
        # 关闭态不计入总览
        assert data["total"] == 2
        assert data["blockers"] == 1
        by_type = {item["issue_type"]: item for item in data["items"]}
        assert by_type[IssueType.UNROUTED_EVENT.value]["open"] == 1
        assert by_type[IssueType.ACCOUNT_CONFLICT.value]["assigned"] == 1
        assert IssueType.TH_UNCLOSED.value not in by_type
        # BLOCKER 排在 HIGH 前
        assert data["items"][0]["severity"] == IssueSeverity.BLOCKER.value
        assert data["items"][0]["entry"] == "/quality?issue_type=UNROUTED_EVENT"
