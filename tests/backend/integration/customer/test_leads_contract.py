"""PARTY-01 CUS-02 客户需求池契约测试。"""
from __future__ import annotations

from datetime import date, datetime
import csv
import io
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from app.business.orders.create import create_order
from app.business.shared.form_config.form_fields import create_order_form_field
from app.domain.trade import OrderFormField
from app.customers.customers import create_customer
from app.customers.counterparties import create_counterparty
from app.customers.leads import close_lead, convert_lead, create_lead
from app.core.errors import Conflict, Validation
from app.customers.customer_merge import merge_customers
from app.customers.customers import set_customer_status, update_customer
from app.domain.base import Base
from app.domain.parties import Customer, CustomerLead, OrderCustomerRole
from app.domain.users import User
from app.settings.field_definitions.seeds import seed_foundation

pytestmark = pytest.mark.db


@pytest.fixture
def concurrent_customer_factory(v1_engine):
    database = f"heijin_customer_race_test_{uuid4().hex}"
    admin = create_engine(v1_engine.url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    engine = create_engine(v1_engine.url.set(database=database), pool_size=4)
    try:
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False)
        with factory() as session:
            seed_foundation(session, actor="pytest", include_example_data=True)
            session.add(User(username="pytest", display_name="测试", password_hash="unused"))
            session.commit()
        yield factory
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}"')
        admin.dispose()


@pytest.mark.parametrize("first_action", ["close", "convert"])
def test_competing_lead_actions_recheck_latest_status(concurrent_customer_factory, first_action):
    factory = concurrent_customer_factory
    with factory() as session:
        customer = create_customer(session, display_name="并发需求", actor="pytest")
        order = create_order(session, order_type="HS", trade_date=date(2026, 11, 1), actor="pytest")
        lead = create_lead(session, customer_id=customer.id, request_type="FIND_ACCOUNT", target="测试", actor="pytest")
        lead_id, order_no = lead.id, order.order_no
        session.commit()

    def perform(session, action):
        if action == "close":
            close_lead(session, lead_id, reason="结束", actor="pytest")
        else:
            convert_lead(session, lead_id, order_no=order_no, actor="pytest")

    ready, proceed, waiting = Event(), Event(), Event()

    def competitor():
        with factory() as session:
            stale = session.get(CustomerLead, lead_id)
            assert stale.status == "OPEN"
            def before(_conn, _cursor, statement, _parameters, _context, _many):
                sql = statement.lower()
                if ("from customer_leads" in sql and "for update" in sql) or "update customer_leads" in sql:
                    waiting.set()
            event.listen(session.connection(), "before_cursor_execute", before)
            ready.set()
            assert proceed.wait(10)
            try:
                perform(session, "convert" if first_action == "close" else "close")
                session.commit()
                return "accepted"
            except Conflict:
                session.rollback()
                return "rejected"

    with ThreadPoolExecutor(max_workers=1) as executor, factory() as first:
        future = executor.submit(competitor)
        try:
            assert ready.wait(10)
            perform(first, first_action)
            proceed.set()
            assert waiting.wait(10)
            first.commit()
            assert future.result(timeout=10) == "rejected"
        finally:
            proceed.set()
            first.rollback()
    with factory() as session:
        lead = session.get(CustomerLead, lead_id)
        assert lead.status == ("CLOSED" if first_action == "close" else "CONVERTED")
        assert (lead.converted_order_id is None) == (first_action == "close")
        assert (lead.closed_reason is None) == (first_action == "convert")


