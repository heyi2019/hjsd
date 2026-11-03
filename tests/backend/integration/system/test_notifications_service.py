"""API-01 notifications.service 业务函数单测（覆盖 create_notification / mark_read /
list_notifications 的校验与分支）。"""
from __future__ import annotations

import pytest

from app.core.errors import NotFound, Validation
from app.notifications import service as notification_service


def _make_unread(seeded_db, **kwargs):
    return notification_service.create_notification(
        seeded_db,
        recipient_user_id=kwargs.get("recipient_user_id", 2),
        notification_type=kwargs.get("notification_type", "SYSTEM"),
        title=kwargs.get("title", "测试通知"),
        message=kwargs.get("message", "内容"),
        entity_type=kwargs.get("entity_type", "rebate"),
        entity_id=kwargs.get("entity_id", "RB-1"),
        actor="pytest",
    )


def test_create_notification_rejects_blank_title_or_message(seeded_db):
    with pytest.raises(Validation, match="通知标题和内容不能为空"):
        notification_service.create_notification(
            seeded_db, recipient_user_id=2, notification_type="X",
            title="   ", message="m", entity_type="e", entity_id="1",
        )
    with pytest.raises(Validation, match="通知标题和内容不能为空"):
        notification_service.create_notification(
            seeded_db, recipient_user_id=2, notification_type="X",
            title="t", message="\n", entity_type="e", entity_id="1",
        )


def test_create_notification_rejects_blank_entity(seeded_db):
    with pytest.raises(Validation, match="通知来源对象不能为空"):
        notification_service.create_notification(
            seeded_db, recipient_user_id=2, notification_type="X",
            title="t", message="m", entity_type="  ", entity_id="1",
        )
    with pytest.raises(Validation, match="通知来源对象不能为空"):
        notification_service.create_notification(
            seeded_db, recipient_user_id=2, notification_type="X",
            title="t", message="m", entity_type="e", entity_id="  ",
        )


def test_list_notifications_unread_only_filters(seeded_db):
    a = _make_unread(seeded_db, entity_id="A")
    b = _make_unread(seeded_db, entity_id="B")
    notification_service.mark_read(seeded_db, a.id, recipient_user_id=2, actor="pytest")
    unread, unread_total = notification_service.list_notifications(
        seeded_db, recipient_user_id=2, unread_only=True
    )
    assert unread_total == 1
    assert [n.id for n in unread] == [b.id]
    all_rows, all_total = notification_service.list_notifications(
        seeded_db, recipient_user_id=2, unread_only=False
    )
    assert all_total == 2
    assert len(all_rows) == 2


def test_mark_read_not_found(seeded_db):
    with pytest.raises(NotFound, match="通知不存在"):
        notification_service.mark_read(
            seeded_db, 999999, recipient_user_id=2, actor="pytest"
        )


def test_mark_read_sets_read_at_and_idempotent(seeded_db):
    n = _make_unread(seeded_db)
    assert n.read_at is None
    updated = notification_service.mark_read(
        seeded_db, n.id, recipient_user_id=2, actor="pytest"
    )
    assert updated.read_at is not None
    # 幂等：再次 mark_read 不重设 read_at（L134 的 is None 守卫）
    again = notification_service.mark_read(
        seeded_db, n.id, recipient_user_id=2, actor="pytest"
    )
    assert again.read_at == updated.read_at
