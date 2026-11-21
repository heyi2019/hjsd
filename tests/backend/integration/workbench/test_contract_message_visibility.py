"""NOTIFY-02 合约消息按当前数据权限展示并支持已读排序。"""
from datetime import date, datetime

from sqlalchemy import select

from app.business.orders.create import create_order
from app.core.security import CurrentUser, build_access_token
from app.domain.notifications import Notification
from app.domain.trade import Installment, InstallmentSchedule
from app.domain.users import User
from app.workbench.notifications import query, service


def test_contract_inbox_honors_scope_and_read_order(seeded_db, seeded_client):
    account = seeded_db.get(User, 2)
    assert account is not None
    account.role = "OPERATOR"
    account.owner_scope = "SELF"

    def schedule(owner: int, suffix: str):
        order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest", owner_id=owner,
                             account_snapshot={"game_account": f"contract-notif-{suffix}"})
        contract = Installment(inst_no=f"FC-TEST-{suffix}", order_id=order.id, contract_type="STOCK_SALE", principal=100,
                               down_payment=0, periods=1, per_period=100, status="ACTIVE", created_by="pytest", updated_by="pytest")
        seeded_db.add(contract)
        seeded_db.flush()
        item = InstallmentSchedule(installment_id=contract.id, period_no=1, due_on=date(2026, 10, 10), due_amount=100, status="OVERDUE")
        seeded_db.add(item)
        seeded_db.flush()
        return order, item

    visible_order, visible = schedule(2, "visible")
    _, hidden = schedule(1, "hidden")
    def notify(schedule_id, label, created_at):
        item = service.create_notification(seeded_db, recipient_user_id=2, notification_type="INSTALLMENT_OVERDUE",
                                           title="合约逾期", message=label, entity_type="installment_schedule",
                                           entity_id=str(schedule_id), actor="pytest")
        item.created_at = created_at
        seeded_db.flush()
        return item

    older = notify(visible.id, "较早通知", datetime(2026, 10, 10))
    newer = notify(visible.id, "较新通知", datetime(2026, 10, 11))
    hidden_item = notify(hidden.id, "不应显示", datetime(2026, 10, 12))
    user = CurrentUser.build(id=2, username="seeduser2", roles=["OPERATOR"], owner_scope="SELF")
    auth = {"Authorization": f"Bearer {build_access_token(user)}"}

    response = seeded_client.get("/api/notifications/inbox", params={"category": "contract", "limit": 1}, headers=auth)
    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()["items"]] == [newer.id]
    cursor = response.json()["next_cursor"]
    second = seeded_client.get("/api/notifications/inbox", params={"category": "contract", "limit": 1, "cursor": cursor}, headers=auth)
    assert [item["id"] for item in second.json()["items"]] == [older.id]
    latest = seeded_client.get("/api/notifications/inbox", params={"category": "latest"}, headers=auth).json()["items"]
    assert hidden_item.id not in {item["id"] for item in latest}
    denied = seeded_client.post("/api/notifications/read", json={"ids": [hidden_item.id], "category": "contract"}, headers=auth)
    assert denied.status_code == 200
    assert denied.json()["read_ids"] == []
    seeded_db.refresh(hidden_item)
    assert hidden_item.read_at is None

    for item in (older, newer):
        result = seeded_client.post("/api/notifications/read", json={"ids": [item.id], "category": "contract"}, headers=auth)
        assert result.status_code == 200, result.text
        assert result.json()["read_at"] is not None
    assert result.json()["next_read_id"] == older.id
    ordered = seeded_client.get("/api/notifications/inbox", params={"category": "contract"}, headers=auth).json()["items"]
    assert [item["id"] for item in ordered] == [newer.id, older.id]

    visible_order.owner_id = 1
    seeded_db.flush()
    assert seeded_client.get("/api/notifications/inbox", params={"category": "contract"}, headers=auth).json()["items"] == []
    restricted = CurrentUser(id=2, username="seeduser2", permissions=frozenset(), owner_scope="ALL")
    assert not query.inbox_page(seeded_db, recipient_user_id=2, category="contract", cursor=None, limit=10, user=restricted)[0]
