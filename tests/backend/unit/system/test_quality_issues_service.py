"""QUALITY-01 质量异常工单服务契约测试。"""
from __future__ import annotations

from app.quality import issues


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
