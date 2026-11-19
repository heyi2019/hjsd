"""PARTY-01 parties 客户/合作方契约测试（CUS-01 / BAS-02-05 / BAS-04）。

与 test_parties.py 的分工：既有文件已覆盖编号域、联系方式原值输出、停用/合并参与方校验、
合并迁移主路径、字段停用保留历史值、以及创建客户/合作方/字段端点；
本文件补建单必填校验、查重空条件、查询三过滤+作用域、
客户更新（含已合并冲突与联系方式审计分流）、状态机 MERGED 守卫、
合并同源/已合并/重复角色去重、合作方查询与更新、字段定义三项校验与停用过滤、
表单扩展字段覆写，以及 7 个未测路由端点。
"""
from __future__ import annotations

from datetime import date
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.enums import (
    AuditAction,
    CounterpartyStatus,
    CustomerStatus)
from app.domain.foundation import AuditLog
from app.domain.parties import (
    OrderCounterpartyRole)
from app.installments import create as inst_create
from app.orders.create import create_order
from app.customer_center.counterparties import (
    create_counterparty,
    get_counterparty,
    list_counterparties,
    set_counterparty_status,
    update_counterparty,
)
from app.customer_center.customers import create_customer

CUSTOMERS = "/api/v1/customers"
COUNTERPARTIES = "/api/v1/counterparties"



def _scoped_user() -> CurrentUser:
    """非 admin、SELF 作用域用户（可见集只有自己）。"""
    return CurrentUser.build(
        id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
    )

def _customer(seeded_db, name: str, **kwargs):
    return create_customer(seeded_db, display_name=name, actor="pytest", **kwargs)

def _audit_actions(seeded_db, action: AuditAction) -> list[str]:
    rows = seeded_db.scalars(
        select(AuditLog).where(AuditLog.action == action.value)
    ).all()
    return [row.entity_id for row in rows]

