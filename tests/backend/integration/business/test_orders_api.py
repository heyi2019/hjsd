"""API-01 订单 HTTP API 契约：TestOrdersApi 拆出（17 tests）。"""

from __future__ import annotations

from datetime import date
from uuid import uuid4

from app.shared.audit import record_audit
from app.core.security import CurrentUser, DEV_USERS, build_access_token
from app.domain.enums import (
    AuditAction)
from app.business.stocks.profile import create_account
from app.funds.installments import create as inst_create
from app.funds.rebates import create_rebate
from app.business.create import create_order
from app.business.events import post_event

D = date(2026, 10, 4)

def _order(
    seeded_db,
    *,
    order_type="HS",
    account_id=None,
    owner_id=None,
    trade_date=D,
    form_extra=None,
):
    if order_type == "HS" and account_id is None:
        account_id = create_account(
            seeded_db,
            game_account=f"orders-contract-{uuid4().hex[:10]}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        ).id
    return create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id, owner_id=owner_id,
        form_extra=form_extra,
    )

def _scoped_user() -> CurrentUser:
    """非 admin、SELF 作用域用户（可见集只有自己）。"""
    return CurrentUser.build(
        id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
    )


class TestOrdersApi:

    def test_order_role_payload_requires_the_matching_participant_id(
        self, seeded_client, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": D.isoformat(),
                "customer_roles": [{"role": "SELLER"}],
            },
            headers=headers,
        )
        assert response.status_code == 422, response.text

    def test_th_account_snapshot_creates_inline_account_via_api(
        self, seeded_client, headers
    ):
        """2026-10-28 口径：TH 快照建单即建号（API 契约层）。"""
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "TH",
                "trade_date": D.isoformat(),
                "account_snapshot": {"game_account": "th-snapshot-api"},
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["account_id"] is not None
        assert body["account_snapshot"] == {"game_account": "th-snapshot-api"}

    def test_th_snapshot_with_flat_fields_rejected_by_api(
        self, seeded_client, headers
    ):
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "TH",
                "trade_date": D.isoformat(),
                "account_snapshot": {"game_account": "th-snapshot-api"},
                "game_account": "th-flat-api",
            },
            headers=headers,
        )
        assert created.status_code == 422, created.text
        assert any(
            error["field"] == "game_account"
            for error in created.json()["details"]["errors"]
        )

    def test_update_and_cancel_order_api(self, seeded_client, headers):
        created = seeded_client.post(
            "/api/v1/orders",
            json={"order_type": "HS", "trade_date": D.isoformat()},
            headers=headers,
        )
        assert created.status_code == 201, created.text
        order_id = created.json()["id"]

        updated = seeded_client.patch(
            f"/api/v1/orders/{order_id}",
            json={"note": "接口补充备注"},
            headers=headers,
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["note"] == "接口补充备注"

        cancelled = seeded_client.post(
            f"/api/v1/orders/{order_id}/cancel",
            json={"reason": "接口撤单"},
            headers=headers,
        )
        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()["status"] == "CANCELLED"

    def test_scoped_user_cannot_assign_created_order_to_other_owner(
        self, seeded_client, seeded_db
    ):
        user = _scoped_user()
        scoped_headers = {"Authorization": f"Bearer {build_access_token(user)}"}
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": D.isoformat(),
                "owner_id": 1,
            },
            headers=scoped_headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["owner_id"] == user.id

    def test_admin_created_order_defaults_owner_to_operator(self, seeded_client, headers):
        """未指定负责人时兜底为操作人本人：owner_id 落 NULL 会让单据在按归属过滤后
        对 SELF 用户永久不可见（历史 153 单曾因此全为 NULL）。"""
        response = seeded_client.post(
            "/api/v1/orders",
            json={"order_type": "HS", "trade_date": D.isoformat()},
            headers=headers,
        )

        assert response.status_code == 201, response.text
        assert response.json()["owner_id"] == DEV_USERS["admin"].id

    def test_dg_creation_rejects_legacy_settlement_terms(
        self, seeded_client, seeded_db, headers
    ):
        # 佣金口径已在建单接口打通，这里只保留「旧结算字段被拒」的断言。
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "DG",
                "trade_date": D.isoformat(),
                "listing_price": "1200.00",
                "service_fee": "120.00",
                "expected_settlement_date": "2026-10-20",
            },
            headers=headers,
        )

        assert response.status_code == 422, response.text
        assert "Extra inputs are not permitted" in response.text

    def test_embedded_installment_schedule_rejects_unknown_fields(
        self, seeded_client, headers
    ):
        response = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "TH",
                "trade_date": D.isoformat(),
                "installment": {
                    "contract_type": "PICKUP_SALE",
                    "principal": "800.00",
                    "periods": 1,
                    "first_due_on": "2026-11-01",
                    "schedule": [
                        {
                            "period_no": 1,
                            "due_on": "2026-11-01",
                            "unknown_field": "must be rejected",
                        }
                    ],
                },
            },
            headers=headers,
        )
        assert response.status_code == 422, response.text

    def test_list_and_get_endpoints(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="pytest",
        )
        listed = seeded_client.get(
            "/api/v1/orders", params={"order_type": "HS", "status": "ACTIVE"},
            headers=headers,
        )
        assert listed.status_code == 200, listed.text
        assert [item["order_no"] for item in listed.json()["items"]] == [order.order_no]

        fetched = seeded_client.get(f"/api/v1/orders/{order.id}", headers=headers)
        assert fetched.status_code == 200
        assert fetched.json()["id"] == order.id
        assert len(fetched.json()["events"]) == 1
        assert fetched.json()["events"][0]["event_type"] == "BUY"
        assert fetched.json()["events"][0]["operator"] == "-"

        missing = seeded_client.get("/api/v1/orders/999999", headers=headers)
        assert missing.status_code == 404

    def test_detail_operator_uses_selected_employee_not_audit_actor(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db)
        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="100.00",
            occurred_on=D,
            actor="login-auditor",
            operator_user_ids=[9],
        )

        fetched = seeded_client.get(f"/api/v1/orders/{order.id}", headers=headers)
        assert fetched.status_code == 200, fetched.text
        assert fetched.json()["events"][0]["operator"] == "种子用户9"
        assert fetched.json()["cashflows"][0]["operator"] == "种子用户9"

    def test_order_detail_aggregates_finance_installment_and_audit(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db)
        request_id = "order-detail-trace-20261017"
        record_audit(
            seeded_db,
            action=AuditAction.ORDER_CREATE,
            entity_type="order",
            entity_id=order.order_no,
            actor="pytest",
            request_id=request_id,
        )
        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="100.00",
            occurred_on=D,
            actor="pytest",
        )
        rebate = create_rebate(
            seeded_db,
            source_order_id=order.id,
            rebate_type="BUY",
            amount="100.00",
            collected_on=D,
            actor="pytest",
        )
        installment = inst_create.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type="STOCK_SALE",
            principal="100.00",
            periods=1,
            per_period="100.00",
            first_due_on=D,
            actor="pytest",
        )

        response = seeded_client.get(f"/api/v1/orders/{order.id}", headers=headers)

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["cashflows"][0]["source_type"] == "ORDER_EVENT"
        assert body["cashflows"][0]["flow_no"]
        assert body["rebates"][0]["id"] == rebate.id
        assert body["installment"]["id"] == installment.id
        assert len(body["installment_schedule"]) >= 1
        assert any(item["period_no"] == 1 for item in body["installment_schedule"])
        order_audit = next(
            item for item in body["audit"] if item["request_id"] == request_id
        )
        assert order_audit["request_id"] == request_id

    def test_pool_balance_endpoint_scope_forbidden(self, seeded_client, viewer_headers):
        # viewer 有 finance.read 但无池授权 → 越权池返回 404（不泄露存在性）
        response = seeded_client.get("/api/v1/pools/1/balance", headers=viewer_headers)
        assert response.status_code == 404

    def test_pool_balance_endpoint_ok(self, seeded_client, headers):
        response = seeded_client.get("/api/v1/pools/1/balance", headers=headers)
        assert response.status_code == 200, response.text
        assert "available" in response.json()

