"""NOTIFY-02 逾期合约按权限和提醒设置生成通知。"""
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.business.orders.create import create_order
from app.core.security import CurrentUser, build_access_token
from app.domain.notifications import Notification
from app.domain.options import OptionSet
from app.domain.trade import Installment, InstallmentSchedule

TODAY = date(2026, 11, 22)


def _user(uid=1, *, role="OPERATOR"):
    return CurrentUser.build(id=uid, username=f"seeduser{uid}", roles=[role], owner_scope="SELF")


def _schedule(db, n, *, owner=1, due=TODAY - timedelta(days=1), received="0", waived="0", kind="STOCK_SALE", status="PENDING"):
    order = create_order(db, order_type="TH", trade_date=TODAY, owner_id=owner, actor="pytest")
    contract = Installment(inst_no=f"INST-OVERDUE-{n}", order_id=order.id, contract_type=kind,
        principal=100, down_payment=0, periods=1, per_period=100, status=status,
        created_by="pytest", updated_by="pytest")
    db.add(contract)
    db.flush()
    schedule = InstallmentSchedule(installment_id=contract.id, period_no=1, due_on=due,
        due_amount=100, received_amount=Decimal(received), waived_amount=Decimal(waived))
    db.add(schedule)
    db.flush()
    return order, schedule


def _sync(db, user):
    from app.workbench.notifications.installments import sync_overdue_installment_notifications_for_user
    return sync_overdue_installment_notifications_for_user(db, user, as_of=TODAY)


def _notifications(db, user=1):
    return db.scalars(select(Notification).where(Notification.recipient_user_id == user,
        Notification.notification_type == "INSTALLMENT_OVERDUE")).all()


def test_overdue_notification_matches_real_unpaid_stock_sale_and_owner_scope(seeded_db):
    order, overdue = _schedule(seeded_db, 1, received="20", waived="10")
    _schedule(seeded_db, 2, owner=2)
    _schedule(seeded_db, 3, due=TODAY)
    _schedule(seeded_db, 4, received="50", waived="50")
    _schedule(seeded_db, 5, kind="PICKUP_SALE")
    _schedule(seeded_db, 6, status="CANCELLED")
    _schedule(seeded_db, 7, status="SETTLED")
    assert _sync(seeded_db, _user()) == 1
    notices = _notifications(seeded_db)
    assert len(notices) == 1
    assert notices[0].entity_type == "installment_schedule"
    assert notices[0].entity_id == str(overdue.id)
    assert order.order_no in notices[0].message
    assert "70.00" in notices[0].message
    assert _sync(seeded_db, _user()) == 0
    assert _sync(seeded_db, _user(2)) == 1
    assert len(_notifications(seeded_db, 2)) == 1


def test_disabled_retains_existing_and_reenable_only_creates_current_overdue(seeded_db):
    _, old = _schedule(seeded_db, 1)
    assert _sync(seeded_db, _user()) == 1
    config = OptionSet(code="BUSINESS_OVERVIEW_REMINDERS", label="提醒设置", options=[
        {"value": "overdue_installments_enabled", "label": "0"}], created_by="pytest", updated_by="pytest")
    seeded_db.add(config)
    _, repaid = _schedule(seeded_db, 2)
    _, current = _schedule(seeded_db, 3)
    assert _sync(seeded_db, _user()) == 0
    repaid.received_amount = repaid.due_amount
    config.options = [{"value": "overdue_installments_enabled", "label": "1"}]
    seeded_db.flush()
    assert _sync(seeded_db, _user()) == 1
    assert {n.entity_id for n in _notifications(seeded_db)} == {str(old.id), str(current.id)}


def test_user_without_installment_read_permission_gets_no_notification(seeded_db):
    _schedule(seeded_db, 1)
    assert _sync(seeded_db, CurrentUser(id=1, username="seeduser1")) == 0
    assert not _notifications(seeded_db)


def test_each_overdue_period_creates_one_notice(seeded_db, seeded_client):
    _, first = _schedule(seeded_db, 1, due=date(2000, 1, 1))
    second = InstallmentSchedule(installment_id=first.installment_id, period_no=2,
        due_on=date(2000, 1, 1), due_amount=100, received_amount=0, waived_amount=0)
    seeded_db.add(second)
    seeded_db.flush()
    auth = {"Authorization": f"Bearer {build_access_token(_user())}"}
    result = seeded_client.post("/api/notifications/sync-reminders", headers=auth)
    assert result.status_code == 200, result.text
    assert result.json()["created"] == 2
    assert {n.entity_id for n in _notifications(seeded_db)} == {str(first.id), str(second.id)}
    assert seeded_client.post("/api/notifications/sync-reminders", headers=auth).json()["created"] == 0


def test_concurrent_overdue_sync_creates_one_notification(v1_engine):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from uuid import uuid4

    from sqlalchemy import create_engine, event, text
    from sqlalchemy.orm import Session

    from app.domain.base import Base
    from app.domain.users import User
    from app.settings.field_definitions.seeds import seed_foundation

    schema = f"overdue_concurrency_{uuid4().hex[:12]}"
    with v1_engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(v1_engine.url, connect_args={"options": f"-c search_path={schema}"})
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as setup:
            seed_foundation(setup, actor="pytest", include_example_data=True)
            setup.add(User(id=1, username="seeduser1", display_name="test", password_hash="test", role="OPERATOR", owner_scope="SELF"))
            setup.flush()
            _, schedule = _schedule(setup, 1)
            schedule_id = schedule.id
            setup.commit()

        first_created, second_lock_attempted, second_finished = Event(), Event(), Event()

        def first_sync():
            with Session(engine) as session:
                created = _sync(session, _user())
                first_created.set()
                assert second_lock_attempted.wait(10)
                assert not second_finished.wait(0.2), "第二个同步在首个事务提交前完成"
                session.commit()
                return created

        def second_sync():
            assert first_created.wait(10)
            try:
                with Session(engine) as session:
                    def before(_conn, _cursor, statement, _params, _context, _many):
                        if "FOR NO KEY UPDATE" in statement.upper():
                            second_lock_attempted.set()
                    event.listen(session.connection(), "before_cursor_execute", before)
                    created = _sync(session, _user())
                    session.commit()
                    return created
            finally:
                second_finished.set()

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(first_sync)
            second = pool.submit(second_sync)
            assert first.result(timeout=20) == 1
            assert second.result(timeout=20) == 0
        with Session(engine) as session:
            messages = _notifications(session)
            assert len(messages) == 1
            assert messages[0].entity_id == str(schedule_id)
    finally:
        engine.dispose()
        with v1_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