@pytest.mark.parametrize("second_action", ["merge", "create_lead", "update", "disable"])
def test_customer_merge_serializes_competing_writes(concurrent_customer_factory, second_action):
    factory = concurrent_customer_factory
    with factory() as session:
        source = create_customer(session, display_name="源客户", actor="pytest")
        target = create_customer(session, display_name="目标客户", actor="pytest")
        other = create_customer(session, display_name="另一目标", actor="pytest")
        order = create_order(session, order_type="HS", trade_date=date(2026, 11, 1), actor="pytest", customer_roles=[(source.id, "SELLER")])
        source_id, target_id, other_id, order_id = source.id, target.id, other.id, order.id
        session.commit()
    ready, proceed, waiting = Event(), Event(), Event()

    def competitor():
        with factory() as session:
            stale = session.get(Customer, source_id)
            assert stale.status == "ACTIVE"
            def before(_conn, _cursor, statement, _parameters, _context, _many):
                sql = statement.lower()
                if ("from customers" in sql and ("for update" in sql or "for key share" in sql)) or "update customers" in sql or "insert into customer_leads" in sql:
                    waiting.set()
            event.listen(session.connection(), "before_cursor_execute", before)
            ready.set()
            assert proceed.wait(10)
            try:
                if second_action == "merge":
                    merge_customers(session, source_customer_id=source_id, target_customer_id=other_id, reason="重复", actor="pytest")
                elif second_action == "create_lead":
                    create_lead(session, customer_id=source_id, request_type="FIND_ACCOUNT", target="测试", actor="pytest")
                elif second_action == "update":
                    update_customer(session, source_id, display_name="不应写入", actor="pytest")
                else:
                    set_customer_status(session, source_id, "DISABLED", actor="pytest")
                session.commit()
                return "accepted"
            except (Conflict, Validation):
                session.rollback()
                return "rejected"

    with ThreadPoolExecutor(max_workers=1) as executor, factory() as first:
        future = executor.submit(competitor)
        try:
            assert ready.wait(10)
            merge_customers(first, source_customer_id=source_id, target_customer_id=target_id, reason="重复", actor="pytest")
            proceed.set()
            assert waiting.wait(10)
            first.commit()
            assert future.result(timeout=10) == "rejected"
        finally:
            proceed.set()
            first.rollback()
    with factory() as session:
        source = session.get(Customer, source_id)
        assert source.status == "MERGED" and source.merged_into_id == target_id
        assert source.display_name == "源客户"
        assert session.scalar(select(OrderCustomerRole.customer_id).where(OrderCustomerRole.order_id == order_id)) == target_id
        assert not session.scalars(select(CustomerLead).where(CustomerLead.customer_id == source_id)).all()


def test_merge_waits_for_new_lead_then_migrates_it(concurrent_customer_factory):
    factory = concurrent_customer_factory
    with factory() as session:
        source = create_customer(session, display_name="源客户", actor="pytest")
        target = create_customer(session, display_name="目标客户", actor="pytest")
        source_id, target_id = source.id, target.id
        session.commit()
    reached = Event()

    def merge():
        with factory() as session:
            def before(_conn, _cursor, statement, _parameters, _context, _many):
                sql = statement.lower()
                if ("from customers" in sql and "for update" in sql) or "update customers" in sql:
                    reached.set()
            event.listen(session.connection(), "before_cursor_execute", before)
            merge_customers(session, source_customer_id=source_id, target_customer_id=target_id, reason="重复", actor="pytest")
            session.commit()

    with ThreadPoolExecutor(max_workers=1) as executor, factory() as first:
        lead = create_lead(first, customer_id=source_id, request_type="FIND_ACCOUNT", target="并发需求", actor="pytest")
        lead_id = lead.id
        future = executor.submit(merge)
        try:
            assert reached.wait(10)
            first.commit()
            future.result(timeout=10)
        finally:
            first.rollback()
    with factory() as session:
        assert session.get(CustomerLead, lead_id).customer_id == target_id


