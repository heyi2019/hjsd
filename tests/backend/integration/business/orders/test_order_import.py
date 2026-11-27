"""ORDERIMPORT-01 订单导入模板、历史收支与预检。"""
from __future__ import annotations

from io import BytesIO

import pytest
from openpyxl import Workbook, load_workbook

from app.business.orders.importing import parser
from app.business.orders.importing.parser import parse_order_import
from app.business.orders.importing.template import build_order_import_template
from app.core.errors import Validation


def test_import_template_hides_order_business_date_even_when_configured_visible():
    columns = [{"key": "trade_date", "label": "业务日期", "is_visible": True}]
    workbook = load_workbook(BytesIO(build_order_import_template(columns, set())))
    headers = [cell.value for cell in workbook["主订单信息"][1]]
    assert "业务日期" not in headers
    assert "入库时间" in headers


def test_import_derives_order_date_from_inventory_entry_without_shifting_financial_dates(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import select
    from app.domain.trade import Cashflow, Order
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="自动业务日期账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = (
        "库存编号,订单号,业务类型,入库操作人,入库时间,回收价,提号价,售卖时间,售出金额\n"
        "KU_00951,HS0951,回收,admin,2026-07-30 10:25:00,100,,2026-08-03,150\n"
    ).encode()
    files = {"file": ("订单.csv", content, "text/csv")}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"}, files=files)
    assert preview.status_code == 200, preview.text
    assert preview.json()["rows"][0]["action"] == "create", preview.text
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"}, files=files)
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "HS0951"))
    assert order.trade_date == date(2026, 7, 30)
    flows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id).order_by(Cashflow.occurred_on)).all()
    assert [(flow.direction, flow.occurred_on, int(flow.amount)) for flow in flows] == [
        ("OUT", date(2026, 7, 30), 100), ("IN", date(2026, 8, 3), 150),
    ]


def test_import_without_inventory_entry_uses_order_creation_date(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Account, Order

    content = (
        "库存编号,订单号,业务类型,入库操作人,入库时间,回收价,提号价\n"
        "KU_00952,DG0952,代挂,admin,,,\n"
    ).encode()
    files = {"file": ("订单.csv", content, "text/csv")}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"}, files=files)
    assert preview.status_code == 200, preview.text
    row = preview.json()["rows"][0]
    assert row["action"] == "create" and any("入库时间" in warning for warning in row["warnings"])
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"}, files=files)
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0952"))
    account = seeded_db.get(Account, order.account_id)
    assert order.trade_date == account.inventory_entry_at.date() == order.created_at.date()


def test_preview_validates_entry_time_even_without_inventory_or_price_columns(seeded_client, headers):
    content = "订单号,业务类型,入库时间\nDG0953,代挂,2026-07-30oops\n".encode()
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                 files={"file": ("订单.csv", content, "text/csv")})
    assert preview.status_code == 200, preview.text
    assert "入库时间格式无效" in preview.json()["rows"][0]["errors"]


def test_import_update_keeps_existing_order_date_and_cashflow_dates(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import select
    from app.domain.trade import Cashflow, Order
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="更新导入日期账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = ("订单号,业务类型,入库操作人,入库时间,回收价\n"
               "HS0954,回收,admin,2026-07-30,100\n").encode()
    created = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                 files={"file": ("订单.csv", content, "text/csv")})
    assert created.status_code == 200, created.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "HS0954"))
    update = "订单号,业务类型,入库时间,订单备注\nHS0954,回收,2026-07-30,修改备注\n".encode()
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "update"},
                                files={"file": ("订单.csv", update, "text/csv")})
    assert result.status_code == 200, result.text
    seeded_db.refresh(order)
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == order.id))
    assert (order.trade_date, flow.occurred_on, order.note) == (date(2026, 7, 30), date(2026, 7, 30), "修改备注")


def test_new_order_import_rejects_removed_business_date_column(seeded_client, headers):
    content = "订单号,业务日期,业务类型,入库时间\nDG0955,2026-07-29,代挂,2026-07-30\n".encode()
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                 files={"file": ("订单.csv", content, "text/csv")})
    assert preview.status_code == 200, preview.text
    assert any("业务日期" in error for error in preview.json()["rows"][0]["errors"])


def test_import_history_can_revert_new_order_stock_and_cashflows(seeded_client, seeded_db, headers):
    from sqlalchemy import func, select
    from app.domain.trade import Account, Cashflow, Order, OrderEvent
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="导入撤回账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = ("库存编号,订单号,业务类型,入库操作人,入库时间,回收价,提号价,售卖时间,售出金额\n"
               "KU_00956,HS0956,回收,admin,2026-07-30,100,,2026-08-03,150\n").encode()
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                   files={"file": ("历史订单.csv", content, "text/csv")})
    assert response.status_code == 200, response.text
    batch_id = response.json()["batch_id"]
    history = seeded_client.get("/api/order-imports/history", headers=headers)
    assert history.status_code == 200, history.text
    batch = next(item for item in history.json() if item["id"] == batch_id)
    assert (batch["file_name"], batch["created"], batch["status"]) == ("历史订单.csv", 1, "imported")
    audit_actions = seeded_client.get("/api/audit-logs/actions", headers=headers)
    assert audit_actions.status_code == 200
    assert {"ORDER_IMPORT", "ORDER_IMPORT_REVERT"} <= set(audit_actions.json()["items"])
    reverted = seeded_client.post(f"/api/order-imports/history/{batch_id}/revert", headers=headers)
    assert reverted.status_code == 200, reverted.text
    assert reverted.json()["status"] == "reverted"
    for model in (Order, Account, OrderEvent, Cashflow):
        assert seeded_db.scalar(select(func.count()).select_from(model)) == 0
    assert seeded_client.post(f"/api/order-imports/history/{batch_id}/revert", headers=headers).status_code == 422


def test_import_revert_rejects_later_business_changes_without_partial_deletion(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order

    content = ("订单号,业务类型,入库时间,订单备注\n"
               "DG0957,代挂,2026-07-30,导入备注\nDG0958,代挂,2026-07-30,导入备注\n").encode()
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                   files={"file": ("订单.csv", content, "text/csv")})
    assert response.status_code == 200, response.text
    batch_id = response.json()["batch_id"]
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0957"))
    order.note = "后续人工修改"
    seeded_db.commit()
    reverted = seeded_client.post(f"/api/order-imports/history/{batch_id}/revert", headers=headers)
    assert reverted.status_code == 422
    assert set(seeded_db.scalars(select(Order.order_no).where(Order.order_no.in_(["DG0957", "DG0958"])))) == {"DG0957", "DG0958"}


@pytest.mark.parametrize("reconciled_on, can_revert", [
    ("2026-07-29", True), ("2026-07-30", False), ("2026-08-04", False),
])
def test_import_revert_checks_reconciliation_date_boundary(seeded_client, seeded_db, headers, reconciled_on, can_revert):
    from datetime import date
    from sqlalchemy import select
    from app.domain.trade import Order
    from app.finance.reconciliation.service import create_reconciliation
    from app.settings.field_definitions.pools import create_pool

    pool = create_pool(seeded_db, name="撤回对账日期账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = ("库存编号,订单号,业务类型,入库操作人,入库时间,回收价,售卖时间,售出金额\n"
               "KU_00960,HS0960,回收,admin,2026-07-30,100,2026-08-03,150\n").encode()
    imported = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                  files={"file": ("订单.csv", content, "text/csv")})
    assert imported.status_code == 200, imported.text
    create_reconciliation(seeded_db, pool_id=pool.id, reconciled_on=date.fromisoformat(reconciled_on),
                          account_label="日期边界", statement_balance="0", reason="核对", actor="admin")
    seeded_db.commit()

    result = seeded_client.post(f"/api/order-imports/history/{imported.json()['batch_id']}/revert", headers=headers)
    assert result.status_code == (200 if can_revert else 422), result.text
    assert (seeded_db.scalar(select(Order.id).where(Order.order_no == "HS0960")) is None) == can_revert


def test_import_revert_waits_for_concurrent_reconciliation(v1_engine):
    from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
    from datetime import date
    from threading import Event
    from uuid import uuid4
    from sqlalchemy import create_engine, event, select
    from sqlalchemy.orm import sessionmaker
    from app.business.orders.importing.execute import execute_order_import
    from app.business.orders.importing.history import revert_import
    from app.core.security import CurrentUser
    from app.domain.base import Base
    from app.domain.trade import BalanceSnapshot, Order
    from app.domain.users import User
    from app.finance.reconciliation.service import create_reconciliation
    from app.settings.field_definitions.catalog_seed import seed_catalog
    from app.settings.field_definitions.pools import create_pool
    from app.settings.field_definitions.seeds import seed_foundation

    database = f"heijin_import_revert_test_{uuid4().hex}"
    admin_engine = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    factory = sessionmaker(bind=engine, autoflush=False)
    content = ("库存编号,订单号,业务类型,入库操作人,入库时间,回收价,售卖时间,售出金额\n"
               "KU_00960,HS0960,回收,admin,2026-07-30,100,2026-08-03,150\n").encode()
    reached = Event()

    def revert(batch_id, user):
        with factory() as session:
            def capture(_conn, _cursor, statement, _params, _context, _many):
                sql = statement.lower()
                if "from balance_snapshots" in sql or ("from pools" in sql and "for no key update" in sql):
                    reached.set()
            event.listen(session.connection(), "before_cursor_execute", capture)
            try:
                revert_import(session, batch_id, user)
                session.commit()
                return "reverted"
            except Validation as exc:
                session.rollback()
                return exc.message

    try:
        Base.metadata.create_all(engine)
        with factory() as session:
            seed_foundation(session, actor="pytest")
            seed_catalog(session, actor="pytest")
            employee = User(username="admin", display_name="admin", password_hash="unused", role="ADMIN", owner_scope="ALL")
            session.add(employee)
            session.flush()
            user = CurrentUser.build(id=employee.id, username="admin", roles=["ADMIN"], owner_scope="ALL")
            pool_id = create_pool(session, name="撤回并发对账账户", actor="pytest", is_default=True).id
            session.commit()
            result = execute_order_import(session, parse_order_import("订单.csv", content), existing="skip", sections=set(), user=user)
            batch_id = result["batch_id"]
            session.commit()
        with factory() as reconciliation, ThreadPoolExecutor(max_workers=1) as executor:
            create_reconciliation(reconciliation, pool_id=pool_id, reconciled_on=date(2026, 8, 3),
                                  account_label="并发对账", statement_balance="50", actor="admin")
            future = executor.submit(revert, batch_id, user)
            try:
                assert reached.wait(10), "撤回未到达账户锁或对账检查"
                try:
                    early = future.result(timeout=0.3)
                except FutureTimeout:
                    early = None
            finally:
                reconciliation.commit()
            assert early is None, f"对账尚未提交，撤回已提前结束：{early}"
            assert "对账" in future.result(timeout=10)
        with factory() as session:
            assert session.scalar(select(Order.id).where(Order.order_no == "HS0960")) is not None
            assert session.scalar(select(BalanceSnapshot.id).where(BalanceSnapshot.pool_id == pool_id)) is not None
    finally:
        engine.dispose()
        with admin_engine.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin_engine.dispose()


def test_import_revert_restores_updated_order_without_changing_prior_cashflows(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import select
    from app.domain.trade import Cashflow, Order
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="撤回更新账户", actor="pytest", is_default=True)
    seeded_db.commit()
    initial = ("订单号,业务类型,入库操作人,入库时间,回收价,订单备注\n"
               "HS0959,回收,admin,2026-07-30,100,原备注\n").encode()
    created = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                  files={"file": ("原订单.csv", initial, "text/csv")})
    assert created.status_code == 200, created.text
    update = "订单号,业务类型,订单备注\nHS0959,回收,新备注\n".encode()
    changed = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "update"},
                                  files={"file": ("更新.csv", update, "text/csv")})
    assert changed.status_code == 200, changed.text
    revert = seeded_client.post(f"/api/order-imports/history/{changed.json()['batch_id']}/revert", headers=headers)
    assert revert.status_code == 200, revert.text
    seeded_db.expire_all()
    order = seeded_db.scalar(select(Order).where(Order.order_no == "HS0959"))
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == order.id))
    assert (order.note, order.trade_date, flow.amount, flow.occurred_on) == ("原备注", date(2026, 7, 30), 100, date(2026, 7, 30))


def test_import_revert_preserves_later_linked_deposit(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import select
    from app.domain.foundation import Pool
    from app.domain.trade import Deposit, Order

    content = "订单号,业务类型,入库时间\nDG0956,代挂,2026-07-30\n".encode()
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                   files={"file": ("订单.csv", content, "text/csv")})
    assert response.status_code == 200, response.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0956"))
    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    deposit = Deposit(pool_id=pool.id, source_order_id=order.id, paid_amount=100, paid_on=date(2026, 8, 1))
    seeded_db.add(deposit)
    seeded_db.commit()
    response = seeded_client.post(f"/api/order-imports/history/{response.json()['batch_id']}/revert", headers=headers)
    assert response.status_code == 422
    seeded_db.refresh(deposit)
    assert deposit.source_order_id == order.id
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "DG0956")) == order.id


def test_import_history_never_deletes_recorded_rebates(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.foundation import Pool
    from app.domain.trade import RebateRecord

    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    workbook = Workbook()
    main = workbook.active
    main.title = "主订单信息"
    main.append(["订单号", "业务类型", "入库时间"])
    main.append(["DG0957", "代挂", "2026-07-30"])
    rebates = workbook.create_sheet("返点明细")
    rebates.append(["订单号", "返点单号", "返点类型", "返点金额", "收到日期", "资金账户编码"])
    rebates.append(["DG0957", "DG0957-RB01", "卖号返点", "10", "2026-08-03", pool.code])
    output = BytesIO()
    workbook.save(output)
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip", "sections": "rebates"},
                                   files={"file": ("返点.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 200, response.text
    batch_id = response.json()["batch_id"]
    history = seeded_client.get("/api/order-imports/history", headers=headers).json()
    batch = next(item for item in history if item["id"] == batch_id)
    assert not batch["reversible"] and "返点" in batch["reason"]
    assert seeded_client.post(f"/api/order-imports/history/{batch_id}/revert", headers=headers).status_code == 422
    assert seeded_db.scalar(select(RebateRecord.id).where(RebateRecord.rebate_no == "DG0957-RB01")) is not None


def test_reverting_inventory_addition_allows_prior_import_to_be_reverted(seeded_client, seeded_db, headers):
    import time
    from sqlalchemy import func, select
    from app.domain.trade import Account, Cashflow, Order
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="补库存撤回账户", actor="pytest", is_default=True)
    seeded_db.commit()
    initial = ("订单号,业务类型,入库操作人,入库时间,回收价,提号价\n"
               "TH0958,提号,admin,2026-07-30,,100\n").encode()
    first = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                               files={"file": ("订单.csv", initial, "text/csv")})
    assert first.status_code == 200, first.text
    enriched = initial.replace("订单号,".encode(), "库存编号,订单号,".encode(), 1).replace(b"TH0958,", b"KU_00958,TH0958,", 1)
    second = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "inventory"},
                                files={"file": ("库存.csv", enriched, "text/csv")})
    assert second.status_code == 200, second.text
    time.sleep(1.1)  # 审计时间精确到秒，确保撤回时与导入时不在同一秒。
    reverted = seeded_client.post(f"/api/order-imports/history/{second.json()['batch_id']}/revert", headers=headers)
    assert reverted.status_code == 200, reverted.text
    seeded_db.expire_all()
    order = seeded_db.scalar(select(Order).where(Order.order_no == "TH0958"))
    assert order.account_id is None
    assert seeded_db.scalar(select(func.count()).select_from(Account)) == 0
    assert seeded_db.scalar(select(func.count()).select_from(Cashflow)) == 1
    reverted_first = seeded_client.post(f"/api/order-imports/history/{first.json()['batch_id']}/revert", headers=headers)
    assert reverted_first.status_code == 200, reverted_first.text


