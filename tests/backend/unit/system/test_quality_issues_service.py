"""QUALITY-01 质量异常工单服务拆分后的直接契约测试。"""
from __future__ import annotations

from app.quality import issues
from app.quality import service as quality_service


def test_issue_module_creates_and_lists_issue(seeded_db):
    issue = issues.create_issue(
        seeded_db,
        code="MISSING_ATTACHMENT",
        severity="HIGH",
        title="缺少业务凭证",
        entity_type="order",
        entity_id="HS0001",
        message="订单缺少附件",
        actor="pytest",
    )

    listed = issues.list_issues(seeded_db, status="OPEN", code="MISSING_ATTACHMENT")

    assert issue.issue_no
    assert [item.id for item in listed] == [issue.id]


def test_quality_facade_re_exports_issue_service():
    assert quality_service.create_issue is issues.create_issue
    assert quality_service.update_issue is issues.update_issue
    assert quality_service.close_issue is issues.close_issue
