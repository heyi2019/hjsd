"""SYS-01-04 系统通知契约测试。"""
from __future__ import annotations

def test_overdue_rebate_notification_route_removed(app):
    assert "/api/v1/notifications/sync-overdue-rebates" not in app.openapi()["paths"]