def test_revert_does_not_leave_later_order_notification_orphaned(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.notifications import Notification
    from app.domain.trade import Order

    content = "订单号,业务类型,入库时间\nDG0958,代挂,2026-07-30\n".encode()
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                   files={"file": ("订单.csv", content, "text/csv")})
    assert response.status_code == 200, response.text
    notification = Notification(notification_no="NTF9000", recipient_user_id=1, notification_type="PROFIT_PENDING",
                                title="订单跟进", message="请核对", entity_type="order", entity_id="DG0958")
    seeded_db.add(notification)
    seeded_db.commit()
    reverted = seeded_client.post(f"/api/order-imports/history/{response.json()['batch_id']}/revert", headers=headers)
    assert reverted.status_code == 422
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "DG0958")) is not None
    assert seeded_db.get(Notification, notification.id) is not None


def test_non_admin_cannot_view_or_revert_another_users_import(seeded_client, headers):
    content = "订单号,业务类型,入库时间\nDG0960,代挂,2026-07-30\n".encode()
    imported = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                  files={"file": ("订单.csv", content, "text/csv")})
    assert imported.status_code == 200, imported.text
    batch_id = imported.json()["batch_id"]
    operator = {"X-Dev-User": "operator"}
    history = seeded_client.get("/api/order-imports/history", headers=operator)
    assert history.status_code == 200, history.text
    assert all(item["id"] != batch_id for item in history.json())
    assert seeded_client.post(f"/api/order-imports/history/{batch_id}/revert", headers=operator).status_code == 403


def _without_business_operator_from_export(content: bytes, extension: str) -> bytes:
    if extension == "csv":
        import csv
        from io import StringIO

        rows = list(csv.reader(StringIO(content.decode("utf-8-sig"))))
        columns = {index for index, name in enumerate(rows[0]) if name in {"业务操作人", "业务日期"}}
        output = StringIO(newline="")
        csv.writer(output).writerows([[value for index, value in enumerate(row) if index not in columns] for row in rows])
        return output.getvalue().encode("utf-8-sig")
    book = load_workbook(BytesIO(content))
    sheet = book["主订单信息"]
    for name in ("业务操作人", "业务日期"):
        sheet.delete_cols([cell.value for cell in sheet[1]].index(name) + 1)
    output = BytesIO()
    book.save(output)
    return output.getvalue()


def test_imports_and_updates_configured_order_columns_with_typed_values(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.foundation import AuditLog
    from app.domain.lists import ListCustomColumn
    from app.domain.trade import Order, OrderFormField

    for key, label, kind, options, section in (
        ("priority_note", "备注级别", "TEXT", [], "BUSINESS"),
        ("priority_level", "优先等级", "SELECT", [{"value": "HIGH", "label": "高"}, {"value": "LOW", "label": "低"}], "BUSINESS"),
        ("account_tag", "账号标签", "TEXT", [], "ACCOUNT_PRODUCT"),
    ):
        seeded_db.add(OrderFormField(order_type_code="DG", field_key=key, label=label,
                                     field_type=kind, options=options, section=section,
                                     is_custom=True, is_active=True, required=False, sort_order=950))
        seeded_db.add(ListCustomColumn(scope="LEDGER", column_key=f"extra:{key}", source_key=key,
                                      label=label, field_type=kind,
                                      value_labels={item["value"]: item["label"] for item in options}))
    seeded_db.commit()

    def submit(choice, note, level):
        content = f"订单号,入库时间,业务类型,游戏账号/产品,备注级别,优先等级,账号标签\nDG0950,2026-10-17,代挂,历史账号,{note},{level},账号历史标签\n".encode()
        return seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": choice},
                                  files={"file": ("订单.csv", content, "text/csv")})

    created = submit("skip", "普通", "高")
    assert created.status_code == 200, created.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0950"))
    seeded_db.refresh(order)
    assert order.form_extra["priority_note"] == "普通"
    assert order.form_extra["priority_level"] == "HIGH"
    fetched = seeded_client.get(f"/api/orders/{order.id}", headers=headers)
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["form_extra"]["priority_level"] == "HIGH"
    assert fetched.json()["account_snapshot"]["extra_values"]["account_tag"] == "账号历史标签"

    updated = submit("update", "已复核", "低")
    assert updated.status_code == 200, updated.text
    seeded_db.refresh(order)
    assert order.form_extra["priority_note"] == "已复核"
    assert order.form_extra["priority_level"] == "LOW"
    listed = seeded_client.get("/api/orders", headers=headers, params={"keyword": "DG0950"})
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["extra_values"]["account_tag"] == "账号历史标签"
    for extension in ("csv", "xlsx"):
        exported = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": "DG0950"})
        assert exported.status_code == 200, exported.text
        table = parse_order_import(f"订单.{extension}", exported.content)["main"]
        row = dict(zip(table.headers, table.rows[0].values))
        assert row["账号标签"] == "账号历史标签"
        assert row["优先等级"] == "低"
    audit = seeded_db.scalar(select(AuditLog).where(AuditLog.entity_type == "order", AuditLog.entity_id == order.order_no,
                                                    AuditLog.action == "ORDER_UPDATE").order_by(AuditLog.id.desc()))
    assert audit.before_json["form_extra"] == {"priority_note": "普通", "priority_level": "HIGH"}
    assert audit.after_json["form_extra"] == {"priority_note": "已复核", "priority_level": "LOW"}


def test_ledger_custom_account_field_uses_current_inventory_value(seeded_client, seeded_db, headers):
    from datetime import date
    from app.business.orders.create import create_order
    from app.domain.lists import ListCustomColumn
    from app.domain.trade import Account, OrderFormField

    seeded_db.add(OrderFormField(order_type_code="DG", field_key="account_tag", label="账号标签",
                                 field_type="TEXT", options=[], section="ACCOUNT_PRODUCT",
                                 is_custom=True, is_active=True, required=False, sort_order=950))
    seeded_db.add(ListCustomColumn(scope="LEDGER", column_key="extra:account_tag", source_key="account_tag",
                                  label="账号标签", field_type="TEXT"))
    seeded_db.flush()
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                         account_snapshot={"game_account": "库存自定义字段", "extra_values": {"account_tag": "旧标签"}})
    account = seeded_db.get(Account, order.account_id)
    account.form_extra = {"account_tag": "库存当前标签"}
    seeded_db.commit()

    listed = seeded_client.get("/api/orders", headers=headers, params={"keyword": order.order_no})
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["extra_values"]["account_tag"] == "库存当前标签"
    inventory = seeded_client.get("/api/stocks/inventory/ledger", headers=headers, params={"keyword": "库存自定义字段", "include_images": False})
    assert inventory.status_code == 200, inventory.text
    assert inventory.json()["items"][0]["order"]["extra_values"]["account_tag"] == "库存当前标签"
    exported = seeded_client.get("/api/orders/export.csv", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text
    table = parse_order_import("订单.csv", exported.content)["main"]
    assert dict(zip(table.headers, table.rows[0].values))["账号标签"] == "库存当前标签"


@pytest.mark.parametrize(("kind", "raw", "expected"), [
    ("TEXT", "  保留空格  ", "  保留空格  "),
    ("NUMBER", "120.0", 120),
    ("BOOLEAN", "否", False),
    ("DATE", "2026-10-17 11:30:00", "2026-10-17"),
    ("MULTI_SELECT", '["HIGH","LOW"]', ["HIGH", "LOW"]),
])
def test_custom_column_values_follow_the_field_type(kind, raw, expected):
    from types import SimpleNamespace
    from app.business.orders.importing.custom_columns import read_custom_order_values

    definition = SimpleNamespace(field_type=kind, field_key="field", label="字段", section="BUSINESS",
                                 options=[{"value": "HIGH"}, {"value": "LOW"}])
    column = SimpleNamespace(source_key="field", value_labels={"HIGH": "高", "LOW": "低"})
    result, account_fields = read_custom_order_values({"字段": raw}, "DG", {("DG", "字段"): (column, definition)})
    assert result == {"field": expected}
    assert not account_fields


def test_custom_column_rejects_ambiguous_options_and_lossy_numbers():
    from types import SimpleNamespace
    from app.business.orders.importing.custom_columns import read_custom_order_values

    definition = SimpleNamespace(field_type="SELECT", field_key="field", label="字段", section="BUSINESS", options=[])
    column = SimpleNamespace(source_key="field", value_labels={"A": "相同", "B": "相同"})
    with pytest.raises(Validation, match="不唯一"):
        read_custom_order_values({"字段": "相同"}, "DG", {("DG", "字段"): (column, definition)})
    definition.field_type = "NUMBER"
    with pytest.raises(Validation, match="无法无损"):
        read_custom_order_values({"字段": "0.1"}, "DG", {("DG", "字段"): (column, definition)})
    with pytest.raises(Validation, match="重名"):
        read_custom_order_values({"业务类型": "代挂"}, "DG", {("DG", "业务类型"): None})


def test_readonly_detail_json_compares_values_and_types():
    from app.business.orders.importing.detail_reference import same_readonly_detail

    assert same_readonly_detail('{"a": 1, "b": [true]}', '{"b":[true],"a":1}')
    assert not same_readonly_detail('{"a": true}', '{"a":1}')
    assert not same_readonly_detail('{"a": 1}', '{"a":1.0}')


def test_detail_reference_respects_order_scope_and_audit_permission(seeded_db):
    import json
    from datetime import date
    from app.business.orders.create import create_order
    from app.business.orders.importing.detail_reference import detail_reference_values
    from app.core.security import CurrentUser

    own = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest", owner_id=1)
    other = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest", owner_id=2)
    limited = CurrentUser.build(id=1, username="seeduser1", roles=["OPERATOR"], owner_scope="SELF")
    admin = CurrentUser.build(id=17, username="admin", roles=["ADMIN"], owner_scope="ALL")
    references = detail_reference_values(seeded_db, {own.order_no, other.order_no}, limited, workbook=True)
    assert set(references) == {own.order_no}
    assert json.loads(references[own.order_no]["审计记录"]) == []
    admin_reference = detail_reference_values(seeded_db, {own.order_no}, admin, workbook=True)
    assert json.loads(admin_reference[own.order_no]["审计记录"])


def test_preview_rejects_ambiguous_custom_column_names(seeded_client, seeded_db, headers):
    from app.domain.lists import ListCustomColumn
    from app.domain.trade import OrderFormField

    for key in ("first_flag", "second_flag"):
        seeded_db.add(OrderFormField(order_type_code="DG", field_key=key, label="标记", field_type="TEXT",
                                     section="BUSINESS", is_custom=True, is_active=True, required=False, sort_order=950))
        seeded_db.add(ListCustomColumn(scope="LEDGER", column_key=f"extra:{key}", source_key=key,
                                      label="标记", field_type="TEXT"))
    seeded_db.commit()
    content = "订单号,入库时间,业务类型,标记\nDG0953,2026-10-17,代挂,待核对\n".encode()
    response = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                  files={"file": ("订单.csv", content, "text/csv")})
    assert response.status_code == 200, response.text
    assert any("重名" in error for error in response.json()["rows"][0]["errors"])


def test_parse_csv_uses_visible_export_columns_and_restores_escaped_text():
    content = "\ufeff订单号,入库时间,业务类型,游戏账号/产品,成本\r\nHS0001,2026-10-17,回收,'=example,100.00\r\n".encode()
    result = parse_order_import("订单.csv", content)
    assert result["main"].headers == ("订单号", "入库时间", "业务类型", "游戏账号/产品", "成本")
    assert result["main"].rows[0].row == 2
    assert result["main"].rows[0].values == ("HS0001", "2026-10-17", "回收", "=example", "100.00")


def test_parse_xlsx_reads_export_sheets_and_three_row_detail_header():
    workbook = Workbook()
    main = workbook.active
    main.title = "主订单信息"
    main.append(["订单号", "业务类型"])
    main.append(["HS0001", "回收"])
    detail = workbook.create_sheet("详情信息")
    detail.append(["订单标识", "订单信息"])
    detail.append([None, None])
    detail.append(["订单号", "订单备注"])
    detail.append(["HS0001", "历史备注"])
    events = workbook.create_sheet("操作明细")
    events.append(["订单号", "动作", "金额"])
    events.append(["HS0001", "买号", 100])
    continued = workbook.create_sheet("操作明细（10）")
    continued.append(["订单号", "动作", "金额"])
    continued.append(["HS0002", "售出", 200])
    output = BytesIO()
    workbook.save(output)
    result = parse_order_import("订单.xlsx", output.getvalue())
    assert result["main"].rows[0].values == ("HS0001", "回收")
    assert result["details"].headers == ("订单号", "订单备注")
    assert result["events"].rows[0].values == ("HS0001", "买号", "100")
    assert result["events"].rows[1].sheet == "操作明细（10）"
    assert result["events"].rows[1].values == ("HS0002", "售出", "200")


def test_parse_rejects_duplicate_headers_and_formula_cells():
    with pytest.raises(Validation, match="重复列名"):
        parse_order_import("订单.csv", "订单号,订单号\nHS0001,HS0002\n".encode())
    workbook = Workbook()
    workbook.active.title = "主订单信息"
    workbook.active.append(["订单号"])
    workbook.active.append(["=1+1"])
    output = BytesIO()
    workbook.save(output)
    with pytest.raises(Validation, match="公式"):
        parse_order_import("订单.xlsx", output.getvalue())


def test_parse_keeps_custom_column_named_like_internal_options():
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "主订单信息"
    sheet.append(["订单号", "__import_options_2__"])
    sheet.append(["HS0001", "客户填写的值"])
    output = BytesIO()
    workbook.save(output)

    table = parse_order_import("订单.xlsx", output.getvalue())["main"]
    assert table.headers == ("订单号", "__import_options_2__")
    assert table.rows[0].values == ("HS0001", "客户填写的值")


def test_template_preserves_custom_column_named_like_internal_options():
    columns = [{"key": "extra:custom", "label": "__import_options_6__", "is_visible": True}]
    workbook = load_workbook(BytesIO(build_order_import_template(columns, set(), operators=["admin"])))
    sheet = workbook["主订单信息"]
    headers = [cell.value for cell in sheet[1]]
    sheet.cell(2, headers.index("订单号") + 1, "HS0001")
    sheet.cell(2, headers.index("__import_options_6__") + 1, "客户填写的值")
    output = BytesIO()
    workbook.save(output)

    table = parse_order_import("模板.xlsx", output.getvalue())["main"]
    assert dict(zip(table.headers, table.rows[0].values))["__import_options_6__"] == "客户填写的值"


def test_import_processing_does_not_block_the_event_loop(monkeypatch):
    import asyncio
    import threading
    from starlette.datastructures import UploadFile
    from app.business.orders.importing import router as import_router

    async def exercise(handler):
        started = threading.Event()
        release = threading.Event()
        timed_out = []

        def slow_parse(_filename, _content):
            started.set()
            if not release.wait(timeout=3):
                timed_out.append(True)
            return {"parsed": True}

        monkeypatch.setattr(import_router, "parse_order_import", slow_parse)
        file = UploadFile(filename="订单.csv", file=BytesIO("订单号\n".encode()))
        task = asyncio.create_task(handler(file=file, existing="skip", sections=[], db=None, user=None))
        try:
            assert await asyncio.to_thread(started.wait, 3)
            release.set()
            assert await task == {"ok": True}
        finally:
            release.set()
            if not task.done():
                await task
        assert not timed_out
        assert file.file.closed

    monkeypatch.setattr(import_router, "preview_order_import", lambda *_args, **_kwargs: {"ok": True})
    monkeypatch.setattr(import_router, "execute_order_import", lambda *_args, **_kwargs: {"ok": True})
    asyncio.run(exercise(import_router.order_import_preview))
    asyncio.run(exercise(import_router.order_import_execute))