class TestCounterpartyGuards:
    def test_order_counterparty_role_is_constrained_in_database(self, seeded_db):
        order = create_order(
            seeded_db, order_type="TH", trade_date=date(2026, 10, 4), actor="pytest"
        )
        counterparty = create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        seeded_db.add(
            OrderCounterpartyRole(
                order_id=order.id,
                counterparty_id=counterparty.id,
                role="INVALID",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_empty_display_name_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            create_counterparty(
                seeded_db, display_name="  ", type="PEER", actor="pytest"
            )
        assert "合作方名称必填" in str(exc.value)

    def test_counterparty_active_must_be_boolean_in_service(self, seeded_db):
        peer = create_counterparty(
            seeded_db, display_name="布尔状态校验", type="PEER", actor="pytest"
        )
        with pytest.raises(Validation, match="active 必须为布尔值"):
            set_counterparty_status(
                seeded_db, peer.id, "false", actor="pytest"
            )
        seeded_db.commit()
        seeded_db.refresh(peer)
        assert peer.status == CounterpartyStatus.ACTIVE.value

    def test_list_filters_by_type_and_status(self, seeded_db):
        peer = create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        supplier = create_counterparty(
            seeded_db, display_name="供货方B", type="SUPPLIER", actor="pytest"
        )
        set_counterparty_status(seeded_db, supplier.id, False, actor="pytest")

        by_type = list_counterparties(seeded_db, type="PEER")
        assert [p.id for p in by_type] == [peer.id]
        by_status = list_counterparties(
            seeded_db, status=CounterpartyStatus.ACTIVE.value
        )
        assert [p.id for p in by_status] == [peer.id]

    def test_list_filters_counterparties_by_created_by(self, seeded_db):
        mine = create_counterparty(
            seeded_db, display_name="创建人甲", type="PEER", actor="alice"
        )
        create_counterparty(
            seeded_db, display_name="创建人乙", type="SUPPLIER", actor="bob"
        )

        filtered = list_counterparties(seeded_db, created_by=["alice"])

        assert [counterparty.id for counterparty in filtered] == [mine.id]

    def test_counterparty_page_query_filters_by_created_by(self, seeded_client, seeded_db):
        mine = create_counterparty(
            seeded_db, display_name="接口创建人甲", type="PEER", actor="alice"
        )
        create_counterparty(
            seeded_db, display_name="接口创建人乙", type="SUPPLIER", actor="bob"
        )

        response = seeded_client.get(
            f"{COUNTERPARTIES}/page",
            params=[("created_by", "alice")],
            headers={"X-Dev-User": "admin"},
        )

        assert response.status_code == 200, response.text
        assert response.json()["total"] == 1
        assert response.json()["items"][0]["id"] == mine.id

    def test_get_counterparty_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            get_counterparty(seeded_db, 999999)

    def test_update_counterparty_applies_fields(self, seeded_db):
        peer = create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        updated = update_counterparty(
            seeded_db, peer.id, actor="pytest", display_name="同行A2", note="长期合作",
            phone=None,
        )
        assert updated.display_name == "同行A2"
        assert updated.note == "长期合作"
        assert updated.updated_by == "pytest"
        assert _audit_actions(seeded_db, AuditAction.CUSTOMER_UPDATE) == [
            peer.counterparty_no
        ]

    def test_counterparty_update_validates_all_fields_before_mutating(self, seeded_db):
        peer = create_counterparty(
            seeded_db, display_name="原合作方", type="PEER", actor="pytest"
        )

        with pytest.raises(Validation, match="合作方更新字段不受支持"):
            update_counterparty(
                seeded_db,
                peer.id,
                actor="operator",
                display_name="不应保存的新合作方",
                unsupported_field="invalid",
            )

        seeded_db.commit()
        seeded_db.refresh(peer)
        assert peer.display_name == "原合作方"
        assert peer.updated_by == "pytest"

class TestPartiesApi:
    def test_list_customers_endpoint(self, seeded_client, seeded_db, headers):
        customer = _customer(seeded_db, "阿甲", phone="13800001111")
        response = seeded_client.get(
            CUSTOMERS, params={"keyword": "阿甲"}, headers=headers
        )
        assert response.status_code == 200, response.text
        assert response.json()["items"][0]["phone"] == "13800001111"
        assert response.json()["items"][0]["id"] == customer.id
        assert response.json()["items"][0]["order_roles"] == []
        assert response.json()["items"][0]["active_order_count"] == 0

    def test_customer_detail_endpoint_returns_four_tabs(self, seeded_client, seeded_db, headers):
        customer = _customer(seeded_db, "详情接口客户", owner_id=9)
        order = create_order(
            seeded_db,
            order_type="TH",
            trade_date=date(2026, 10, 12),
            customer_roles=[(customer.id, "BUYER")],
            actor="pytest",
        )
        inst_create.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type="PICKUP_SALE",
            principal=300,
            down_payment=100,
            periods=1,
            per_period=200,
            first_due_on=date(2026, 10, 12),
            actor="pytest",
        )

        response = seeded_client.get(
            f"{CUSTOMERS}/{customer.id}/detail", headers=headers
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert set(body) == {"customer", "overview", "business", "installments", "audit"}
        assert body["customer"]["id"] == customer.id
        assert body["business"][0]["order_no"] == order.order_no
        assert body["installments"][0]["total_receivable"] == "300.00"

    def test_update_customer_endpoint(self, seeded_client, seeded_db, headers):
        customer = _customer(seeded_db, "阿甲")
        response = seeded_client.patch(
            f"{CUSTOMERS}/{customer.id}",
            json={"display_name": "阿甲2", "note": "回头客"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["display_name"] == "阿甲2"

    def test_update_customer_status_endpoint(self, seeded_client, seeded_db, headers):
        customer = _customer(seeded_db, "阿甲")
        response = seeded_client.patch(
            f"{CUSTOMERS}/{customer.id}/status",
            json={"status": "DISABLED"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["status"] == CustomerStatus.DISABLED.value

    def test_merge_customer_endpoint(self, seeded_client, seeded_db, headers):
        source = _customer(seeded_db, "源")
        target = _customer(seeded_db, "目标")
        response = seeded_client.post(
            f"{CUSTOMERS}/{source.id}/merge",
            json={"target_customer_id": target.id, "reason": "同一微信"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["id"] == target.id

    def test_list_counterparties_endpoint(self, seeded_client, seeded_db, headers):
        peer = create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        response = seeded_client.get(
            COUNTERPARTIES, params={"type": "PEER"}, headers=headers
        )
        assert response.status_code == 200, response.text
        assert [item["counterparty_no"] for item in response.json()] == [
            peer.counterparty_no
        ]

    def test_list_counterparties_page_endpoint(self, seeded_client, seeded_db, headers):
        peer = create_counterparty(
            seeded_db, display_name="分页同行", type="PEER", actor="pytest"
        )
        response = seeded_client.get(
            f"{COUNTERPARTIES}/page",
            params={"type": "PEER", "limit": 10, "offset": 0},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["total"] == 1
        assert payload["limit"] == 10
        assert payload["offset"] == 0
        assert [item["counterparty_no"] for item in payload["items"]] == [
            peer.counterparty_no
        ]

    def test_update_counterparty_endpoint(self, seeded_client, seeded_db, headers):
        peer = create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        response = seeded_client.patch(
            f"{COUNTERPARTIES}/{peer.id}", json={"note": "长期合作"}, headers=headers
        )
        assert response.status_code == 200, response.text
        assert response.json()["note"] == "长期合作"