def test_lead_conditional_field_can_depend_on_core_fields(seeded_client, seeded_db, headers):
    customer = create_customer(seeded_db, display_name="条件需求客户", actor="pytest")
    seeded_db.add(OrderFormField(order_type_code="LEAD", field_key="request_type", label="需求类型",
                                 field_type="SELECT", is_active=True, is_custom=False, created_by="pytest", updated_by="pytest"))
    note = create_order_form_field(seeded_db, order_type_code="LEAD", field_key="request_note",
                                   label="需求说明", actor="pytest")
    note.required_when = {"field": "request_type", "op": "eq", "values": ["FIND_ACCOUNT"]}
    seeded_db.commit()
    payload = {"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "测试"}
    missing = seeded_client.post("/api/leads", json=payload, headers=headers)
    assert missing.status_code == 422, missing.text
    assert "request_note" in missing.text
    saved = seeded_client.post("/api/leads", json={**payload, "extra_values": {"request_note": "指定条件"}}, headers=headers)
    assert saved.status_code == 201, saved.text


@pytest.mark.parametrize(("action", "scope", "dependency"), [
    ("close", "LEADCLOSE", "reason"), ("convert", "LEADCONVERT", "order_id"),
])
def test_lead_action_conditional_field_can_depend_on_core_fields(seeded_client, seeded_db, headers, action, scope, dependency):
    customer = create_customer(seeded_db, display_name="操作条件客户", actor="pytest")
    lead = create_lead(seeded_db, customer_id=customer.id, request_type="FIND_ACCOUNT", target="测试", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest")
    seeded_db.add(OrderFormField(order_type_code=scope, field_key=dependency, label="操作字段", field_type="TEXT",
                                 is_active=True, is_custom=False, created_by="pytest", updated_by="pytest"))
    note = create_order_form_field(seeded_db, order_type_code=scope, field_key="action_note", label="操作说明", actor="pytest")
    note.required_when = {"field": dependency, "op": "filled"}
    seeded_db.commit()
    payload = {"reason": "关闭"} if action == "close" else {"order_no": order.order_no}
    url = f"/api/leads/{lead.id}/{action}"
    missing = seeded_client.post(url, json=payload, headers=headers)
    assert missing.status_code == 422, missing.text
    saved = seeded_client.post(url, json={**payload, "extra_values": {"action_note": "已核对"}}, headers=headers)
    assert saved.status_code == 200, saved.text


@pytest.mark.parametrize(("action", "scope", "field_key"), [
    ("close", "LEADCLOSE", "close_note"),
    ("convert", "LEADCONVERT", "convert_note"),
])
def test_lead_actions_validate_only_their_own_fields(seeded_client, seeded_db, headers, action, scope, field_key):
    customer = create_customer(seeded_db, display_name="字段配置客户", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest")
    for field_scope, key in [("LEAD", "request_note"), ("LEADCLOSE", "close_note"), ("LEADCONVERT", "convert_note")]:
        create_order_form_field(seeded_db, order_type_code=field_scope, field_key=key,
                                label=key, required=True, actor="pytest")
    seeded_db.commit()
    payload = {"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "测试"}
    missing = seeded_client.post("/api/leads", json=payload, headers=headers)
    assert missing.status_code == 422, missing.text
    assert "request_note" in missing.text
    created = seeded_client.post("/api/leads", json={**payload, "extra_values": {"request_note": "建档凭据"}}, headers=headers)
    assert created.status_code == 201, created.text
    lead_id = created.json()["id"]
    url = f"/api/leads/{lead_id}/{action}"
    action_payload = {"reason": "结束"} if action == "close" else {"order_no": order.order_no}
    missing_action = seeded_client.post(url, json=action_payload, headers=headers)
    assert missing_action.status_code == 422, missing_action.text
    assert field_key in missing_action.text
    done = seeded_client.post(url, json={**action_payload, "extra_values": {field_key: "操作凭据"}}, headers=headers)
    assert done.status_code == 200, done.text
    assert done.json()["extra_values"] == {"request_note": "建档凭据", field_key: "操作凭据"}


def test_customer_center_creation_period_filters_lists_summaries_and_export(seeded_client, seeded_db, headers):
    customers = [create_customer(seeded_db, display_name=f"周期客户{index}", actor="pytest") for index in range(2)]
    parties = [create_counterparty(seeded_db, display_name=f"周期合作方{index}", type="PEER", actor="pytest") for index in range(2)]
    leads = [create_lead(seeded_db, customer_id=customer.id, request_type="FIND_ACCOUNT", target=f"周期需求{index}", actor="pytest") for index, customer in enumerate(customers)]
    for group in (customers, parties, leads):
        group[0].created_at = datetime(2026, 12, 15, 23, 59, 59)
        group[1].created_at = datetime(2026, 12, 16, 0, 0, 0)
    seeded_db.flush()
    params = {"created_from": "2026-11-16", "created_to": "2026-12-15"}
    for path, target in (("/api/customers", customers[0]), ("/api/counterparties/page", parties[0]), ("/api/leads/page", leads[0])):
        response = seeded_client.get(path, params=params, headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["total"] == 1
        assert [item["id"] for item in response.json()["items"]] == [target.id]
    summary = seeded_client.get("/api/leads/summary", params=params, headers=headers)
    assert summary.json() == {"total_count": 1, "open_count": 1}
    exported = seeded_client.get("/api/customers/export.csv", params=params, headers=headers)
    assert "周期客户0" in exported.text and "周期客户1" not in exported.text
    assert seeded_client.get("/api/customers", params={"created_from": "2026-12-16", "created_to": "2026-12-15"}, headers=headers).status_code == 422


@pytest.mark.parametrize("descending", [False, True])
def test_customer_export_matches_list_order_and_filters(seeded_client, seeded_db, headers, descending):
    customers = [create_customer(seeded_db, display_name=f"导出排序{index}", actor="pytest") for index in range(3)]
    customers[0].created_at = datetime(2026, 1, 1, 10)
    customers[1].created_at = datetime(2026, 1, 2, 10)
    customers[2].created_at = datetime(2026, 1, 2, 10)
    create_customer(seeded_db, display_name="不属于筛选", actor="pytest")
    seeded_db.flush()
    params = {"keyword": "导出排序", "sort_desc": str(descending).lower()}
    listed = seeded_client.get("/api/customers", params=params, headers=headers)
    exported = seeded_client.get("/api/customers/export.csv", params=params, headers=headers)
    assert listed.status_code == 200, listed.text
    assert exported.status_code == 200, exported.text
    rows = list(csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig"))))
    assert [row["客户编号"] for row in rows] == [item["customer_no"] for item in listed.json()["items"]]


def test_lead_lifecycle_and_manual_order_conversion(seeded_client, seeded_db, headers):
    customer = create_customer(
        seeded_db, display_name="需求客户", owner_id=9, actor="pytest"
    )

    created = seeded_client.post(
        "/api/leads",
        json={
            "customer_id": customer.id,
            "request_type": "FIND_ACCOUNT",
            "budget": "2000.00",
            "target": "王者荣耀 安卓区",
            "note": "优先找带二次号",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    lead = created.json()
    assert lead["lead_no"].startswith("REQ")
    assert lead["status"] == "OPEN"
    assert lead["customer_display_name"] == "需求客户"
    assert lead["customer_display_name"] == "需求客户"

    listed = seeded_client.get(
        "/api/leads",
        params={"customer_id": customer.id, "status": "OPEN"},
        headers=headers,
    )
    assert listed.status_code == 200, listed.text
    assert [item["lead_no"] for item in listed.json()] == [lead["lead_no"]]
    assert listed.json()[0]["customer_display_name"] == "需求客户"

    paged = seeded_client.get(
        "/api/leads/page",
        params={"limit": 10, "offset": 0},
        headers=headers,
    )
    assert paged.status_code == 200, paged.text
    page = paged.json()
    assert page["total"] == 1
    assert page["limit"] == 10
    assert page["offset"] == 0
    assert page["items"][0]["customer_display_name"] == "需求客户"
    assert listed.json()[0]["customer_display_name"] == "需求客户"

    updated = seeded_client.patch(
        f"/api/leads/{lead['id']}",
        json={"budget": "2500.00", "target": "王者荣耀 安卓区 需要可换绑"},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["budget"] == "2500.00"

    order = create_order(
        seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest"
    )
    legacy = seeded_client.post(f"/api/leads/{lead['id']}/convert", json={"order_id": order.id}, headers=headers)
    assert legacy.status_code == 422, legacy.text
    missing = seeded_client.post(f"/api/leads/{lead['id']}/convert", json={"order_no": "HS-NOT-FOUND"}, headers=headers)
    assert missing.status_code == 404, missing.text
    converted = seeded_client.post(
        f"/api/leads/{lead['id']}/convert",
        json={"order_no": f"  {order.order_no.lower()}  "},
        headers=headers,
    )
    assert converted.status_code == 200, converted.text
    assert converted.json()["status"] == "CONVERTED"
    assert converted.json()["converted_order_id"] == order.id


def test_lead_keyword_search_escapes_like_wildcards(seeded_client, seeded_db, headers):
    """需求目标含 `_` 时按字面匹配，不把 `_` 当单字符通配误命中。"""
    customer = create_customer(
        seeded_db, display_name="需求搜索客户", owner_id=9, actor="pytest"
    )
    hit = seeded_client.post(
        "/api/leads",
        json={"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "王者_安卓"},
        headers=headers,
    )
    assert hit.status_code == 201, hit.text
    seeded_client.post(
        "/api/leads",
        json={"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "王者X安卓"},
        headers=headers,
    )

    listed = seeded_client.get(
        "/api/leads", params={"keyword": "王者_安卓"}, headers=headers
    )
    assert listed.status_code == 200, listed.text
    assert [item["id"] for item in listed.json()] == [hit.json()["id"]]


def test_lead_close_does_not_create_order_or_cashflow(seeded_client, seeded_db, headers):
    customer = create_customer(
        seeded_db, display_name="关闭需求客户", owner_id=9, actor="pytest"
    )
    created = seeded_client.post(
        "/api/leads",
        json={
            "customer_id": customer.id,
            "request_type": "SELL_ACCOUNT",
            "target": "暂不出售",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text

    closed = seeded_client.post(
        f"/api/leads/{created.json()['id']}/close",
        json={"reason": "客户暂缓"},
        headers=headers,
    )
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "CLOSED"
    assert closed.json()["converted_order_id"] is None


def test_get_lead_endpoint_returns_lead(seeded_client, seeded_db, headers):
    customer = create_customer(
        seeded_db, display_name="查询需求客户", owner_id=9, actor="pytest"
    )
    created = seeded_client.post(
        "/api/leads",
        json={"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "测试"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    lead_id = created.json()["id"]
    response = seeded_client.get(f"/api/leads/{lead_id}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["lead_no"] == created.json()["lead_no"]


def test_update_lead_rejects_owner_transfer_for_scoped_user(seeded_client, seeded_db, headers):
    from app.core.security import CurrentUser, build_access_token

    customer = create_customer(
        seeded_db, display_name="转交需求客户", owner_id=9, actor="pytest"
    )
    created = seeded_client.post(
        "/api/leads",
        json={"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "测试"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    lead_id = created.json()["id"]
    operator = CurrentUser.build(
        id=9, username="op", roles=["OPERATOR"], owner_scope="SELF"
    )
    op_headers = {"Authorization": f"Bearer {build_access_token(operator)}"}
    response = seeded_client.patch(
        f"/api/leads/{lead_id}", json={"owner_id": 9}, headers=op_headers
    )
    assert response.status_code == 403, response.text