def test_parse_rejects_unsupported_or_excessively_large_files():
    with pytest.raises(Validation, match="格式"):
        parse_order_import("订单.txt", b"no")
    with pytest.raises(Validation, match="过大"):
        parse_order_import("订单.csv", b"x" * (10 * 1024 * 1024 + 1))


def test_csv_line_numbers_and_row_limit_include_multiline_fields(monkeypatch):
    content = '订单号,备注\nHS0001,"第一行\n第二行"\nHS0002,其他\n'.encode()
    result = parse_order_import("订单.csv", content)
    assert [row.row for row in result["main"].rows] == [2, 4]
    monkeypatch.setattr(parser, "MAX_ROWS", 1)
    with pytest.raises(Validation, match="行数过多"):
        parse_order_import("订单.csv", content)


def test_template_dropdowns_use_supported_values_and_current_authorized_pools(seeded_client, seeded_db, headers):
    from app.domain.foundation import Pool

    seeded_db.add(Pool(code="TEMPLATE_POOL", name="模板测试账户", pool_type="OTHER", status="ACTIVE"))
    seeded_db.commit()
    response = seeded_client.get("/api/order-imports/template.xlsx", params=[("sections", "events"), ("sections", "cashflows"), ("sections", "rebates")], headers=headers)
    assert response.status_code == 200
    workbook = load_workbook(BytesIO(response.content))
    assert "填写说明" not in workbook and "下拉选项" not in workbook
    for sheet, label, expected in [("主订单信息", "业务类型", "回收"), ("资金明细", "资金账户编码", "TEMPLATE_POOL"), ("返点明细", "返点类型", "买号返点"), ("操作明细", "动作", "运营")]:
        ws = workbook[sheet]
        index = next(cell.column for cell in ws[1] if cell.value == label)
        cell = ws.cell(row=2, column=index)
        validation = next(rule for rule in ws.data_validations.dataValidation if cell.coordinate in rule.sqref)
        reference = workbook.defined_names[validation.formula1].attr_text
        assert reference.startswith("'主订单信息'!")
        assert expected in [item.value for row in workbook["主订单信息"][reference.split("!")[1].replace("$", "")] for item in row]
    assert parse_order_import("模板.xlsx", response.content)["main"].rows == ()


def test_template_includes_visible_columns_required_identifiers_and_selected_details():
    columns = [
        {"key": "order_no", "label": "订单号", "is_visible": False},
        {"key": "cost_amount", "label": "成本", "is_visible": True},
        {"key": "inventory_operator", "label": "入库操作人", "is_visible": True},
        {"key": "extra:priority", "label": "优先级", "is_visible": True},
        {"key": "account_game_type", "label": "游戏/产品类型", "is_visible": False},
        {"key": "in_hand_time", "label": "在手时间", "is_visible": True},
        {"key": "actions", "label": "操作", "is_visible": True},
    ]
    content = build_order_import_template(columns, {"details", "events", "cashflows", "rebates"}, operators=["admin"], custom_choices={"优先级": ["示例选项"]})
    workbook = load_workbook(BytesIO(content))
    assert workbook.sheetnames == ["主订单信息", "详情信息", "操作明细", "资金明细", "返点明细"]
    headers = [cell.value for cell in workbook["主订单信息"][1]
               if not str(cell.value).startswith("__import_options_")]
    assert headers == ["库存编号", "订单号", "业务模式", "业务类型", "入库操作人", "回收价", "提号价", "优先级",
                       "入库时间", "售卖时间", "售卖操作人", "售出金额", "库存状态", "代挂利润"]
    assert parse_order_import("模板.xlsx", content)["main"].rows == ()
    secondary_col = next(cell.column for cell in workbook["详情信息"][3] if cell.value == "有无二次")
    assert any(workbook["详情信息"].cell(4, secondary_col).coordinate in rule.sqref for rule in workbook["详情信息"].data_validations.dataValidation)
    assert any(workbook["主订单信息"].cell(2, headers.index("优先级") + 1).coordinate in rule.sqref for rule in workbook["主订单信息"].data_validations.dataValidation)
    assert any(workbook["主订单信息"].cell(2, headers.index("入库操作人") + 1).coordinate in rule.sqref for rule in workbook["主订单信息"].data_validations.dataValidation)
    assert "订单号" in [cell.value for cell in workbook["操作明细"][1]]
    assert {"事件号", "运营动作", "运营详情(JSON)", "关联上架事件号"}.issubset({cell.value for cell in workbook["操作明细"][1]})
    assert "返点单号" in [cell.value for cell in workbook["返点明细"][1]]
    assert "资金账户编码" in [cell.value for cell in workbook["返点明细"][1]]
    assert {"流水号", "核算属性", "来源类型", "资金账户编码"}.issubset({cell.value for cell in workbook["资金明细"][1]})
    assert parse_order_import("模板.xlsx", content)["main"].headers == tuple(headers)


def test_template_includes_financial_import_columns_when_ledger_columns_are_hidden():
    content = build_order_import_template([], set())
    workbook = load_workbook(BytesIO(content))
    headers = {cell.value for cell in workbook["主订单信息"][1]}
    assert {"入库时间", "回收价", "提号价", "售卖时间", "售卖操作人", "售出金额", "代挂利润"} <= headers
    assert "利润" not in headers


def test_import_uses_actual_dates_for_elapsed_time(seeded_client, seeded_db, headers):
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="在手时间测试账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = (
        "库存编号,订单号,业务模式,业务类型,入库操作人,入库时间,回收价,提号价,售卖时间,售卖操作人,售出金额,代挂利润\n"
        "KU_00888,HS0988,自营,回收,admin,2026-10-01 08:30:00,100,,2026-10-03,admin,150,\n"
    ).encode()
    files = {"file": ("订单.csv", content, "text/csv")}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"}, files=files)
    assert preview.status_code == 200, preview.text
    assert preview.json()["rows"][0]["action"] == "create"
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"}, files=files)
    assert result.status_code == 200, result.text
    listed = seeded_client.get("/api/orders", headers=headers, params={"keyword": "HS0988"})
    assert listed.status_code == 200
    assert listed.json()["items"][0]["in_hand_time"] == "1天15小时30分"


def test_import_preserves_sale_clock_time_for_elapsed_time(seeded_client, seeded_db, headers):
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="精确售卖时间账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = (
        "库存编号,订单号,业务模式,业务类型,入库操作人,入库时间,回收价,提号价,售卖时间,售卖操作人,售出金额,代挂利润\n"
        "KU_00881,HS0981,自营,回收,admin,2026-10-01 08:30:00,0,,2026-10-01 14:35:45,admin,150,\n"
        "KU_00882,TH0982,分销,提号,admin,2026-10-01 08:30:00,,0,2026-10-01 08:30:00,admin,100,\n"
        "KU_00883,DG0983,分销,代挂,admin,2026-10-01 08:30:00,,,2026-10-01 09:30:00,admin,100,0\n"
    ).encode()
    files = {"file": ("订单.csv", content, "text/csv")}
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"}, files=files)
    assert result.status_code == 200, result.text
    listed = seeded_client.get("/api/orders", headers=headers, params={"limit": 500})
    assert listed.status_code == 200
    orders = {item["order_no"]: item for item in listed.json()["items"]}
    assert (orders["HS0981"]["sale_at"], orders["HS0981"]["in_hand_time"]) == ("2026-10-01T14:35:45", "6小时5分")
    assert (orders["TH0982"]["sale_at"], orders["TH0982"]["in_hand_time"]) == ("2026-10-01T08:30:00", "0分")
    assert (orders["DG0983"]["sale_at"], orders["DG0983"]["in_hand_time"]) == ("2026-10-01T09:30:00", "1小时")

    from datetime import date
    from sqlalchemy import select
    from app.business.orders.mutations import update_order
    from app.domain.trade import Order

    order = seeded_db.scalar(select(Order).where(Order.order_no == "HS0981"))
    update_order(seeded_db, order.id, actor="pytest", trade_date=date(2026, 10, 2))
    seeded_db.commit()
    shifted = seeded_client.get("/api/orders", headers=headers, params={"keyword": "HS0981"})
    assert shifted.json()["items"][0]["sale_at"] == "2026-10-02T14:35:45"


def test_editing_imported_sale_time_updates_order_elapsed_time(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order, OrderEvent
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="修改售卖时间账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = (
        "库存编号,订单号,业务类型,入库操作人,入库时间,回收价,售卖时间,售出金额\n"
        "KU_00884,HS0984,回收,admin,2026-10-01 08:30:00,100,2026-10-01 14:35:00,150\n"
    ).encode()
    imported = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                  files={"file": ("订单.csv", content, "text/csv")})
    assert imported.status_code == 200, imported.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "HS0984"))
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL"))
    edited = seeded_client.patch(f"/api/orders/{order.id}/execution-edit", headers=headers, json={"events": [{
        "id": event.id, "expected_amount": "150", "amount": "150", "occurred_at": "2026-10-02T15:10:00",
    }]})
    assert edited.status_code == 200, edited.text
    listed = seeded_client.get("/api/orders", headers=headers, params={"keyword": "HS0984"})
    item = listed.json()["items"][0]
    assert (item["sale_at"], item["in_hand_time"]) == ("2026-10-02T15:10:00", "1天6小时40分")


def test_default_template_is_one_sheet_and_long_operator_dropdown_does_not_create_orders():
    operators = [f"operator_{index:03d}" for index in range(80)]
    content = build_order_import_template([], set(), operators=operators)
    workbook = load_workbook(BytesIO(content))
    assert workbook.sheetnames == ["主订单信息"]
    sheet = workbook.active
    header = [cell.value for cell in sheet[1]]
    operator_cell = sheet.cell(2, header.index("入库操作人") + 1)
    validation = next(rule for rule in sheet.data_validations.dataValidation if operator_cell.coordinate in rule.sqref)
    reference = workbook.defined_names[validation.formula1].attr_text
    sheet_name, address = reference.rsplit("!", 1)
    assert sheet_name.strip("'") == "主订单信息"
    choices = [cell.value for row in sheet[address.replace("$", "")] for cell in row]
    assert choices == operators
    assert sheet.column_dimensions[sheet[address.replace("$", "")][0][0].column_letter].hidden
    table = parse_order_import("模板.xlsx", content)["main"]
    assert table.rows == ()
    assert all(not label.startswith("__import_options_") for label in table.headers)
    sheet.cell(2, header.index("订单号") + 1, "HS0001")
    output = BytesIO()
    workbook.save(output)
    filled = parse_order_import("模板.xlsx", output.getvalue())["main"]
    assert len(filled.rows) == 1
    assert dict(zip(filled.headers, filled.rows[0].values))["订单号"] == "HS0001"

def test_template_places_inventory_and_business_columns():
    columns = [
        {"key": "stock_no", "label": "库存编号", "is_visible": True},
        {"key": "account_status", "label": "库存状态", "is_visible": True},
        {"key": "business_mode", "label": "业务", "is_visible": True},
    ]
    workbook = load_workbook(BytesIO(build_order_import_template(columns, set())))
    headers = [cell.value for cell in workbook["主订单信息"][1]]
    assert headers[:4] == ["库存编号", "订单号", "业务模式", "业务类型"]
    assert headers.count("库存编号") == headers.count("库存状态") == headers.count("业务模式") == 1
    assert headers.index("库存状态") < headers.index("代挂利润")


def test_template_and_preview_api_are_read_only_and_follow_duplicate_choice(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import func, select
    from app.business.orders.create import create_order
    from app.domain.trade import Order

    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest")
    seeded_db.commit()
    template = seeded_client.get("/api/order-imports/template.xlsx", params=[("sections", "events"), ("sections", "rebates")], headers=headers)
    assert template.status_code == 200, template.text
    assert load_workbook(BytesIO(template.content)).sheetnames == ["主订单信息", "操作明细", "返点明细"]
    content = f"订单号,入库时间,业务类型,成本\n{order.order_no},2026-10-17,回收,100\nHS9998,2026-10-18,回收,200\n".encode()
    count = seeded_db.scalar(select(func.count()).select_from(Order))
    for choice, expected in (("skip", "skip"), ("update", "update")):
        preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": choice}, files={"file": ("订单.csv", content, "text/csv")})
        assert preview.status_code == 200, preview.text
        body = preview.json()
        assert [(row["order_no"], row["action"]) for row in body["rows"]] == [(order.order_no, expected if choice == "skip" else "error"), ("HS9998", "error")]
        assert any("成本" in warning for warning in body["rows"][1]["warnings"])
        assert any("成本" in error for error in body["rows"][1]["errors"])
        assert seeded_db.scalar(select(func.count()).select_from(Order)) == count


def test_preview_accepts_inventory_date_and_denies_read_only_user(seeded_client, headers):
    content = "订单号,入库时间,业务类型\nHS9998,2026-10-17,回收\n".encode()
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"}, files={"file": ("订单.csv", content, "text/csv")})
    assert preview.status_code == 200, preview.text
    row = preview.json()["rows"][0]
    assert row["action"] == "create" and not row["errors"]
    denied = seeded_client.post("/api/order-imports/preview", headers={"X-Dev-User": "viewer"}, data={"existing": "skip"}, files={"file": ("订单.csv", content, "text/csv")})
    assert denied.status_code == 403


def test_preview_finds_duplicate_orders_invalid_dates_and_orphan_detail_rows(seeded_client, headers):
    workbook = Workbook()
    main = workbook.active
    main.title = "主订单信息"
    main.append(["订单号", "入库时间", "业务类型"])
    main.append(["HS0001", "2026-10-17", "回收"])
    main.append(["HS0001", "2026-10-17", "回收"])
    main.append(["TH0010", "2026-10-17oops", "代挂"])
    events = workbook.create_sheet("操作明细")
    events.append(["订单号", "动作"])
    events.append(["DG0009", "上架"])
    output = BytesIO()
    workbook.save(output)
    result = seeded_client.post(
        "/api/order-imports/preview", headers=headers,
        data={"existing": "skip", "sections": "events"},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert result.status_code == 200, result.text
    body = result.json()
    assert all(row["action"] == "error" for row in body["rows"])
    assert "重复" in body["rows"][0]["errors"][0]
    assert any("入库时间" in error for error in body["rows"][2]["errors"])
    assert any("业务类型" in error for error in body["rows"][2]["errors"])
    assert body["detail_errors"][0]["sheet"] == "操作明细"
    assert "主订单" in body["detail_errors"][0]["message"]


def test_preview_rejects_selected_detail_without_corresponding_data(seeded_client, headers):
    content = "订单号,入库时间,业务类型\nHS9998,2026-10-17,回收\n".encode()
    result = seeded_client.post(
        "/api/order-imports/preview", headers=headers,
        data={"existing": "skip", "sections": "rebates"},
        files={"file": ("订单.csv", content, "text/csv")},
    )
    assert result.status_code == 200, result.text
    assert "返点" in result.json()["detail_errors"][0]["message"]


def test_preview_reports_unsupported_detail_and_event_before_any_write(seeded_client, seeded_db, headers):
    from sqlalchemy import func, select
    from app.domain.trade import Order
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "入库时间", "业务类型"])
    main.append(["DG0987", "2026-10-17", "代挂"])
    detail = book.create_sheet("详情信息")
    detail.append(["订单标识", "账号详情"])
    detail.append([None, None])
    detail.append(["订单号", "账号图片"])
    detail.append(["DG0987", "2张"])
    event = book.create_sheet("操作明细")
    event.append(["订单号", "事件号", "动作"])
    event.append(["DG0987", "DG0987-EV-UNKNOWN-01", "未知动作"])
    output = BytesIO()
    book.save(output)
    before = seeded_db.scalar(select(func.count()).select_from(Order))
    response = seeded_client.post("/api/order-imports/preview", headers=headers,
        data={"existing": "skip", "sections": ["details", "events"]},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 200, response.text
    errors = response.json()["detail_errors"]
    assert any("账号图片" in error["message"] for error in errors)
    assert any("操作类型" in error["message"] for error in errors)
    assert seeded_db.scalar(select(func.count()).select_from(Order)) == before


def test_import_preserves_required_business_operator_instead_of_guessing(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order, OrderFormField
    from app.domain.users import User
    from app.settings.field_definitions.catalog_seed import seed_business_responsible_fields
    seed_business_responsible_fields(seeded_db, actor="pytest")
    seeded_db.flush()
    field = seeded_db.scalar(select(OrderFormField).where(OrderFormField.order_type_code == "DG",
                                                          OrderFormField.field_key == "business_responsible_ids"))
    field.is_active = True
    field.required = True
    user = seeded_db.scalar(select(User).where(User.username == "admin"))
    seeded_db.commit()
    def submit(path, operator):
        content = f"订单号,入库时间,业务类型,入库操作人\nDG0982,2026-10-17,代挂,{operator}\n".encode()
        return seeded_client.post(f"/api/order-imports/{path}", headers=headers, data={"existing": "skip"},
                                  files={"file": ("订单.csv", content, "text/csv")})
    missing = submit("preview", "")
    assert missing.status_code == 200
    assert any("操作人" in error for error in missing.json()["rows"][0]["errors"])
    response = submit("execute", user.username)
    assert response.status_code == 200, response.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0982"))
    assert order.form_extra["business_responsible_ids"] == [user.id]


def test_import_maps_inventory_operators_to_each_order_type(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order
    from app.domain.users import User
    from app.settings.field_definitions.catalog_seed import seed_business_responsible_fields

    seed_business_responsible_fields(seeded_db, actor="pytest")
    first = seeded_db.scalar(select(User).where(User.username == "admin"))
    second = User(username="import_employee", display_name="导入员工", password_hash="test", role="OPERATOR")
    seeded_db.add(second)
    seeded_db.commit()
    content = (
        "订单号,入库时间,业务类型,入库操作人\n"
        "HS0983,2026-10-17,回收,admin、导入员工\n"
        "TH0983,2026-10-17,提号,admin、导入员工\n"
        "DG0983,2026-10-17,代挂,admin、导入员工\n"
    ).encode()
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                  files={"file": ("订单.csv", content, "text/csv")})
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 3
    orders = seeded_db.scalars(select(Order).where(Order.order_no.in_(["HS0983", "TH0983", "DG0983"]))).all()
    assert len(orders) == 3
    assert all(order.form_extra["business_responsible_ids"] == [first.id, second.id] for order in orders)


@pytest.mark.parametrize("value", ["原操作人", ""])
@pytest.mark.parametrize("existing", ["skip", "update"])
def test_import_rejects_old_business_operator_column(seeded_client, seeded_db, headers, value, existing):
    content = (
        "订单号,入库时间,业务类型,业务操作人,入库操作人\n"
        f"DG0984,2026-10-17,代挂,{value},admin\n"
    ).encode()
    response = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": existing},
                                  files={"file": ("订单.csv", content, "text/csv")})
    assert response.status_code == 200, response.text
    assert response.json()["rows"][0]["action"] == "error"
    assert any("业务操作人" in error for error in response.json()["rows"][0]["errors"])


@pytest.mark.parametrize("value", ["9999天", ""])
@pytest.mark.parametrize("existing", ["skip", "update"])
def test_import_rejects_legacy_elapsed_time_column(seeded_client, headers, value, existing):
    content = (
        "订单号,入库时间,业务类型,入库操作人,在手时间\n"
        f"DG0984,2026-10-17,代挂,admin,{value}\n"
    ).encode()
    response = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": existing},
                                  files={"file": ("订单.csv", content, "text/csv")})
    assert response.status_code == 200, response.text
    assert response.json()["rows"][0]["action"] == "error"
    assert any("在手时间" in error for error in response.json()["rows"][0]["errors"])


@pytest.mark.parametrize("value", ["", "30"])
def test_new_order_import_rejects_legacy_profit_column(seeded_client, headers, value):
    content = (
        "订单号,入库时间,业务类型,入库操作人,利润\n"
        f"DG0984,2026-10-17,代挂,admin,{value}\n"
    ).encode()
    response = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                  files={"file": ("订单.csv", content, "text/csv")})
    assert response.status_code == 200, response.text
    row = response.json()["rows"][0]
    assert row["action"] == "error"
    assert any("利润" in error for error in row["errors"])


def test_consignment_profit_column_rejects_non_consignment_rows(seeded_client, seeded_db, headers):
    from sqlalchemy import func, select
    from app.domain.trade import Order
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="代挂利润测试账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = (
        "订单号,业务类型,入库操作人,入库时间,回收价,提号价,代挂利润\n"
        "HS0985,回收,admin,2026-10-01,100,,30\n"
        "TH0985,提号,admin,2026-10-01,,100,30\n"
    ).encode()
    files = {"file": ("订单.csv", content, "text/csv")}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"}, files=files)
    assert preview.status_code == 200, preview.text
    assert all(row["action"] == "error" and any("代挂利润" in error for error in row["errors"])
               for row in preview.json()["rows"])
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"}, files=files)
    assert result.status_code == 422
    assert seeded_db.scalar(select(func.count()).select_from(Order)) == 0


def test_import_generates_historical_cashflows_with_default_pool(seeded_client, seeded_db, headers):
    from datetime import date
    from decimal import Decimal
    from sqlalchemy import func, select
    from app.domain.trade import Cashflow, Order, OrderEvent
    from app.settings.field_definitions.pools import create_pool
    from app.shared.order_amounts import order_cashflow_profit_by_order

    pool = create_pool(seeded_db, name="历史导入默认账户", actor="pytest", is_default=True)
    create_pool(seeded_db, name="其他账户", actor="pytest")
    seeded_db.commit()
    content = (
        "订单号,业务类型,入库操作人,入库时间,回收价,提号价,售卖时间,售卖操作人,售出金额,代挂利润\n"
        "HS0985,回收,admin,2026-10-01,100,,2026-10-03,admin,150,\n"
        "TH0985,提号,admin,2026-10-02,,200,2026-10-04,admin,280,\n"
        "DG0985,代挂,admin,2026-10-03,0,0,2026-10-05,admin,1000,30\n"
    ).encode()
    data = {"existing": "skip"}
    files = {"file": ("订单.csv", content, "text/csv")}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data=data, files=files)
    assert preview.status_code == 200, preview.text
    assert [row["action"] for row in preview.json()["rows"]] == ["create"] * 3
    assert all(row["warnings"] for row in preview.json()["rows"])
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data=data, files=files)
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 3
    assert response.json()["events_created"] == 5
    assert response.json()["cashflows_created"] == 5

    orders = {order.order_no: order for order in seeded_db.scalars(select(Order).where(
        Order.order_no.in_(["HS0985", "TH0985", "DG0985"]))).all()}
    assert set(orders) == {"HS0985", "TH0985", "DG0985"}
    assert all(order.account_id is None and order.status == "COMPLETED" for order in orders.values())
    profits = order_cashflow_profit_by_order(seeded_db, order_ids=[item.id for item in orders.values()])
    assert {number: profits[order.id] for number, order in orders.items()} == {
        "HS0985": Decimal("50"), "TH0985": Decimal("80"), "DG0985": Decimal("30"),
    }
    actual = {}
    attributes = {}
    for number, order in orders.items():
        flows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()
        assert all(flow.pool_id == pool.id for flow in flows)
        actual[number] = sorted((flow.direction, flow.amount, flow.occurred_on) for flow in flows)
        attributes[number] = {flow.accounting_attribute for flow in flows}
    assert actual == {
        "HS0985": sorted([("OUT", Decimal("100"), date(2026, 10, 1)), ("IN", Decimal("150"), date(2026, 10, 3))]),
        "TH0985": sorted([("OUT", Decimal("200"), date(2026, 10, 2)), ("IN", Decimal("280"), date(2026, 10, 4))]),
        "DG0985": [("IN", Decimal("30"), date(2026, 10, 5))],
    }
    assert attributes == {
        "HS0985": {"SELF_DIRECT_COST", "SELF_REVENUE"},
        "TH0985": {"TH_DIRECT_COST", "TH_REVENUE"},
        "DG0985": {"DG_REVENUE"},
    }
    dg_sale = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == orders["DG0985"].id,
                                                       OrderEvent.event_type == "SELL"))
    assert dg_sale.amount == Decimal("1000")
    dg_flow = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == orders["DG0985"].id))
    assert dg_flow.source_type == "ORDER_EVENT" and dg_flow.source_id == dg_sale.event_no
    assert seeded_db.scalar(select(func.count()).select_from(Cashflow)) == 5
    repeated = seeded_client.post("/api/order-imports/execute", headers=headers, data=data, files=files)
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["skipped"] == 3 and repeated.json()["cashflows_created"] == 0
    assert seeded_db.scalar(select(func.count()).select_from(Cashflow)) == 5
    updated = seeded_client.post("/api/order-imports/execute", headers=headers,
                                 data={"existing": "update"}, files=files)
    assert updated.status_code == 422
    assert seeded_db.scalar(select(func.count()).select_from(Cashflow)) == 5


def test_historical_finance_preview_rejects_invalid_rows_without_writes(seeded_client, seeded_db, headers):
    from sqlalchemy import func, select
    from app.domain.trade import Cashflow, Order
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="核验默认账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = (
        "订单号,业务类型,入库操作人,入库时间,回收价,提号价,售卖时间,售卖操作人,售出金额,代挂利润\n"
        "HS0961,回收,admin,2026-10-01,100,,2026-10-03,admin,150,\n"
        "HS0962,回收,admin,2026-10-03,100,,2026-10-01,admin,150,\n"
        "TH0962,提号,admin,2026-10-01,20,200,2026-10-03,admin,280,\n"
        "DG0962,代挂,admin,2026-10-01,0,0,2026-10-03,admin,500,-10\n"
        "HS0963,回收,admin,2026-10-01,100,,2026-10-03,不存在的员工,150,\n"
    ).encode()
    data = {"existing": "skip"}
    files = {"file": ("订单.csv", content, "text/csv")}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data=data, files=files)
    assert preview.status_code == 200, preview.text
    rows = preview.json()["rows"]
    assert [row["action"] for row in rows] == ["create", "error", "error", "error", "error"]
    assert any("早于入库" in error for error in rows[1]["errors"])
    assert any("提号价" in error for error in rows[2]["errors"])
    assert any("代挂" in error for error in rows[3]["errors"])
    assert any("操作人" in error for error in rows[4]["errors"])
    before = seeded_db.scalar(select(func.count()).select_from(Cashflow))
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data=data, files=files)
    assert result.status_code == 422
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "HS0961")) is None
    assert seeded_db.scalar(select(func.count()).select_from(Cashflow)) == before


def test_historical_import_handles_zero_cost_and_unsold_orders(seeded_client, seeded_db, headers):
    from decimal import Decimal
    from sqlalchemy import select
    from app.domain.trade import Cashflow, Order
    from app.settings.field_definitions.pools import create_pool
    from app.shared.order_amounts import order_cashflow_profit_by_order

    create_pool(seeded_db, name="零成本默认账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = (
        "订单号,业务类型,入库操作人,入库时间,回收价,提号价,售卖时间,售卖操作人,售出金额,代挂利润\n"
        "HS0964,回收,admin,2026-10-01,0,,2026-10-03,admin,100,\n"
        "HS0965,回收,admin,2026-10-01,45,,,,,\n"
    ).encode()
    result = seeded_client.post("/api/order-imports/execute", headers=headers,
                                data={"existing": "skip"}, files={"file": ("订单.csv", content, "text/csv")})
    assert result.status_code == 200, result.text
    sold = seeded_db.scalar(select(Order).where(Order.order_no == "HS0964"))
    unsold = seeded_db.scalar(select(Order).where(Order.order_no == "HS0965"))
    assert sold.status == "COMPLETED" and unsold.status == "ACTIVE"
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[sold.id, unsold.id]) == {
        sold.id: Decimal("100"), unsold.id: Decimal("-45"),
    }
    unsold_flows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == unsold.id)).all()
    assert [(flow.direction, flow.amount) for flow in unsold_flows] == [("OUT", Decimal("45"))]


def test_historical_import_verifies_order_status_against_sale(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="状态核验默认账户", actor="pytest", is_default=True)
    seeded_db.commit()
    header = "订单号,业务类型,入库操作人,入库时间,回收价,售卖时间,售卖操作人,售出金额,代挂利润,订单状态\n"
    good = (header + "HS0968,回收,admin,2026-10-01,100,2026-10-03,admin,150,,已完成\n"
                     "HS0969,回收,admin,2026-10-01,45,,,,,进行中\n").encode()
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                files={"file": ("订单.csv", good, "text/csv")})
    assert result.status_code == 200, result.text
    statuses = dict(seeded_db.execute(select(Order.order_no, Order.status).where(
        Order.order_no.in_(["HS0968", "HS0969"]))).all())
    assert statuses == {"HS0968": "COMPLETED", "HS0969": "ACTIVE"}
    bad = (header + "HS0970,回收,admin,2026-10-01,100,2026-10-03,admin,150,,进行中\n").encode()
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                 files={"file": ("订单.csv", bad, "text/csv")})
    assert preview.status_code == 200
    assert any("订单状态" in error for error in preview.json()["rows"][0]["errors"])


def test_historical_inventory_is_created_and_business_references_are_audited(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.foundation import AuditLog
    from app.domain.trade import Account, Order
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="历史业务核验账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = (
        "库存编号,订单号,业务模式,业务类型,入库操作人,入库时间,回收价,提号价,售卖时间,售卖操作人,售出金额,库存状态,代挂利润\n"
        "KU_00123,TH0972,分销,提号,admin,2026-10-01,,100,2026-10-03,admin,150,已售,\n"
    ).encode()
    files = {"file": ("订单.csv", content, "text/csv")}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"}, files=files)
    assert preview.status_code == 200, preview.text
    row = preview.json()["rows"][0]
    assert row["action"] == "create" and any("库存" in warning for warning in row["warnings"])
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"}, files=files)
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "TH0972"))
    account = seeded_db.get(Account, order.account_id)
    assert (account.stock_no, account.business_mode, account.inventory_type) == ("KU_00123", "DISTRIBUTION", "PICKUP")
    assert (account.status, account.inventory_status, account.game_account) == ("SOLD", "OUT_OF_STOCK", None)
    assert account.cost_amount == 100
    assert account.inventory_entry_at.isoformat() == "2026-10-01T00:00:00"
    listed = seeded_client.get("/api/orders", headers=headers, params={"keyword": "TH0972"})
    assert listed.status_code == 200
    assert listed.json()["items"][0]["business_operator"] == "admin"
    audit = seeded_db.scalar(select(AuditLog).where(AuditLog.entity_type == "order", AuditLog.entity_id == "TH0972",
                                                    AuditLog.action == "ORDER_CREATE"))
    assert audit.after_json["historical_import_reference"] == {
        "库存编号": "KU_00123", "业务模式": "分销", "库存状态": "已售",
    }
    inconsistent = content.replace(b"TH0972", b"TH0973").replace("已售,".encode(), "在库,".encode())
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                 files={"file": ("订单.csv", inconsistent, "text/csv")})
    assert preview.status_code == 200
    assert any("库存状态" in error for error in preview.json()["rows"][0]["errors"])
    wrong_mode = content.replace(b"TH0972", b"TH0974").replace("分销,提号".encode(), "自营,提号".encode())
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                 files={"file": ("订单.csv", wrong_mode, "text/csv")})
    assert preview.status_code == 200
    assert any("业务模式" in error for error in preview.json()["rows"][0]["errors"])


def test_historical_inventory_state_is_derived_from_sale_and_preserves_entry_time(seeded_client, seeded_db, headers):
    from datetime import datetime
    from sqlalchemy import select
    from app.domain.trade import Account, Order
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="库存状态测试账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = (
        "库存编号,订单号,业务模式,业务类型,入库操作人,入库时间,回收价,提号价,游戏账号/产品,售卖时间,售卖操作人,售出金额,库存状态,代挂利润\n"
        "KU_00321,HS0971,自营,回收,admin,2026-10-02 08:30:00,100,,在库账号,,,,,\n"
        "KU_00322,DG0971,分销,代挂,admin,2026-10-02 09:45:00,0,0,,2026-10-03,admin,100,,20\n"
    ).encode()
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                files={"file": ("订单.csv", content, "text/csv")})
    assert result.status_code == 200, result.text
    orders = {item.order_no: item for item in seeded_db.scalars(select(Order).where(Order.order_no.in_(["HS0971", "DG0971"]))).all()}
    hs, dg = (seeded_db.get(Account, orders[number].account_id) for number in ("HS0971", "DG0971"))
    assert (hs.status, hs.inventory_status, hs.inventory_entry_at, hs.cost_amount) == ("WAITING", "IN_STOCK", datetime(2026, 10, 2, 8, 30), 100)
    assert (dg.status, dg.inventory_status, dg.inventory_entry_at, dg.cost_amount) == ("SOLD", "OUT_OF_STOCK", datetime(2026, 10, 2, 9, 45), 0)
    assert dg.game_account is None


def test_add_inventory_to_existing_orders_without_recreating_financial_records(seeded_client, seeded_db, headers):
    from decimal import Decimal
    from sqlalchemy import func, select
    from app.domain.trade import Account, Cashflow, Order, OrderEvent
    from app.settings.field_definitions.pools import create_pool
    from app.shared.order_amounts import order_cashflow_profit_by_order

    create_pool(seeded_db, name="补库存测试账户", actor="pytest", is_default=True)
    seeded_db.commit()
    data = ("订单号,业务模式,业务类型,入库操作人,入库时间,回收价,提号价,售卖时间,售卖操作人,售出金额,代挂利润\n"
            "TH0976,分销,提号,admin,2026-10-01,,100,2026-10-03,admin,150,\n").encode()
    assert seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                              files={"file": ("订单.csv", data, "text/csv")}).status_code == 200
    order = seeded_db.scalar(select(Order).where(Order.order_no == "TH0976"))
    assert order.account_id is None
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id] == Decimal("50")
    events_before = seeded_db.scalar(select(func.count()).select_from(OrderEvent))
    flows_before = seeded_db.scalar(select(func.count()).select_from(Cashflow))
    enriched = data.replace("订单号,".encode(), "库存编号,订单号,".encode(), 1).replace(b"TH0976,", b"KU_00421,TH0976,", 1)
    files = {"file": ("订单.csv", enriched, "text/csv")}
    changed = enriched.replace(b",150,", b",151,")
    mismatch = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "inventory"},
                                  files={"file": ("订单.csv", changed, "text/csv")})
    assert mismatch.status_code == 200
    assert any("事件与原表不一致" in error for error in mismatch.json()["rows"][0]["errors"])
    assert order.account_id is None
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "inventory"}, files=files)
    assert preview.status_code == 200, preview.text
    assert preview.json()["rows"][0]["action"] == "inventory"
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "inventory"}, files=files)
    assert result.status_code == 200, result.text
    assert result.json()["inventories_created"] == 1
    seeded_db.refresh(order)
    account = seeded_db.get(Account, order.account_id)
    assert (account.stock_no, account.status, account.inventory_status, account.cost_amount) == ("KU_00421", "SOLD", "OUT_OF_STOCK", 100)
    assert seeded_db.scalar(select(func.count()).select_from(OrderEvent)) == events_before
    assert seeded_db.scalar(select(func.count()).select_from(Cashflow)) == flows_before
    repeat = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "inventory"}, files=files)
    assert repeat.status_code == 200, repeat.text
    assert repeat.json()["inventories_created"] == 0 and repeat.json()["skipped"] == 1


def test_inventory_import_rejects_duplicate_stock_numbers_before_any_writes(seeded_client, seeded_db, headers):
    from sqlalchemy import func, select
    from app.domain.trade import Account
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="库存编号冲突账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = ("库存编号,订单号,业务模式,业务类型,入库操作人,入库时间,回收价,提号价\n"
               "KU_00333,HS0977,自营,回收,admin,2026-10-01,100,\n"
               "KU_00333,TH0977,分销,提号,admin,2026-10-01,,200\n").encode()
    files = {"file": ("订单.csv", content, "text/csv")}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"}, files=files)
    assert preview.status_code == 200
    assert all(any("库存编号" in error for error in row["errors"]) for row in preview.json()["rows"])
    execute = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"}, files=files)
    assert execute.status_code == 422
    assert seeded_db.scalar(select(func.count()).select_from(Account)) == 0


def test_inventory_import_rejects_duplicate_unsold_game_accounts(seeded_client, seeded_db, headers):
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="重复在库账号测试账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = ("库存编号,订单号,业务模式,业务类型,入库操作人,入库时间,回收价,提号价,游戏账号/产品\n"
               "KU_00334,HS0978,自营,回收,admin,2026-10-01,100,,相同账号\n"
               "KU_00335,TH0978,分销,提号,admin,2026-10-01,,200,相同账号\n").encode()
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                 files={"file": ("订单.csv", content, "text/csv")})
    assert preview.status_code == 200
    assert all(any("账号" in error and "在库" in error for error in row["errors"]) for row in preview.json()["rows"])


def test_inventory_import_rejects_an_account_already_in_stock(seeded_client, seeded_db, headers):
    from app.business.inventory.profile import create_account
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="已有库存测试账户", actor="pytest", is_default=True)
    create_account(seeded_db, game_account="已有未售账号", actor="pytest", business_mode="SELF", inventory_type="RECOVERY")
    seeded_db.commit()
    content = ("库存编号,订单号,业务模式,业务类型,入库操作人,入库时间,回收价,提号价,游戏账号/产品\n"
               "KU_00999,HS0979,自营,回收,admin,2026-10-01,100,,已有未售账号\n").encode()
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                 files={"file": ("订单.csv", content, "text/csv")})
    assert preview.status_code == 200
    assert any("账号" in error and "在库" in error for error in preview.json()["rows"][0]["errors"])


def test_historical_main_amounts_cannot_be_imported_with_cashflow_details(seeded_client, seeded_db, headers):
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="重复导入防护账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = ("订单号,业务类型,入库操作人,入库时间,回收价\n"
               "HS0966,回收,admin,2026-10-01,100\n").encode()
    preview = seeded_client.post("/api/order-imports/preview", headers=headers,
                                 data={"existing": "skip", "sections": ["cashflows"]},
                                 files={"file": ("订单.csv", content, "text/csv")})
    assert preview.status_code == 200, preview.text
    assert any("不能与操作、资金或返点明细同时导入" in e for e in preview.json()["rows"][0]["errors"])


def test_historical_preview_reports_missing_price_and_missing_default_pool(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.foundation import Pool
    from app.settings.field_definitions.pools import create_pool

    for pool in seeded_db.scalars(select(Pool)).all():
        pool.is_default = False
    create_pool(seeded_db, name="无默认账户一", actor="pytest")
    create_pool(seeded_db, name="无默认账户二", actor="pytest")
    seeded_db.commit()
    content = (
        "订单号,业务类型,入库操作人,入库时间,回收价,提号价\n"
        "HS0967,回收,admin,2026-10-01,,\n"
        "TH0967,提号,admin,2026-10-01,,50\n"
    ).encode()
    preview = seeded_client.post("/api/order-imports/preview", headers=headers,
                                 data={"existing": "skip"}, files={"file": ("订单.csv", content, "text/csv")})
    assert preview.status_code == 200, preview.text
    first, second = preview.json()["rows"]
    assert first["action"] == "error" and any("回收价" in e for e in first["errors"])
    assert second["action"] == "error" and any("默认资金账户" in e for e in second["errors"])


@pytest.mark.parametrize(("actor", "message"), [
    ("employee", "无权登记订单资金流水"),
    ("operator", "无权使用默认资金账户"),
])
def test_historical_import_checks_posting_and_pool_permissions(seeded_client, seeded_db, actor, message):
    from sqlalchemy import select
    from app.domain.trade import Order
    from app.settings.field_definitions.pools import create_pool

    create_pool(seeded_db, name="权限校验默认账户", actor="pytest", is_default=True)
    seeded_db.commit()
    content = ("订单号,业务类型,入库操作人,入库时间,回收价\n"
               "HS0971,回收,admin,2026-10-01,100\n").encode()
    files = {"file": ("订单.csv", content, "text/csv")}
    headers = {"X-Dev-User": actor}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"}, files=files)
    assert preview.status_code == 200, preview.text
    assert any(message in error for error in preview.json()["rows"][0]["errors"])
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"}, files=files)
    assert result.status_code == 422
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "HS0971")) is None


def test_import_operator_with_separator_matches_full_name_once(seeded_db):
    from sqlalchemy import event
    from app.business.orders.importing.events import _operators
    from app.domain.users import User

    employee = User(username="import-employee", display_name="甲、乙", password_hash="test", role="OPERATOR")
    seeded_db.add(employee)
    seeded_db.flush()
    queries = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        if statement.lstrip().lower().startswith("select"):
            queries.append(statement)

    event.listen(seeded_db.get_bind(), "before_cursor_execute", capture)
    try:
        result = _operators(seeded_db, "甲、乙", {"sheet": "主订单信息", "row": 2})
    finally:
        event.remove(seeded_db.get_bind(), "before_cursor_execute", capture)

    assert result == [employee.id]
    assert len(queries) <= 2


def test_operator_lookup_does_not_load_unrelated_employees(seeded_db):
    from sqlalchemy import event
    from app.business.orders.importing.events import _operators
    from app.domain.users import User

    employee = User(username="import-target", display_name="目标员工", password_hash="unused", role="OPERATOR")
    seeded_db.add(employee)
    seeded_db.add_all(User(username=f"import-other-{index}", display_name=f"其他员工{index}",
                           password_hash="unused", role="OPERATOR") for index in range(30))
    seeded_db.flush()
    row_counts = []

    def capture(_conn, cursor, statement, _params, _context, _many):
        sql = " ".join(statement.lower().split())
        if sql.startswith("select users.id, users.username, users.display_name") and "from users" in sql:
            row_counts.append(cursor.rowcount)

    event.listen(seeded_db.get_bind(), "after_cursor_execute", capture)
    try:
        result = _operators(seeded_db, "目标员工", {"sheet": "主订单信息", "row": 2})
    finally:
        event.remove(seeded_db.get_bind(), "after_cursor_execute", capture)
    assert result == [employee.id]
    assert row_counts == [1]


def test_preview_reuses_repeated_reference_checks_and_refreshes_between_requests(seeded_client, seeded_db, headers):
    from sqlalchemy import event, select
    from app.domain.users import User
    from app.settings.field_definitions.game_types import create_game_type

    game = create_game_type(seeded_db, name="批量导入游戏", channel_regions=[], actor="pytest")
    username = seeded_db.scalar(select(User.username).where(User.username == "admin"))
    seeded_db.commit()
    statements = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        if statement.lstrip().lower().startswith("select"):
            statements.append(statement)

    def preview(copies):
        rows = []
        for index in range(copies):
            for offset, (operator, game_name) in enumerate(((username, "批量导入游戏"), ("不存在的员工", "批量导入游戏"), (username, "不存在的游戏"))):
                number = 9001 + index * 3 + offset
                rows.append(f"DG{number:04d},2026-10-17,代挂,{operator},账号,{game_name}")
        content = ("订单号,入库时间,业务类型,入库操作人,游戏账号/产品,游戏/产品类型\n" + "\n".join(rows) + "\n").encode()
        response = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                      files={"file": ("订单.csv", content, "text/csv")})
        assert response.status_code == 200, response.text
        return response.json()["rows"]

    event.listen(seeded_db.get_bind(), "before_cursor_execute", capture)
    try:
        first = preview(1)
        first_count = len(statements)
        statements.clear()
        many = preview(10)
        many_count = len(statements)
    finally:
        event.remove(seeded_db.get_bind(), "before_cursor_execute", capture)

    assert [row["action"] for row in first] == ["create", "error", "error"]
    assert [row["action"] for row in many] == ["create", "error", "error"] * 10
    assert all("操作人" in row["errors"][0] for row in many[1::3])
    assert all("游戏类型" in row["errors"][0] for row in many[2::3])
    assert many_count <= first_count + 2

    game.is_active = False
    seeded_db.commit()
    refreshed = preview(1)
    assert refreshed[0]["action"] == "error"
    assert any("游戏类型" in error for error in refreshed[0]["errors"])


def test_inventory_preview_reuses_game_lookup_and_refreshes_between_requests(seeded_client, seeded_db, headers):
    from sqlalchemy import event
    from app.settings.field_definitions.game_types import create_game_type

    game = create_game_type(seeded_db, name="库存批量游戏", channel_regions=[], actor="pytest")
    seeded_db.commit()
    statements = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        if statement.lstrip().lower().startswith("select") and "from game_type_options" in statement.lower():
            statements.append(statement)

    def preview(count):
        rows = [f"KU_{90000 + index:05d},DG{9000 + index:04d},代挂,admin,2026-10-17,,,库存批量游戏,账号{index},在库"
                for index in range(count)]
        content = ("库存编号,订单号,业务类型,入库操作人,入库时间,回收价,提号价,游戏/产品类型,游戏账号/产品,库存状态\n"
                   + "\n".join(rows) + "\n").encode()
        response = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                      files={"file": ("订单.csv", content, "text/csv")})
        assert response.status_code == 200, response.text
        return response.json()["rows"]

    event.listen(seeded_db.get_bind(), "before_cursor_execute", capture)
    try:
        first = preview(1)
        first_count = len(statements)
        statements.clear()
        many = preview(10)
        many_count = len(statements)
    finally:
        event.remove(seeded_db.get_bind(), "before_cursor_execute", capture)

    assert all(row["action"] == "create" for row in first + many)
    assert many_count <= first_count + 1
    game.is_active = False
    seeded_db.commit()
    assert any("游戏类型" in error for error in preview(1)[0]["errors"])


def test_operator_lookup_is_refreshed_for_each_import(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order
    from app.domain.users import User

    employee = User(username="import-active", display_name="导入员工", password_hash="unused", role="OPERATOR")
    seeded_db.add(employee)
    seeded_db.commit()

    def content(number):
        return f"订单号,业务类型,入库操作人,入库时间\n{number},代挂,导入员工,2026-10-17\n".encode()

    first = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                               files={"file": ("订单.csv", content("DG9188"), "text/csv")})
    assert first.status_code == 200, first.text
    employee.is_active = False
    seeded_db.commit()
    second = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                files={"file": ("订单.csv", content("DG9189"), "text/csv")})
    assert second.status_code == 422
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "DG9189")) is None


def test_preview_queries_existing_order_numbers_once_for_all_scope(seeded_client, seeded_db, headers):
    from sqlalchemy import event

    statements = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        sql = " ".join(statement.lower().split())
        if sql.startswith("select orders.order_no from orders where orders.order_no in"):
            statements.append(statement)

    content = "订单号,业务类型,入库操作人,入库时间\nDG9190,代挂,admin,2026-10-17\n".encode()
    event.listen(seeded_db.get_bind(), "before_cursor_execute", capture)
    try:
        response = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                      files={"file": ("订单.csv", content, "text/csv")})
    finally:
        event.remove(seeded_db.get_bind(), "before_cursor_execute", capture)
    assert response.status_code == 200, response.text
    assert response.json()["rows"][0]["action"] == "create"
    assert len(statements) == 1


def test_update_preview_only_loads_ledger_for_filled_readonly_fields(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import event
    from app.business.orders.create import create_order

    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest")
    seeded_db.commit()
    order_no = order.order_no
    statements = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        if statement.lstrip().lower().startswith("select"):
            statements.append(statement)

    def preview(cost):
        content = f"订单号,业务类型,订单备注,成本\n{order_no},代挂,新备注,{cost}\n".encode()
        response = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "update"},
                                      files={"file": ("订单.csv", content, "text/csv")})
        assert response.status_code == 200, response.text
        return response.json()["rows"][0]

    event.listen(seeded_db.get_bind(), "before_cursor_execute", capture)
    try:
        empty = preview("")
        empty_count = len(statements)
        statements.clear()
        mismatch = preview("999999")
        filled_count = len(statements)
    finally:
        event.remove(seeded_db.get_bind(), "before_cursor_execute", capture)

    assert empty["action"] == "update"
    assert mismatch["action"] == "error"
    assert any("成本" in error and "不一致" in error for error in mismatch["errors"])
    assert empty_count < filled_count


def test_unbound_order_export_keeps_business_operator_when_inventory_operator_is_visible(seeded_client, seeded_db, headers):
    import csv
    from io import StringIO
    from sqlalchemy import select
    from app.domain.trade import OrderFormField
    from app.domain.users import User
    from app.settings.field_definitions.catalog_seed import seed_business_responsible_fields

    seed_business_responsible_fields(seeded_db, actor="pytest")
    seeded_db.flush()
    field = seeded_db.scalar(select(OrderFormField).where(OrderFormField.order_type_code == "DG",
                                                          OrderFormField.field_key == "business_responsible_ids"))
    field.is_active = True
    field.required = True
    user = seeded_db.scalar(select(User).where(User.username == "admin"))
    seeded_db.commit()
    content = f"订单号,入库时间,业务类型,入库操作人\nDG0951,2026-10-17,代挂,{user.username}\n".encode()
    created = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                 files={"file": ("订单.csv", content, "text/csv")})
    assert created.status_code == 200, created.text

    exported = seeded_client.get("/api/orders/export.csv", headers=headers, params={"keyword": "DG0951"})
    assert exported.status_code == 200, exported.text
    row = next(csv.DictReader(StringIO(exported.content.decode("utf-8-sig"))))
    assert row["入库操作人"] == ""
    assert row["业务操作人"] in {user.username, user.display_name}
    xlsx = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": "DG0951"})
    assert xlsx.status_code == 200, xlsx.text
    workbook = load_workbook(BytesIO(xlsx.content), read_only=True)
    values = list(workbook["主订单信息"].values)
    assert values[1][values[0].index("业务操作人")] in {user.username, user.display_name}


def test_exported_ledger_updates_existing_order_without_rewriting_derived_columns(seeded_client, seeded_db, headers):
    import csv
    from datetime import date
    from io import StringIO
    from sqlalchemy import func, select
    from app.business.inventory.profile import update_account_profile
    from app.business.orders.create import create_order
    from app.domain.trade import Cashflow, OrderEvent

    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                         account_snapshot={"game_account": "台账回流", "game_type": "手游"})
    update_account_profile(seeded_db, order.account_id, actor="pytest", game_account="已更新账号")
    seeded_db.commit()
    exported = seeded_client.get("/api/orders/export.csv", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text
    content = _without_business_operator_from_export(exported.content, "csv")

    def submit(path, content):
        return seeded_client.post(f"/api/order-imports/{path}", headers=headers, data={"existing": "update"},
                                  files={"file": ("订单.csv", content, "text/csv")})

    before_flows = seeded_db.scalar(select(func.count()).select_from(Cashflow))
    before_events = seeded_db.scalar(select(func.count()).select_from(OrderEvent))
    preview = submit("preview", content)
    assert preview.status_code == 200, preview.text
    assert preview.json()["rows"][0]["action"] == "update", preview.json()
    updated = submit("execute", content)
    assert updated.status_code == 200, updated.text
    assert seeded_db.scalar(select(func.count()).select_from(Cashflow)) == before_flows
    assert seeded_db.scalar(select(func.count()).select_from(OrderEvent)) == before_events
    xlsx = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": order.order_no})
    assert xlsx.status_code == 200, xlsx.text
    xlsx_content = _without_business_operator_from_export(xlsx.content, "xlsx")
    xlsx_preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "update"},
                                      files={"file": ("订单.xlsx", xlsx_content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert xlsx_preview.status_code == 200, xlsx_preview.text
    assert xlsx_preview.json()["rows"][0]["action"] == "update", xlsx_preview.json()

    reader = csv.DictReader(StringIO(content.decode("utf-8-sig")))
    row = next(reader)
    row["成本"] = "999.00"
    out = StringIO(newline="")
    writer = csv.DictWriter(out, fieldnames=reader.fieldnames)
    writer.writeheader()
    writer.writerow(row)
    mismatch = submit("preview", out.getvalue().encode())
    assert mismatch.status_code == 200, mismatch.text
    assert any("成本" in error for error in mismatch.json()["rows"][0]["errors"])


@pytest.mark.parametrize("extension", ["csv", "xlsx"])
def test_exported_dictionary_labels_can_round_trip_into_existing_order(seeded_client, seeded_db, headers, extension):
    from datetime import date
    from app.business.orders.create import create_order
    from app.settings.field_definitions.game_types import create_game_type, update_game_type

    game = create_game_type(seeded_db, name="原游戏", channel_regions=[{"label": "原渠道"}], actor="pytest")
    channel = game.channel_regions[0]["value"]
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                         account_snapshot={"game_account": "编码回流", "game_type": game.value, "channel_region": channel})
    update_game_type(seeded_db, game.id, name="现游戏", channel_regions=[{"value": channel, "label": "现渠道"}], actor="pytest")
    seeded_db.commit()
    exported = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text
    mime = "text/csv" if extension == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    data = {"existing": "update", "sections": "details"}
    files = {"file": (f"订单.{extension}", _without_business_operator_from_export(exported.content, extension), mime)}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data=data, files=files)
    assert preview.status_code == 200, preview.text
    assert preview.json()["detail_errors"] == []
    assert preview.json()["rows"][0]["action"] == "update"
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data=data, files=files)
    assert result.status_code == 200, result.text
    seeded_db.refresh(order)
    assert order.account_snapshot["game_type"] == game.value
    assert order.account_snapshot["channel_region"] == channel
    assert order.account_snapshot["game_type_label"] == "原游戏"


def test_new_order_import_resolves_game_and_channel_labels_to_codes(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order
    from app.settings.field_definitions.game_types import create_game_type

    game = create_game_type(seeded_db, name="导入游戏", channel_regions=[{"label": "安卓一区"}], actor="pytest")
    content = ("订单号,入库时间,业务类型,游戏账号/产品,游戏/产品类型,渠道 / 区服\n"
               "DG0955,2026-10-17,代挂,导入账号,导入游戏,安卓一区\n").encode()
    result = seeded_client.post("/api/order-imports/execute", headers=headers,
                                data={"existing": "skip", "sections": "details"},
                                files={"file": ("订单.csv", content, "text/csv")})
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0955"))
    assert order.account_snapshot["game_type"] == game.value
    assert order.account_snapshot["channel_region"] == game.channel_regions[0]["value"]
    assert order.account_snapshot["game_type_label"] == "导入游戏"
    assert order.account_snapshot["channel_region_label"] == "安卓一区"


def test_new_order_import_preview_rejects_unconfigured_game(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order

    content = ("订单号,入库时间,业务类型,游戏账号/产品,游戏/产品类型\n"
               "DG0956,2026-10-17,代挂,导入账号,未配置游戏\n").encode()
    files = {"file": ("订单.csv", content, "text/csv")}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"}, files=files)
    assert preview.status_code == 200, preview.text
    assert preview.json()["rows"][0]["action"] == "error"
    assert any("游戏类型" in error for error in preview.json()["rows"][0]["errors"])
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"}, files=files)
    assert result.status_code == 422
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "DG0956")) is None


@pytest.mark.parametrize("extension", ["csv", "xlsx"])
def test_order_export_uses_current_linked_account_details(seeded_client, seeded_db, headers, extension):
    from datetime import date
    from app.business.inventory.profile import update_account_profile
    from app.business.orders.create import create_order

    order = create_order(
        seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
        account_snapshot={"game_account": "导出账号", "channel_region": "旧区", "bound_phone": "旧手机号", "has_secondary": True},
    )
    update_account_profile(
        seeded_db, order.account_id, actor="pytest", channel_region="新区", bound_phone=None,
        has_secondary=False, account_description="最新账号描述",
        account_images=["data:image/png;base64,one", "data:image/png;base64,two"],
    )
    seeded_db.commit()

    response = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": order.order_no})
    assert response.status_code == 200, response.text
    tables = parse_order_import(f"订单.{extension}", response.content)
    table = tables["details"] if extension == "xlsx" else tables["main"]
    row = dict(zip(table.headers, table.rows[0].values))
    assert row["渠道 / 区服"] == "新区"
    assert row["绑定手机号"] == ""
    assert row["有无二次"] == "无"
    assert row["账号描述"] == "最新账号描述"
    assert row["账号图片"] == "2张"
    update_account_profile(seeded_db, order.account_id, actor="pytest", account_images=None)
    seeded_db.commit()
    response = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": order.order_no})
    assert response.status_code == 200, response.text
    tables = parse_order_import(f"订单.{extension}", response.content)
    table = tables["details"] if extension == "xlsx" else tables["main"]
    assert dict(zip(table.headers, table.rows[0].values))["账号图片"] == ""


def test_execute_creates_unbound_orders_reserves_numbers_and_is_idempotent_on_skip(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.domain.trade import Account, Order
    from app.settings.field_definitions.game_types import create_game_type

    game = create_game_type(seeded_db, name="手游", actor="pytest")
    content = ("订单号,入库时间,业务类型,游戏账号/产品,游戏/产品类型,订单备注\n"
               "HS0998,2026-10-17,回收,导入账号,手游,历史备注\n").encode()
    def submit(choice):
        return seeded_client.post("/api/order-imports/execute", headers=headers,
                                  data={"existing": choice}, files={"file": ("订单.csv", content, "text/csv")})
    response = submit("skip")
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 1 and response.json()["skipped"] == 0
    order = seeded_db.scalar(select(Order).where(Order.order_no == "HS0998"))
    assert order is not None and order.account_id is None
    assert order.account_snapshot["game_account"] == "导入账号"
    assert order.account_snapshot["game_type"] == game.value
    assert order.trade_date == date(2026, 10, 17) and order.note == "历史备注"
    assert seeded_db.scalar(select(Account.id).where(Account.game_account == "导入账号")) is None
    repeated = submit("skip")
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["created"] == 0 and repeated.json()["skipped"] == 1
    next_order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 18), actor="pytest")
    assert next_order.order_no == "HS0999"


def test_import_without_game_account_preserves_game_type(seeded_client, seeded_db, headers):
    from sqlalchemy import func, select
    from app.domain.trade import Account, Order
    from app.settings.field_definitions.game_types import create_game_type

    game = create_game_type(seeded_db, name="缺少账号的历史游戏", actor="pytest")
    seeded_db.commit()
    content = (
        "订单号,入库时间,业务类型,入库操作人,游戏账号/产品,游戏/产品类型\n"
        "HS0986,2026-10-17,回收,admin,,缺少账号的历史游戏\n"
        "TH0986,2026-10-17,提号,admin,,缺少账号的历史游戏\n"
        "DG0986,2026-10-17,代挂,admin,,缺少账号的历史游戏\n"
    ).encode()
    data = {"existing": "skip"}
    files = {"file": ("订单.csv", content, "text/csv")}

    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data=data, files=files)
    assert preview.status_code == 200, preview.text
    assert [row["action"] for row in preview.json()["rows"]] == ["create"] * 3
    accounts_before = seeded_db.scalar(select(func.count()).select_from(Account))
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data=data, files=files)
    assert result.status_code == 200, result.text
    assert result.json()["created"] == 3

    orders = seeded_db.scalars(select(Order).where(Order.order_no.in_(["HS0986", "TH0986", "DG0986"]))).all()
    assert len(orders) == 3
    assert all(order.account_id is None for order in orders)
    assert all(order.account_snapshot["game_type"] == game.value for order in orders)
    assert all(order.account_snapshot["game_type_label"] == "缺少账号的历史游戏" for order in orders)
    assert all(not order.account_snapshot.get("game_account") for order in orders)
    assert seeded_db.scalar(select(func.count()).select_from(Account)) == accounts_before
    listed = seeded_client.get("/api/orders", headers=headers, params={"keyword": "0986"})
    assert listed.status_code == 200, listed.text
    assert len(listed.json()["items"]) == 3
    assert all(item["account_game_type_label"] == "缺少账号的历史游戏" for item in listed.json()["items"])


def test_optional_import_account_does_not_change_regular_order_validation(seeded_client, headers):
    response = seeded_client.post(
        "/api/orders", headers=headers,
        json={"order_type": "DG", "trade_date": "2026-10-17", "account_snapshot": {"game_type": "手游"}},
    )
    assert response.status_code == 422


def test_execute_updates_only_supplied_fields_and_rolls_back_whole_invalid_file(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.domain.trade import Order

    existing = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", note="旧备注")
    seeded_db.commit()
    content = f"订单号,业务类型,订单备注\n{existing.order_no},代挂,新备注\n".encode()
    updated = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "update"},
                                 files={"file": ("订单.csv", content, "text/csv")})
    assert updated.status_code == 200, updated.text
    seeded_db.refresh(existing)
    assert existing.note == "新备注" and existing.trade_date == date(2026, 10, 1)
    invalid = ("订单号,入库时间,业务类型\nHS0997,2026-10-17,回收\nTH0997,不合法,提号\n").encode()
    rejected = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                  files={"file": ("订单.csv", invalid, "text/csv")})
    assert rejected.status_code == 422
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "HS0997")) is None


def test_rebate_import_is_idempotent_and_updates_the_linked_cashflow(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.foundation import Pool
    from app.domain.trade import Cashflow, Order, RebateRecord

    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    def workbook(amount):
        book = Workbook()
        main = book.active
        main.title = "主订单信息"
        main.append(["订单号", "入库时间", "业务类型"])
        main.append(["DG0988", "2026-10-17", "代挂"])
        detail = book.create_sheet("返点明细")
        detail.append(["订单号", "返点单号", "返点类型", "返点金额", "收到日期", "资金账户编码"])
        detail.append(["DG0988", "DG0988-RB01", "卖号返点", amount, "2026-10-18", pool.code])
        output = BytesIO()
        book.save(output)
        return output.getvalue()

    def submit(choice, amount):
        return seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": choice, "sections": "rebates"},
                                  files={"file": ("订单.xlsx", workbook(amount), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    first = submit("skip", "12.50")
    assert first.status_code == 200, first.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0988"))
    rebate = seeded_db.scalar(select(RebateRecord).where(RebateRecord.source_order_id == order.id))
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == order.id))
    assert order.account_id is None and rebate.rebate_no == "DG0988-RB01"
    assert str(rebate.amount) == "12.50" and str(flow.amount) == "12.50" and flow.pool_id == pool.id
    repeated = submit("skip", "12.50")
    assert repeated.status_code == 200, repeated.text
    assert len(seeded_db.scalars(select(RebateRecord).where(RebateRecord.source_order_id == order.id)).all()) == 1
    updated = submit("update", "15.75")
    assert updated.status_code == 200, updated.text
    seeded_db.refresh(rebate)
    seeded_db.refresh(flow)
    assert str(rebate.amount) == "15.75" and str(flow.amount) == "15.75"


def test_rebate_import_requires_a_real_target_pool_and_rolls_back(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "入库时间", "业务类型"])
    main.append(["DG0989", "2026-10-17", "代挂"])
    rebates = book.create_sheet("返点明细")
    rebates.append(["订单号", "返点单号", "返点类型", "返点金额", "收到日期", "资金账户编码"])
    rebates.append(["DG0989", "DG0989-RB01", "卖号返点", "12.50", "2026-10-18", "不存在"])
    output = BytesIO()
    book.save(output)
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip", "sections": "rebates"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 422
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "DG0989")) is None


@pytest.mark.parametrize("section", ["events", "cashflows", "rebates"])
def test_import_each_financial_section_rejects_migrated_pool_code(seeded_client, seeded_db, headers, section):
    from sqlalchemy import select
    from app.domain.enums import AuditAction
    from app.domain.foundation import Pool
    from app.domain.trade import Cashflow, Order
    from app.shared.audit import record_audit

    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    record_audit(seeded_db, action=AuditAction.FIELD_DEFINITION_CHANGE, entity_type="pool_code_migration",
                 entity_id=pool.id, actor="pytest", before={"code": "OLD_POOL"}, after={"code": pool.code})
    seeded_db.commit()
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    if section == "events":
        main.append(["订单号", "入库时间", "业务类型", "游戏账号/产品"])
        main.append(["HS0970", "2026-10-17", "回收", "历史账号"])
        detail = book.create_sheet("操作明细")
        detail.append(["订单号", "事件号", "事件顺序", "动作", "动作时间", "金额", "金额归属", "资金账户编码", "已过账"])
        detail.append(["HS0970", "HS0970-EV-BUY-01", "1", "买入", "2026-10-17", "12.50", "PRINCIPAL", "OLD_POOL", "是"])
        order_no = "HS0970"
    elif section == "cashflows":
        main.append(["订单号", "入库时间", "业务类型"])
        main.append(["DG0970", "2026-10-17", "代挂"])
        detail = book.create_sheet("资金明细")
        detail.append(["订单号", "流水号", "业务类别编码", "方向", "金额", "时间", "资金账户编码", "核算属性", "来源类型"])
        detail.append(["DG0970", "SR09700", "OTHER", "收入", "12.50", "2026-10-18", "OLD_POOL", "OTHER_INCOME", "MANUAL"])
        order_no = "DG0970"
    else:
        main.append(["订单号", "入库时间", "业务类型"])
        main.append(["DG0970", "2026-10-17", "代挂"])
        detail = book.create_sheet("返点明细")
        detail.append(["订单号", "返点单号", "返点类型", "返点金额", "收到日期", "资金账户编码"])
        detail.append(["DG0970", "DG0970-RB01", "卖号返点", "12.50", "2026-10-18", "OLD_POOL"])
        order_no = "DG0970"
    output = BytesIO()
    book.save(output)
    response = seeded_client.post("/api/order-imports/execute", headers=headers,
                                  data={"existing": "skip", "sections": section},
                                  files={"file": ("旧订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 422, response.text
    assert seeded_db.scalar(select(Order).where(Order.order_no == order_no)) is None
    assert seeded_db.scalars(select(Cashflow)).all() == []


def test_import_prefers_current_pool_code_over_migration_audit(seeded_db):
    from sqlalchemy import select
    from app.business.orders.importing.reference_codes import resolve_pool_code
    from app.domain.enums import AuditAction
    from app.domain.foundation import Pool
    from app.shared.audit import record_audit

    original = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    current = Pool(code="OLD_POOL", name="不同的现有账户")
    seeded_db.add(current)
    record_audit(seeded_db, action=AuditAction.FIELD_DEFINITION_CHANGE, entity_type="pool_code_migration",
                 entity_id=original.id, actor="pytest", before={"code": "OLD_POOL"}, after={"code": original.code})
    seeded_db.flush()
    assert resolve_pool_code(seeded_db, "OLD_POOL").id == current.id


def test_import_does_not_recover_old_pool_code_from_creation_audit(seeded_db):
    from sqlalchemy import select
    from app.business.orders.importing.reference_codes import resolve_pool_code
    from app.domain.enums import AuditAction
    from app.domain.foundation import Pool
    from app.shared.audit import record_audit

    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    record_audit(seeded_db, action=AuditAction.POOL_CREATE, entity_type="Pool", entity_id=pool.id,
                 actor="pytest", after={"code": "OLD_POOL"})
    assert resolve_pool_code(seeded_db, "OLD_POOL") is None
    assert resolve_pool_code(seeded_db, pool.code).id == pool.id


def test_import_current_pool_code_still_checks_user_pool_access(seeded_db):
    from datetime import date
    from sqlalchemy import select
    from app.business.orders.importing.cashflows import import_cashflows
    from app.core.security import CurrentUser, ROLE_OPERATOR
    from app.domain.foundation import Pool
    from app.domain.trade import Order

    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    seeded_db.add(Order(order_no="DG0969", order_type="DG", trade_date=date(2026, 1, 1)))
    seeded_db.flush()
    fields = ("订单号", "流水号", "业务类别编码", "方向", "金额", "时间", "资金账户编码", "核算属性", "来源类型")
    values = ("DG0969", "SR09690", "OTHER", "收入", "12.50", "2026-01-01", pool.code, "OTHER_INCOME", "MANUAL")
    tables = {"cashflows": parser.ImportTable(fields, (parser.ImportRow("资金明细", 2, values),))}
    user = CurrentUser.build(id=42, username="limited", roles=[ROLE_OPERATOR], owner_scope="SELF")
    with pytest.raises(Validation, match="资金账户不存在或无权使用"):
        import_cashflows(seeded_db, tables, [], {"DG0969": "update"}, user)


def test_manual_cashflow_import_preserves_accounting_and_does_not_duplicate(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.foundation import Pool
    from app.domain.trade import Cashflow, Order

    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "入库时间", "业务类型"])
    main.append(["DG0975", "2026-10-17", "代挂"])
    flows = book.create_sheet("资金明细")
    flows.append(["订单号", "流水号", "业务类别编码", "方向", "金额", "时间", "资金账户编码", "核算属性", "来源类型"])
    flows.append(["DG0975", "SR00975", "OTHER", "收入", "25.75", "2026-10-18", pool.code, "OTHER_INCOME", "MANUAL"])
    output = BytesIO()
    book.save(output)
    def submit(choice):
        return seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": choice, "sections": "cashflows"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    first = submit("skip")
    assert first.status_code == 200, first.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0975"))
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.flow_no == "SR00975"))
    assert order.account_id is None and flow.order_id == order.id and flow.pool_id == pool.id
    assert str(flow.amount) == "25.75" and flow.accounting_attribute == "OTHER_INCOME" and flow.source_type == "MANUAL"
    repeated = submit("update")
    assert repeated.status_code == 200, repeated.text
    assert len(seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()) == 1


def test_event_derived_cashflow_cannot_be_imported_without_its_business_source(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.foundation import Pool
    from app.domain.trade import Order
    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "入库时间", "业务类型"])
    main.append(["DG0976", "2026-10-17", "代挂"])
    flows = book.create_sheet("资金明细")
    flows.append(["订单号", "流水号", "业务类别编码", "方向", "金额", "时间", "资金账户编码", "核算属性", "来源类型", "来源编号"])
    flows.append(["DG0976", "SR00976", "SELL", "收入", "10", "2026-10-18", pool.code, "DG_REVENUE", "ORDER_EVENT", "DG0976-EV01"])
    output = BytesIO()
    book.save(output)
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip", "sections": "cashflows"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 422 and "来源" in response.text
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "DG0976")) is None


def test_operational_events_import_with_stable_unlisting_reference(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.business.shared.listing_state import active_listings
    from app.domain.trade import Order, OrderEvent
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "入库时间", "业务类型"])
    main.append(["DG0970", "2026-10-17", "代挂"])
    events = book.create_sheet("操作明细")
    events.append(["订单号", "事件号", "事件顺序", "动作", "运营动作", "动作时间", "运营详情(JSON)", "关联上架事件号", "备注", "原因"])
    events.append(["DG0970", "DG0970-EV-OPERATE-01", "1", "运营", "CONSIGNMENT", "2026-10-17",
                   '{"consignment_platforms":["千寻"],"listed_at":"2026-10-17T10:00:00"}', "", "上架"])
    events.append(["DG0970", "DG0970-EV-OPERATE-02", "2", "运营", "UNLIST", "2026-10-18",
                   '{"consignment_platforms":["千寻"],"platform_unlist_scope":"PLATFORM"}', "DG0970-EV-OPERATE-01", "下架", "平台停售"])
    output = BytesIO()
    book.save(output)
    def submit(choice):
        return seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": choice, "sections": "events"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    first = submit("skip")
    assert first.status_code == 200, first.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0970"))
    rows = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id).order_by(OrderEvent.id)).all()
    assert len(rows) == 2 and rows[1].form_extra["consignment_event_id"] == rows[0].id
    assert not active_listings(seeded_db, order.id)
    repeated = submit("update")
    assert repeated.status_code == 200, repeated.text
    assert len(seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()) == 2


def test_selected_order_details_imports_snapshot_and_note_without_binding_stock(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Account, Order
    from app.settings.field_definitions.game_types import create_game_type
    game = create_game_type(seeded_db, name="手游", channel_regions=[{"label": "一区"}], actor="pytest")
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "入库时间", "业务类型", "游戏账号/产品", "游戏/产品类型"])
    main.append(["DG0960", "2026-10-17", "代挂", "历史账号", "手游"])
    details = book.create_sheet("详情信息")
    details.append(["订单标识", "账号详情", None, None, None, "订单信息"])
    details.append([None, None, None, None, None, None])
    details.append(["订单号", "渠道 / 区服", "绑定手机号", "有无二次", "账号描述", "订单备注"])
    details.append(["DG0960", "一区", "12345", "有", "历史账号描述", "历史订单备注"])
    output = BytesIO()
    book.save(output)
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip", "sections": "details"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 200, response.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0960"))
    assert order.account_id is None and order.note == "历史订单备注"
    assert order.account_snapshot["channel_region"] == game.channel_regions[0]["value"]
    assert order.account_snapshot["bound_phone"] == "12345" and order.account_snapshot["has_secondary"] is True
    assert order.account_snapshot["account_description"] == "历史账号描述"
    assert seeded_db.scalar(select(Account.id).where(Account.game_account == "历史账号")) is None
    fetched = seeded_client.get(f"/api/orders/{order.id}", headers=headers)
    assert fetched.status_code == 200, fetched.text
    snapshot = fetched.json()["account_snapshot"]
    assert snapshot["bound_phone"] == "12345" and snapshot["has_secondary"] is True
    assert snapshot["account_description"] == "历史账号描述"
    exported = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text
    details_table = parse_order_import("订单.xlsx", exported.content)["details"]
    detail = dict(zip(details_table.headers, details_table.rows[0].values))
    assert detail["渠道 / 区服"] == "一区" and detail["绑定手机号"] == "12345"
    assert detail["账号描述"] == "历史账号描述"
    repeated = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "update", "sections": "details"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert repeated.status_code == 200, repeated.text
    details.cell(4, 5, "尝试覆盖描述")
    changed = BytesIO()
    book.save(changed)
    changed_preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "update", "sections": "details"},
                                         files={"file": ("订单.xlsx", changed.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert changed_preview.status_code == 200, changed_preview.text
    assert any("账号描述" in item["message"] for item in changed_preview.json()["detail_errors"])
    rejected = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "update", "sections": "details"},
                                  files={"file": ("订单.xlsx", changed.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert rejected.status_code == 422, rejected.text
    seeded_db.refresh(order)
    assert order.account_snapshot["account_description"] == "历史账号描述"
    main.cell(2, 1, "TH0960")
    main.cell(2, 3, "提号")
    details.cell(4, 1, "TH0960")
    invalid = BytesIO()
    book.save(invalid)
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip", "sections": "details"},
                                 files={"file": ("订单.xlsx", invalid.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert preview.status_code == 200, preview.text
    assert any("仅适用于回收或代挂" in item["message"] for item in preview.json()["detail_errors"])
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "TH0960")) is None


def test_order_creation_keeps_account_description_on_inventory_and_enforces_scope(seeded_client, seeded_db, headers):
    from app.domain.trade import Account

    payload = {"order_type": "DG", "trade_date": "2026-10-17",
               "account_snapshot": {"game_account": "普通建单-描述", "account_description": "代挂介绍"}}
    created = seeded_client.post("/api/orders", headers=headers, json=payload)
    assert created.status_code == 201, created.text
    assert seeded_db.get(Account, created.json()["account_id"]).account_description == "代挂介绍"
    payload["order_type"] = "TH"
    payload["account_snapshot"]["game_account"] = "提号-描述不允许"
    denied = seeded_client.post("/api/orders", headers=headers, json=payload)
    assert denied.status_code == 422, denied.text
    assert "仅适用于回收或代挂" in denied.text


@pytest.mark.parametrize("extension", ["csv", "xlsx"])
def test_exported_details_can_update_the_same_order_without_rewriting_readonly_fields(seeded_client, seeded_db, headers, extension):
    import csv
    from datetime import date
    from io import StringIO
    from app.business.inventory.profile import update_account_profile
    from app.business.orders.create import create_order
    from app.domain.trade import Account

    order = create_order(
        seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
        account_snapshot={"game_account": "详情回流", "channel_region": "一区", "account_description": "账号介绍"},
        form_extra={"business_responsible_ids": [1]},
    )
    update_account_profile(seeded_db, order.account_id, actor="pytest", account_images=["data:image/png;base64,one"])
    seeded_db.commit()
    exported = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text
    content = _without_business_operator_from_export(exported.content, extension)
    mime = "text/csv" if extension == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    def submit(path):
        return seeded_client.post(f"/api/order-imports/{path}", headers=headers,
                                  data={"existing": "update", "sections": "details"},
                                  files={"file": (f"订单.{extension}", content, mime)})
    preview = submit("preview")
    assert preview.status_code == 200, preview.text
    assert preview.json()["rows"][0]["action"] == "update", preview.json()
    assert any("只读详情" in warning for warning in preview.json()["rows"][0]["warnings"])
    assert preview.json()["detail_errors"] == [], preview.json()
    if extension == "csv":
        reader = csv.DictReader(StringIO(content.decode("utf-8-sig")))
        rows = list(reader)
        rows[0]["订单扩展字段"] = '{"业务负责人":"错误人员"}'
        output = StringIO(newline="")
        writer = csv.DictWriter(output, fieldnames=reader.fieldnames)
        writer.writeheader()
        writer.writerows(rows)
        modified = output.getvalue().encode()
    else:
        book = load_workbook(BytesIO(content))
        sheet = book["详情信息"]
        headers_row = [cell.value for cell in sheet[3]]
        sheet.cell(4, headers_row.index("订单扩展字段") + 1, '{"业务负责人":"错误人员"}')
        output = BytesIO()
        book.save(output)
        modified = output.getvalue()
    rejected = seeded_client.post("/api/order-imports/preview", headers=headers,
                                  data={"existing": "update", "sections": "details"},
                                  files={"file": (f"订单.{extension}", modified, mime)})
    assert rejected.status_code == 200, rejected.text
    assert any("订单扩展字段" in item["message"] for item in rejected.json()["detail_errors"])
    result = submit("execute")
    assert result.status_code == 200, result.text
    assert result.json()["updated"] == 1
    seeded_db.refresh(order)
    assert order.form_extra["business_responsible_ids"] == [1]
    assert seeded_db.get(Account, order.account_id).account_images == ["data:image/png;base64,one"]


def test_detail_import_rechecks_readonly_values_after_preview(seeded_client, seeded_db, headers):
    from datetime import date
    from app.business.orders.create import create_order
    from app.business.orders.mutations import update_order

    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                         account_snapshot={"game_account": "并发详情回流"},
                         form_extra={"business_responsible_ids": [1]})
    seeded_db.commit()
    exported = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text
    content = _without_business_operator_from_export(exported.content, "xlsx")
    def submit(path):
        return seeded_client.post(f"/api/order-imports/{path}", headers=headers,
                                  data={"existing": "update", "sections": "details"},
                                  files={"file": ("订单.xlsx", content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    preview = submit("preview")
    assert preview.status_code == 200 and not preview.json()["detail_errors"], preview.text
    update_order(seeded_db, order.id, actor="other", form_extra={"business_responsible_ids": [2]}, form_extra_scope="DG")
    seeded_db.commit()
    rejected = submit("execute")
    assert rejected.status_code == 422, rejected.text
    seeded_db.refresh(order)
    assert order.form_extra["business_responsible_ids"] == [2]


@pytest.mark.parametrize("extension", ["csv", "xlsx"])
def test_order_export_includes_identity_needed_for_import_even_when_hidden(seeded_client, seeded_db, headers, extension):
    from datetime import date
    from app.business.orders.create import create_order
    from app.settings.lists.service import save_config
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest")
    save_config(seeded_db, "LEDGER", [
        {"column_key": "order_no", "is_visible": False, "sort_order": 1},
        {"column_key": "inventory_type", "is_visible": False, "sort_order": 2},
    ], actor="pytest")
    seeded_db.commit()
    response = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": order.order_no})
    assert response.status_code == 200, response.text
    table = parse_order_import(f"订单.{extension}", response.content)["main"]
    record = dict(zip(table.headers, table.rows[0].values))
    assert record["订单号"] == order.order_no
    assert record["业务日期"].startswith("2026-10-17")
    assert record["业务类型"] in {"代挂", "CONSIGNMENT", "DG"}


def test_buy_sell_and_their_cashflows_import_once_as_linked_facts(seeded_client, seeded_db, headers):
    from decimal import Decimal
    from sqlalchemy import select
    from app.domain.foundation import Pool
    from app.domain.trade import Cashflow, Order, OrderEvent
    from app.shared.order_amounts import order_cashflow_profit
    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "入库时间", "业务类型", "游戏账号/产品"])
    main.append(["HS0980", "2026-10-17", "回收", "历史回收账号"])
    events = book.create_sheet("操作明细")
    events.append(["订单号", "事件号", "事件顺序", "动作", "动作时间", "金额", "金额归属", "资金账户编码", "已过账"])
    events.append(["HS0980", "HS0980-EV-BUY-01", "1", "买入", "2026-10-17", "100", "PRINCIPAL", pool.code, "是"])
    events.append(["HS0980", "HS0980-EV-SELL-01", "2", "售出", "2026-10-18", "150", "GROSS", pool.code, "是"])
    flows = book.create_sheet("资金明细")
    flows.append(["订单号", "流水号", "业务类别编码", "方向", "金额", "时间", "资金账户编码", "核算属性", "来源类型", "来源编号"])
    flows.append(["HS0980", "ZC07890", "BUY", "支出", "100", "2026-10-17", pool.code, "SELF_DIRECT_COST", "ORDER_EVENT", "HS0980-EV-BUY-01"])
    flows.append(["HS0980", "SR07890", "SELL", "收入", "150", "2026-10-18", pool.code, "SELF_REVENUE", "ORDER_EVENT", "HS0980-EV-SELL-01"])
    output = BytesIO()
    book.save(output)
    response = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": ["events", "cashflows"]},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 200, response.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "HS0980"))
    event_rows = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    flow_rows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()
    assert order.account_id is None and order.status == "COMPLETED"
    assert len(event_rows) == 2 and len(flow_rows) == 2
    assert {flow.source_id for flow in flow_rows} == {event.event_no for event in event_rows}
    assert order_cashflow_profit(seeded_db, order.id) == Decimal("50.00")


def test_rebate_event_and_cashflow_are_imported_once_together_from_export(seeded_client, seeded_db, headers):
    from datetime import date
    from decimal import Decimal
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.domain.trade import Cashflow, Order, OrderEvent, RebateRecord
    from app.finance.rebates import create_rebate
    from app.shared.order_amounts import order_cashflow_profit

    original = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest")
    create_rebate(seeded_db, source_order_id=original.id, rebate_type="SELL", amount="12.50",
                  collected_on=date(2026, 10, 18), actor="pytest", note="渠道返点")
    seeded_db.commit()
    response = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": original.order_no})
    assert response.status_code == 200, response.text
    source = load_workbook(BytesIO(response.content))
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "入库时间", "业务类型"])
    main.append(["DG0985", "2026-10-17", "代挂"])
    for title in ("操作明细", "资金明细", "返点明细"):
        sheet = book.create_sheet(title)
        for cells in source[title].values:
            row = [cell.replace(original.order_no, "DG0985") if isinstance(cell, str) else cell for cell in cells]
            if title == "资金明细" and row[0] == "DG0985":
                row[1] = "SR09850"
            sheet.append(row)
    event_headers = [cell.value for cell in book["操作明细"][1]]
    assert "来源编号" in event_headers
    output = BytesIO()
    book.save(output)
    def submit(choice):
        return seeded_client.post("/api/order-imports/execute", headers=headers,
            data={"existing": choice, "sections": ["events", "cashflows", "rebates"]},
            files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    first = submit("skip")
    assert first.status_code == 200, first.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0985"))
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    flows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()
    rebates = seeded_db.scalars(select(RebateRecord).where(RebateRecord.source_order_id == order.id)).all()
    assert len(events) == len(flows) == len(rebates) == 1
    assert events[0].source_id == rebates[0].rebate_no and flows[0].source_id == events[0].event_no
    assert order_cashflow_profit(seeded_db, order.id) == Decimal("12.50")
    assert submit("update").status_code == 200
    assert len(seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()) == 1


def test_csv_export_rebate_details_keep_machine_codes_for_import(seeded_client, seeded_db, headers):
    import csv
    import json
    from datetime import date
    from io import StringIO
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.domain.trade import Cashflow, Order, OrderEvent, RebateRecord
    from app.finance.rebates import create_rebate

    original = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest")
    create_rebate(seeded_db, source_order_id=original.id, rebate_type="SELL", amount="12.50",
                  collected_on=date(2026, 10, 18), actor="pytest")
    seeded_db.commit()
    response = seeded_client.get("/api/orders/export.csv", headers=headers, params={"keyword": original.order_no})
    assert response.status_code == 200, response.text
    record = next(csv.DictReader(StringIO(response.text.lstrip("\ufeff"))))
    event = json.loads(record["操作明细"])[0]
    flow = json.loads(record["资金明细"])[0]
    assert event["来源类型"] == "REBATE"
    assert event["来源编号"].startswith(original.order_no)
    assert flow["业务类别编码"] == "REBATE" and flow["来源类型"] == "ORDER_EVENT"
    columns = ["订单号", "入库时间", "业务类型", "操作明细", "资金明细", "返点明细"]
    target = {key: record[key].replace(original.order_no, "DG0986") for key in columns}
    flows = json.loads(target["资金明细"])
    flows[0]["流水号"] = "SR09860"
    target["资金明细"] = json.dumps(flows, ensure_ascii=False)
    text = StringIO(newline="")
    writer = csv.DictWriter(text, fieldnames=columns)
    writer.writeheader()
    writer.writerow(target)
    imported = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": ["events", "cashflows", "rebates"]},
        files={"file": ("订单.csv", text.getvalue().encode(), "text/csv")})
    assert imported.status_code == 200, imported.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0986"))
    assert len(seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()) == 1
    assert len(seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()) == 1
    assert len(seeded_db.scalars(select(RebateRecord).where(RebateRecord.source_order_id == order.id)).all()) == 1


def test_exported_sale_cancellation_imports_with_original_event_reference(seeded_client, seeded_db, headers):
    from datetime import date
    from decimal import Decimal
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.business.orders.events import post_event
    from app.domain.trade import Cashflow, Order, OrderEvent
    from app.shared.order_amounts import order_cashflow_profit

    original = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                            account_snapshot={"game_account": "cancel-source"})
    sale, _ = post_event(seeded_db, original.id, event_type="SELL", sale_mode="FULL", portion="GROSS", amount="50",
                         occurred_on=date(2026, 10, 18), actor="pytest")
    post_event(seeded_db, original.id, event_type="CANCEL", amount="50", offset_event_id=sale.id,
               occurred_on=date(2026, 10, 19), actor="pytest", reason="售出取消")
    seeded_db.commit()
    export = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": original.order_no})
    assert export.status_code == 200, export.text
    source = load_workbook(BytesIO(export.content))
    book = Workbook()
    book.active.title = "主订单信息"
    book.active.append(["订单号", "入库时间", "业务类型"])
    book.active.append(["DG0983", "2026-10-17", "代挂"])
    for title in ("操作明细", "资金明细"):
        sheet = book.create_sheet(title)
        for cells in source[title].values:
            row = [cell.replace(original.order_no, "DG0983") if isinstance(cell, str) else cell for cell in cells]
            if title == "资金明细" and row[0] == "DG0983":
                row[1] = ("SR" if str(row[1]).startswith("SR") else "ZC") + "09830"
            sheet.append(row)
    output = BytesIO()
    book.save(output)
    result = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": ["events", "cashflows"]},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0983"))
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id).order_by(OrderEvent.id)).all()
    assert len(events) == 2 and events[1].offset_event_id == events[0].id
    assert order.account_id is None and order.status == "CANCELLED"
    assert len(seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()) == 2
    assert order_cashflow_profit(seeded_db, order.id) == Decimal("0.00")


def test_exported_delivery_import_restores_recorded_phone_and_order_details(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.business.orders.events import post_event
    from app.domain.trade import Order, OrderEvent

    original = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                            account_snapshot={"game_account": "delivery-source"})
    post_event(seeded_db, original.id, event_type="SELL", sale_mode="FULL", portion="GROSS", amount="50",
               occurred_on=date(2026, 10, 18), actor="pytest")
    post_event(seeded_db, original.id, event_type="DELIVER", delivery_direction="SELL", note="交接完成",
               bound_phone="13900000001", bound_phone_owner="张三", occurred_on=date(2026, 10, 19), actor="pytest")
    seeded_db.commit()
    export = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": original.order_no})
    assert export.status_code == 200, export.text
    source = load_workbook(BytesIO(export.content))
    book = Workbook()
    book.active.title = "主订单信息"
    book.active.append(["订单号", "入库时间", "业务类型", "游戏账号/产品"])
    book.active.append(["DG0984", "2026-10-17", "代挂", "delivery-target"])
    events = book.create_sheet("操作明细")
    for cells in source["操作明细"].values:
        events.append([cell.replace(original.order_no, "DG0984") if isinstance(cell, str) else cell for cell in cells])
    output = BytesIO()
    book.save(output)
    result = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": "events"},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0984"))
    delivery = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "DELIVER"))
    assert delivery.form_extra["delivery_direction"] == "SELL"
    assert order.form_extra["sell_bound_phone"] == "13900000001"
    assert order.account_snapshot["bound_phone_owner"] == "张三"


@pytest.mark.parametrize(("order_type", "resell"), [("HS", False), ("TH", False), ("HS", True)])
def test_unbound_historical_sale_cancellation_retains_order_lifecycle(seeded_client, seeded_db, headers, order_type, resell):
    from datetime import date
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.business.orders.events import post_event
    from app.domain.trade import Order, OrderEvent
    original = create_order(seeded_db, order_type=order_type, trade_date=date(2026, 10, 17), actor="pytest",
                            account_snapshot={"game_account": f"cancel-{order_type}-{resell}"})
    post_event(seeded_db, original.id, event_type="BUY", amount="30", occurred_on=date(2026, 10, 17), actor="pytest")
    sale, _ = post_event(seeded_db, original.id, event_type="SELL", sale_mode="FULL", amount="50",
                         occurred_on=date(2026, 10, 18), actor="pytest")
    post_event(seeded_db, original.id, event_type="CANCEL", amount="50", offset_event_id=sale.id,
               occurred_on=date(2026, 10, 19), actor="pytest", reason="售出取消")
    latest = sale
    if resell:
        latest, _ = post_event(seeded_db, original.id, event_type="SELL", sale_mode="FULL", amount="60",
                               occurred_on=date(2026, 10, 20), actor="pytest")
    seeded_db.commit()
    execution = seeded_client.get(f"/api/orders/{original.id}/execution-detail", headers=headers)
    assert execution.status_code == 200, execution.text
    assert execution.json()["orders"][0]["latest_sale_event_id"] == latest.id
    export = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": original.order_no})
    source = load_workbook(BytesIO(export.content))
    target = f"{order_type}0984"
    book = Workbook()
    book.active.title = "主订单信息"
    book.active.append(["订单号", "入库时间", "业务类型", "游戏账号/产品"])
    book.active.append([target, "2026-10-17", order_type, "未绑定历史账号"])
    events = book.create_sheet("操作明细")
    for cells in source["操作明细"].values:
        events.append([cell.replace(original.order_no, target) if isinstance(cell, str) else cell for cell in cells])
    output = BytesIO()
    book.save(output)
    result = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": "events"},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == target))
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id).order_by(OrderEvent.id)).all()
    assert events[2].offset_event_id == events[1].id and order.account_id is None
    assert order.status == ("COMPLETED" if resell else "ACTIVE")


def test_event_split_between_multiple_accounts_imports_without_double_counting(seeded_client, seeded_db, headers):
    from datetime import date
    from decimal import Decimal
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.business.orders.events import post_event
    from app.domain.foundation import Pool
    from app.domain.trade import Cashflow, Order, OrderEvent
    from app.finance.cashflow.writes.create import create_cashflow
    from app.shared.order_amounts import order_cashflow_profit
    other_pool = Pool(code="split-import", name="分账测试", created_by="pytest", updated_by="pytest")
    seeded_db.add(other_pool)
    seeded_db.flush()
    original = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest")
    event, first = post_event(seeded_db, original.id, event_type="SELL", sale_mode="FULL", portion="GROSS",
                              amount="100", occurred_on=date(2026, 10, 18), actor="pytest")
    first.amount = Decimal("60.00")
    first.operator_user_ids = [11]
    create_cashflow(seeded_db, pool_id=other_pool.id, occurred_on=date(2026, 10, 18), direction="IN",
                    category="SELL", accounting_attribute=first.accounting_attribute, amount="40", actor="pytest",
                    order_id=original.id, source_type="ORDER_EVENT", source_id=event.event_no, operator_user_ids=[12])
    seeded_db.commit()
    export = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": original.order_no})
    source = load_workbook(BytesIO(export.content))
    book = Workbook()
    book.active.title = "主订单信息"
    book.active.append(["订单号", "入库时间", "业务类型"])
    book.active.append(["DG0989", "2026-10-17", "代挂"])
    for title in ("操作明细", "资金明细"):
        sheet = book.create_sheet(title)
        for index, cells in enumerate(source[title].values):
            row = [cell.replace(original.order_no, "DG0989") if isinstance(cell, str) else cell for cell in cells]
            if title == "资金明细" and index:
                row[1] = f"SR{9800 + index:05d}"
            sheet.append(row)
    output = BytesIO()
    book.save(output)
    result = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": ["events", "cashflows"]},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0989"))
    imported_event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    flows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()
    assert sorted(flow.amount for flow in flows) == [Decimal("40.00"), Decimal("60.00")]
    assert len({flow.pool_id for flow in flows}) == 2
    assert all(flow.source_id == imported_event.event_no for flow in flows)
    assert {flow.amount: flow.operator_user_ids for flow in flows} == {Decimal("60.00"): [11], Decimal("40.00"): [12]}
    assert order_cashflow_profit(seeded_db, order.id) == Decimal("100.00")
    repeated = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "update", "sections": ["events", "cashflows"]},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert repeated.status_code == 200, repeated.text
    assert len(seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()) == 2
