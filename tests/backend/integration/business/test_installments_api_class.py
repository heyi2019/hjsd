"""API-01 分期 HTTP API 契约：TestInstallmentsApi 拆出（12 tests）。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
import pytest
from sqlalchemy import select
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import (
    EventType,
    InstallmentContractType,
    InstallmentStatus,
    ScheduleStatus)
from app.domain.trade import Installment, InstallmentSchedule, OrderEvent
from app.domain.trade import Cashflow, Account, Order, OrderFormField
from app.domain.foundation import Pool
from app.domain.parties import Customer, OrderCustomerRole
from app.core.database import get_db
from app.funds.installments import create as inst_create
from app.funds.installments import recovery as inst_recovery
from app.funds.installments.repayments.pay import pay as inst_pay
from app.business.create import create_order
from app.business.events import post_event
from app.business.form_fields import create_order_form_field

TODAY = date(2026, 10, 12)
PAST = date(2026, 9, 1)

def _account(seeded_db, game_account: str):
    from app.business.stocks.profile import create_account

    return create_account(
        seeded_db,
        game_account=game_account,
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )

def _order(seeded_db, *, order_type="TH", account_id=None, owner_id=None, trade_date=TODAY):
    return create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id, owner_id=owner_id,
    )

def _buy(seeded_db, order_id: int, amount="800"):
    post_event(
        seeded_db, order_id, event_type="BUY", amount=Decimal(amount),
        occurred_on=TODAY, actor="pytest",
    )

def _contract(
    seeded_db,
    order_id: int,
    *,
    contract_type=InstallmentContractType.PICKUP_SALE.value,
    principal=None,
    down_payment="100",
    periods=2,
    per_period="300",
    first_due_on=TODAY,
    **kwargs,
) -> Installment:
    if principal is None:
        principal = str(Decimal(down_payment) + Decimal(per_period) * periods)
    return inst_create.create_installment(
        seeded_db,
        order_id=order_id,
        contract_type=contract_type,
        principal=Decimal(principal),
        down_payment=Decimal(down_payment),
        periods=periods,
        per_period=Decimal(per_period),
        first_due_on=first_due_on,
        actor="pytest",
        **kwargs,
    )


class TestInstallmentsApi:
    @pytest.mark.parametrize(("action", "scope", "dependency"), [
        ("payments", "INSTPAY", "amount"),
        ("settle-early", "INSTSETTLE", "paid_on"),
        ("cancel", "INSTCANCEL", "reason"),
        ("order-cancel", "INVCANCEL", "reason"),
        ("waive", "INSTWAIVE", "reason"),
        ("extend", "INSTEXTEND", "new_due_on"),
        ("default", "INSTDEFAULT", "reason"),
        ("recover", "INSTRECOVER", "note"),
        ("resale", "INSTRESALE", "resale_order_id"),
        ("deliver", "INSTDELIVER", "delivered_on"),
    ])
    def test_installment_conditional_fields_follow_action_values(
        self, seeded_client, seeded_db, headers, action, scope, dependency,
    ):
        account = _account(seeded_db, f"conditional-installment-{action}")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, "100")
        pool = seeded_db.scalar(select(Pool).where(Pool.status == "ACTIVE"))
        created = seeded_client.post("/api/v1/installments/stock-sale", headers=headers, json={
            "order_id": order.id, "principal": "200", "down_payment": "50", "periods": 1,
            "per_period": "150", "first_due_on": TODAY.isoformat(), "paid_on": TODAY.isoformat(),
            "pool_id": pool.id, "operator_user_ids": [1],
        })
        assert created.status_code == 201, created.text
        contract = seeded_db.get(Installment, created.json()["id"])
        base = f"/api/v1/installments/{contract.id}"
        if action in {"default", "recover"}:
            contract.status = "OVERDUE"
        elif action == "resale":
            contract.status = "CLOSED"
        elif action == "deliver":
            settled = seeded_client.post(f"{base}/settle-early", headers=headers, json={"paid_on": TODAY.isoformat()})
            assert settled.status_code == 200, settled.text
        seeded_db.flush()

        if action == "payments":
            url, payload = f"{base}/payments", {"amount": "25", "paid_on": TODAY.isoformat(), "period_no": 1}
        elif action == "settle-early":
            url, payload = f"{base}/settle-early", {"paid_on": TODAY.isoformat()}
        elif action in {"cancel", "order-cancel"}:
            url, payload = f"{base}/{action}", {"cancelled_on": TODAY.isoformat(), "reason": "取消原因"}
        elif action == "waive":
            url, payload = f"{base}/schedules/1/waive", {"amount": "25", "waived_on": TODAY.isoformat(), "reason": "减免原因"}
        elif action == "extend":
            url, payload = f"{base}/schedules/1/extend", {"new_due_on": "2027-01-12", "reason": "展期原因"}
        elif action == "default":
            url, payload = f"{base}/default", {"reason": "违约原因"}
        elif action == "recover":
            url, payload = f"{base}/recover", {"occurred_on": TODAY.isoformat(), "note": "回收说明"}
        elif action == "resale":
            url, payload = f"{base}/resale", {"occurred_on": TODAY.isoformat(), "note": "出售说明", "resale_order_id": 999999}
        else:
            url, payload = f"{base}/deliver", {"delivered_on": TODAY.isoformat(), "note": "换绑凭证", "operator_user_ids": [1]}

        core_field = seeded_db.scalar(select(OrderFormField).where(
            OrderFormField.order_type_code == scope, OrderFormField.field_key == dependency,
        ))
        if core_field is None:
            core_field = create_order_form_field(seeded_db, order_type_code=scope, field_key=dependency,
                                                 label="依赖字段", actor="pytest")
            core_field.is_custom = False
            seeded_db.flush()
        create_order_form_field(
            seeded_db, order_type_code=scope, field_key="receipt", label="条件凭据", actor="pytest",
            required_when={"field": dependency, "op": "filled"},
        )
        seeded_db.commit()
        missing = seeded_client.post(url, headers=headers, json=payload)
        assert missing.status_code == 422, missing.text
        assert "条件凭据" in missing.text
        spoofed = seeded_client.post(url, headers=headers, json={**payload, "form_extra": {dependency: ""}})
        assert spoofed.status_code == 422, spoofed.text
        assert "条件凭据" in spoofed.text
        saved = seeded_client.post(url, headers=headers, json={**payload, "form_extra": {"receipt": "凭据A"}})
        if action == "resale":
            assert saved.status_code == 422 and "出售必须关联新的售出订单" in saved.text
        else:
            assert saved.status_code == 200, saved.text
            seeded_db.refresh(contract)
            assert contract.form_extra["receipt"] == "凭据A"

    @pytest.mark.parametrize(("action", "scope", "other_scope"), [
        ("payments", "INSTPAY", "INSTSETTLE"),
        ("settle-early", "INSTSETTLE", "INSTPAY"),
        ("cancel", "INSTCANCEL", "INVCANCEL"),
        ("order-cancel", "INVCANCEL", "INSTCANCEL"),
    ])
    def test_installment_actions_use_their_own_fields(self, seeded_client, seeded_db, headers, action, scope, other_scope):
        account = _account(seeded_db, f"installment-fields-{action}")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, "100")
        pool = seeded_db.scalar(select(Pool).where(Pool.status == "ACTIVE"))
        created = seeded_client.post("/api/v1/installments/stock-sale", headers=headers, json={
            "order_id": order.id, "principal": "200", "down_payment": "50", "periods": 1,
            "per_period": "150", "first_due_on": TODAY.isoformat(), "paid_on": TODAY.isoformat(),
            "pool_id": pool.id, "operator_user_ids": [1],
        })
        assert created.status_code == 201, created.text
        installment_id = created.json()["id"]
        for field_scope, key, label in [
            (scope, "receipt", "本操作凭据"), (other_scope, "other_receipt", "其他操作凭据"),
            ("FUNDFLOW", "flow_receipt", "资金明细凭据"),
            ("FUNDREVERSE", "reverse_receipt", "冲销凭据"),
        ]:
            create_order_form_field(seeded_db, order_type_code=field_scope, field_key=key,
                                    label=label, required=True, actor="pytest")
        seeded_db.commit()
        if action == "payments":
            payload = {"amount": "50", "paid_on": TODAY.isoformat(), "period_no": 1, "pool_id": pool.id}
        elif action == "settle-early":
            payload = {"paid_on": TODAY.isoformat(), "pool_id": pool.id}
        else:
            payload = {"cancelled_on": TODAY.isoformat(), "reason": "取消"}
        url = f"/api/v1/installments/{installment_id}/{action}"
        missing = seeded_client.post(url, headers=headers, json=payload)
        assert missing.status_code == 422, missing.text
        assert "本操作凭据" in missing.text
        saved = seeded_client.post(url, headers=headers, json={**payload, "form_extra": {"receipt": "凭据A"}})
        assert saved.status_code == 200, saved.text
        installment = saved.json().get("installment", saved.json())
        assert installment["form_extra"]["receipt"] == "凭据A"

    def test_stock_sale_automatic_down_payment_ignores_other_forms(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "automatic-down-payment-fields")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, "100")
        for scope, key in [("INSTPAY", "pay_receipt"), ("FUNDFLOW", "flow_receipt")]:
            create_order_form_field(seeded_db, order_type_code=scope, field_key=key,
                                    label="其他表单凭据", required=True, actor="pytest")
        seeded_db.commit()
        pool = seeded_db.scalar(select(Pool).where(Pool.status == "ACTIVE"))
        response = seeded_client.post("/api/v1/installments/stock-sale", headers=headers, json={
            "order_id": order.id, "principal": "200", "down_payment": "50", "periods": 1,
            "per_period": "150", "first_due_on": TODAY.isoformat(), "paid_on": TODAY.isoformat(),
            "pool_id": pool.id, "operator_user_ids": [1],
        })
        assert response.status_code == 201, response.text
        assert Decimal(response.json()["paid_amount"]) == Decimal("50")

    @pytest.mark.parametrize(("order_type", "scope", "installment"), [
        ("HS", "SALEREC", False), ("TH", "SALETH", False), ("DG", "SALEDG", False),
        ("HS", "SALEREC", True), ("TH", "SALETH", True),
    ])
    def test_stock_sale_uses_its_own_custom_fields(self, seeded_client, seeded_db, headers, order_type, scope, installment):
        from app.business.stocks.profile import create_account

        inventory_type = {"HS": "RECOVERY", "TH": "PICKUP", "DG": "CONSIGNMENT"}[order_type]
        account = create_account(
            seeded_db, game_account=f"sale-fields-{order_type}-{installment}",
            business_mode="SELF" if order_type == "HS" else "DISTRIBUTION",
            inventory_type=inventory_type, actor="pytest",
        )
        order = _order(seeded_db, order_type=order_type, account_id=account.id)
        if order_type != "DG":
            _buy(seeded_db, order.id, "100")
        for field_scope, key, label in [
            (scope, "sale_receipt", "售出凭据"),
            ("REFUND", "cashflow_receipt", "收支凭据"),
            ("ORDEREDIT", "edit_receipt", "订单编辑凭据"),
        ]:
            create_order_form_field(seeded_db, order_type_code=field_scope, field_key=key,
                                    label=label, required=True, section="DELIVER" if field_scope == scope else "EXTRA", actor="pytest")
        seeded_db.commit()
        pool = seeded_db.scalar(select(Pool).where(Pool.status == "ACTIVE"))
        if installment:
            url = "/api/v1/installments/stock-sale"
            payload = {"order_id": order.id, "principal": "200", "down_payment": "50",
                       "periods": 1, "per_period": "150", "first_due_on": TODAY.isoformat(),
                       "paid_on": TODAY.isoformat(), "pool_id": pool.id, "operator_user_ids": [1]}
        else:
            url = f"/api/v1/orders/{order.id}/stock-sale"
            payload = {"amount": "200", "occurred_on": TODAY.isoformat(),
                       "pool_id": pool.id, "operator_user_ids": [1]}
        payload["delivery_form_extra"] = {"delivery_responsible_ids": [1]}

        missing = seeded_client.post(url, headers=headers, json=payload)
        assert missing.status_code == 422, missing.text
        assert "售出凭据" in missing.text

        created = seeded_client.post(url, headers=headers, json={**payload, "form_extra": {"sale_receipt": "凭据A"}})
        assert created.status_code == 201, created.text
        event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL"))
        assert event.form_extra["sale_receipt"] == "凭据A"
        assert seeded_db.get(Order, order.id).form_extra["sell_delivery_responsible_ids"] == [1]
        edited = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={
            "events": [{"id": event.id, "expected_amount": str(event.amount), "amount": str(event.amount),
                        "form_extra": {**event.form_extra, "sale_receipt": "凭据B"}}],
        })
        assert edited.status_code == 200, edited.text
        detail = seeded_client.get(f"/api/v1/orders/{order.id}/execution-detail", headers=headers)
        assert detail.status_code == 200, detail.text
        shown = next(item for item in detail.json()["orders"][0]["events"] if item["id"] == event.id)
        assert shown["form_extra"]["sale_receipt"] == "凭据B"

    @pytest.mark.parametrize("installment", [False, True])
    def test_stock_sale_conditional_fields_use_actual_payment_method(self, seeded_client, seeded_db, headers, installment):
        account = _account(seeded_db, f"sale-payment-condition-{installment}")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, "100")
        payment_method = create_order_form_field(
            seeded_db, order_type_code="SALEREC", field_key="payment_method",
            label="付款方式", actor="pytest",
        )
        payment_method.is_custom = False
        seeded_db.flush()
        for method, field_key, label in [
            ("FULL", "full_receipt", "全款凭据"),
            ("INSTALLMENT", "installment_receipt", "分期凭据"),
        ]:
            create_order_form_field(
                seeded_db, order_type_code="SALEREC", field_key=field_key, label=label,
                required_when={"field": "payment_method", "op": "eq", "values": [method]},
                actor="pytest",
            )
        seeded_db.commit()
        pool = seeded_db.scalar(select(Pool).where(Pool.status == "ACTIVE"))
        if installment:
            url = "/api/v1/installments/stock-sale"
            payload = {"order_id": order.id, "principal": "200", "down_payment": "50",
                       "periods": 1, "per_period": "150", "first_due_on": TODAY.isoformat(),
                       "paid_on": TODAY.isoformat(), "pool_id": pool.id, "operator_user_ids": [1]}
            field_key, expected_label, spoofed_method = "installment_receipt", "分期凭据", "FULL"
        else:
            url = f"/api/v1/orders/{order.id}/stock-sale"
            payload = {"amount": "200", "occurred_on": TODAY.isoformat(),
                       "pool_id": pool.id, "operator_user_ids": [1]}
            field_key, expected_label, spoofed_method = "full_receipt", "全款凭据", "INSTALLMENT"

        missing = seeded_client.post(url, headers=headers, json=payload)
        assert missing.status_code == 422, missing.text
        assert expected_label in missing.text

        spoofed = seeded_client.post(
            url, headers=headers, json={**payload, "form_extra": {"payment_method": spoofed_method}},
        )
        assert spoofed.status_code == 422, spoofed.text
        assert expected_label in spoofed.text

        saved = seeded_client.post(url, headers=headers, json={**payload, "form_extra": {field_key: "凭据A"}})
        assert saved.status_code == 201, saved.text
        event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL"))
        assert event.form_extra[field_key] == "凭据A"
        assert "payment_method" not in event.form_extra

    @pytest.mark.parametrize(("order_type", "installment", "dependency"), [
        ("HS", False, "amount"), ("TH", False, "pool_id"), ("DG", False, "sale_amount"),
        ("HS", False, "operator_user_ids"), ("HS", False, "customer_nickname"),
        ("TH", False, "intermediary_platform"), ("HS", False, "cashflow_note"),
        ("HS", True, "amount"), ("TH", True, "pool_id"), ("HS", True, "down_payment"),
        ("HS", True, "periods"), ("TH", True, "per_period"),
        ("HS", True, "customer_nickname"), ("TH", True, "intermediary_platform"),
    ])
    def test_stock_sale_conditions_use_actual_form_values(self, seeded_client, seeded_db, headers, order_type, installment, dependency):
        from app.business.stocks.profile import create_account

        account = create_account(seeded_db, game_account=f"sale-condition-{order_type}-{installment}-{dependency}",
            business_mode="SELF" if order_type == "HS" else "DISTRIBUTION",
            inventory_type={"HS": "RECOVERY", "TH": "PICKUP", "DG": "CONSIGNMENT"}[order_type], actor="pytest")
        order = _order(seeded_db, order_type=order_type, account_id=account.id)
        if order_type != "DG":
            _buy(seeded_db, order.id, "100")
        scope = {"HS": "SALEREC", "TH": "SALETH", "DG": "SALEDG"}[order_type]
        core = seeded_db.scalar(select(OrderFormField).where(
            OrderFormField.order_type_code == scope, OrderFormField.field_key == dependency,
        ))
        if core is None:
            core = create_order_form_field(seeded_db, order_type_code=scope, field_key=dependency,
                                           label="依赖字段", actor="pytest")
            core.is_custom = False
            seeded_db.flush()
        create_order_form_field(seeded_db, order_type_code=scope, field_key="receipt", label="售出凭据",
                                required_when={"field": dependency, "op": "filled"}, actor="pytest")
        pool = seeded_db.scalar(select(Pool).where(Pool.status == "ACTIVE"))
        if installment:
            url = "/api/v1/installments/stock-sale"
            payload = {"order_id": order.id, "principal": "200", "down_payment": "50", "periods": 2,
                       "per_period": "75", "first_due_on": TODAY.isoformat(), "paid_on": TODAY.isoformat(),
                       "pool_id": pool.id, "operator_user_ids": [1]}
        else:
            url = f"/api/v1/orders/{order.id}/stock-sale"
            payload = {"amount": "200", "sale_amount": "250", "occurred_on": TODAY.isoformat(),
                       "pool_id": pool.id, "operator_user_ids": [1], "note": "收款备注"}
        if dependency == "customer_nickname":
            payload["customer_input"] = {"display_name": "售出客户", "role": "CONSIGNOR" if order_type == "DG" else "BUYER"}
        check_other_platform = installment and dependency == "intermediary_platform"
        if dependency == "intermediary_platform":
            payload["delivery_form_extra"] = {"intermediary_platform": "测试平台"}
        if check_other_platform:
            payload["delivery_form_extra"] = {"intermediary_platform": "其他", "intermediary_platform_other": "分期平台"}
            other_field = create_order_form_field(seeded_db, order_type_code=scope, field_key="intermediary_platform_other",
                                                 label="其他平台", actor="pytest")
            other_field.is_custom = False
            seeded_db.flush()
            create_order_form_field(seeded_db, order_type_code=scope, field_key="receipt_other", label="其他平台凭据",
                                    required_when={"field": "intermediary_platform_other", "op": "filled"}, actor="pytest")
        seeded_db.commit()

        def transactional_db():
            try:
                yield seeded_db
                seeded_db.commit()
            except Exception:
                seeded_db.rollback()
                raise
        seeded_client.app.dependency_overrides[get_db] = transactional_db
        missing = seeded_client.post(url, headers=headers, json=payload)
        assert missing.status_code == 422 and "售出凭据" in missing.text
        spoofed = seeded_client.post(url, headers=headers, json={**payload, "form_extra": {dependency: ""}})
        assert spoofed.status_code == 422 and "售出凭据" in spoofed.text
        assert seeded_db.scalar(select(OrderEvent.id).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL")) is None
        receipt = {"receipt": "凭据A"}
        if check_other_platform:
            missing_other = seeded_client.post(url, headers=headers, json={**payload, "form_extra": {
                **receipt, "intermediary_platform_other": "",
            }})
            assert missing_other.status_code == 422 and "其他平台凭据" in missing_other.text
            receipt["receipt_other"] = "凭据B"
        saved = seeded_client.post(url, headers=headers, json={**payload, "form_extra": receipt})
        assert saved.status_code == 201, saved.text
        event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL"))
        assert event.form_extra["receipt"] == "凭据A"

    @pytest.mark.parametrize("installment", [False, True])
    def test_stock_sale_optional_customer_cannot_be_faked_by_extra(self, seeded_client, seeded_db, headers, installment):
        account = _account(seeded_db, f"sale-optional-customer-{installment}")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, "100")
        core = seeded_db.scalar(select(OrderFormField).where(
            OrderFormField.order_type_code == "SALEREC", OrderFormField.field_key == "customer_nickname",
        ))
        if core is None:
            core = create_order_form_field(seeded_db, order_type_code="SALEREC", field_key="customer_nickname",
                                           label="客户昵称", actor="pytest")
            core.is_custom = False
            seeded_db.flush()
        create_order_form_field(seeded_db, order_type_code="SALEREC", field_key="receipt", label="售出凭据",
                                required_when={"field": "customer_nickname", "op": "filled"}, actor="pytest")
        pool = seeded_db.scalar(select(Pool).where(Pool.status == "ACTIVE"))
        if installment:
            url = "/api/v1/installments/stock-sale"
            payload = {"order_id": order.id, "principal": "200", "down_payment": "50", "periods": 1,
                       "per_period": "150", "first_due_on": TODAY.isoformat(), "paid_on": TODAY.isoformat(), "pool_id": pool.id}
        else:
            url = f"/api/v1/orders/{order.id}/stock-sale"
            payload = {"amount": "200", "occurred_on": TODAY.isoformat(), "pool_id": pool.id}
        payload["form_extra"] = {"customer_nickname": "伪造客户"}
        saved = seeded_client.post(url, headers=headers, json=payload)
        assert saved.status_code == 201, saved.text
        assert seeded_db.scalar(select(Customer.id).where(Customer.display_name == "伪造客户")) is None

    def test_buy_does_not_require_unrelated_cashflow_fields(self, seeded_db):
        account = _account(seeded_db, "buy-with-cashflow-custom-field")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        create_order_form_field(seeded_db, order_type_code="REFUND", field_key="receipt",
                                label="收支凭据", required=True, actor="pytest")
        _buy(seeded_db, order.id, "100")
        assert seeded_db.scalar(select(OrderEvent.id).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "BUY"))

    def test_sale_customer_creation_keeps_customer_permission_check(self, seeded_db):
        from app.business.sale import apply_sale_details
        from app.business.schemas import CustomerDraftInput
        from app.core.errors import PermissionDenied
        from app.core.security import PERM_ORDER_UPDATE
        order = _order(seeded_db, order_type="HS", account_id=_account(seeded_db, "sale-customer-permission").id)
        user = CurrentUser(id=1, username="admin", permissions=frozenset({PERM_ORDER_UPDATE}), owner_scope="ALL")
        with pytest.raises(PermissionDenied):
            apply_sale_details(seeded_db, order.id,
                customer_input=CustomerDraftInput(display_name="无权限新建", role="BUYER"),
                delivery_form_extra=None, user=user)
        assert seeded_db.scalar(select(Customer.id).where(Customer.display_name == "无权限新建")) is None

    def test_full_stock_sale_saves_buyer_delivery_and_cashflow_together(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "atomic-full-sale")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        account.bound_phone = "13800000001"
        order.form_extra = {"intermediary_platform": "其他", "intermediary_platform_other": "旧平台", "bound_phone_owner": "买号绑定人", "delivery_responsible_ids": [2]}
        seeded_db.flush()
        _buy(seeded_db, order.id, "100")
        pool = seeded_db.scalar(select(Pool).where(Pool.status == "ACTIVE"))
        response = seeded_client.post(f"/api/v1/orders/{order.id}/stock-sale", headers=headers, json={
            "amount": "200", "occurred_on": TODAY.isoformat(), "pool_id": pool.id,
            "operator_user_ids": [1], "customer_input": {"display_name": "完整售出买家", "role": "BUYER"},
            "delivery_form_extra": {"delivery_responsible_ids": [1], "intermediary_platform": "盼之", "intermediary_platform_other": None, "bound_phone": "13900000002", "bound_phone_owner": "卖号绑定人"},
        })
        assert response.status_code == 201, response.text
        customer = seeded_db.scalar(select(Customer).where(Customer.display_name == "完整售出买家"))
        assert customer is not None
        assert seeded_db.scalar(select(OrderCustomerRole.id).where(OrderCustomerRole.order_id == order.id, OrderCustomerRole.customer_id == customer.id, OrderCustomerRole.role == "BUYER"))
        seeded_db.refresh(order)
        assert order.form_extra["delivery_responsible_ids"] == [2]
        assert order.form_extra["intermediary_platform"] == "其他"
        assert order.form_extra["intermediary_platform_other"] == "旧平台"
        assert order.form_extra["bound_phone"] == "13800000001"
        assert order.form_extra["bound_phone_owner"] == "买号绑定人"
        assert order.form_extra["sell_delivery_responsible_ids"] == [1]
        assert order.form_extra["sell_intermediary_platform"] == "盼之"
        assert order.form_extra["sell_intermediary_platform_other"] is None
        assert order.form_extra["sell_bound_phone"] == "13900000002"
        assert order.form_extra["sell_bound_phone_owner"] == "卖号绑定人"
        seeded_db.refresh(account)
        assert account.bound_phone == "13900000002"
        assert seeded_db.scalar(select(Cashflow.id).where(Cashflow.order_id == order.id, Cashflow.category == "SELL"))

    def test_full_stock_sale_failure_rolls_back_buyer_and_delivery(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "atomic-full-failed")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, "100")
        order_id, account_id = order.id, account.id
        seeded_db.commit()
        def transactional_db():
            try:
                yield seeded_db
                seeded_db.commit()
            except Exception:
                seeded_db.rollback()
                raise
        seeded_client.app.dependency_overrides[get_db] = transactional_db
        response = seeded_client.post(f"/api/v1/orders/{order_id}/stock-sale", headers=headers, json={
            "amount": "200", "occurred_on": TODAY.isoformat(), "pool_id": 999999999,
            "operator_user_ids": [1], "customer_input": {"display_name": "失败时不留买家", "role": "BUYER"},
            "delivery_form_extra": {"delivery_responsible_ids": [1]},
        })
        assert response.status_code in (400, 404, 409, 422), response.text
        seeded_db.expire_all()
        assert seeded_db.get(Account, account_id).status == "WAITING"
        assert seeded_db.scalar(select(Customer.id).where(Customer.display_name == "失败时不留买家")) is None
        assert seeded_db.scalar(select(OrderEvent.id).where(OrderEvent.order_id == order_id, OrderEvent.event_type == "SELL")) is None
        assert not (seeded_db.get(Order, order_id).form_extra or {}).get("sell_delivery_responsible_ids")

    def test_stock_sale_rejects_disabled_buyer_without_selling(self, seeded_client, seeded_db, headers):
        from app.customers.customers import create_customer
        customer = create_customer(seeded_db, display_name="已拉黑买家", actor="pytest")
        customer.status = "DISABLED"
        account = _account(seeded_db, "atomic-disabled-buyer")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, "100")
        pool = seeded_db.scalar(select(Pool).where(Pool.status == "ACTIVE"))
        response = seeded_client.post(f"/api/v1/orders/{order.id}/stock-sale", headers=headers, json={
            "amount": "200", "occurred_on": TODAY.isoformat(), "pool_id": pool.id,
            "operator_user_ids": [1], "customer_input": {"display_name": "已拉黑买家", "role": "BUYER"},
        })
        assert response.status_code in (400, 409, 422), response.text
        assert seeded_db.scalar(select(OrderEvent.id).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL")) is None

    def test_consignment_sale_reuses_existing_consignor_and_records_sale_amount(self, seeded_client, seeded_db, headers):
        from app.business.stocks.profile import create_account
        from app.customers.customers import create_customer
        customer = create_customer(seeded_db, display_name="代挂委托人", phone="13800138001", actor="pytest")
        account = create_account(seeded_db, game_account="atomic-consignment-sale", business_mode="DISTRIBUTION", inventory_type="CONSIGNMENT", actor="pytest")
        order = _order(seeded_db, order_type="DG", account_id=account.id)
        pool = seeded_db.scalar(select(Pool).where(Pool.status == "ACTIVE"))
        response = seeded_client.post(f"/api/v1/orders/{order.id}/stock-sale", headers=headers, json={
            "amount": "20", "sale_amount": "200", "occurred_on": TODAY.isoformat(), "pool_id": pool.id,
            "operator_user_ids": [1], "customer_input": {"display_name": "代挂委托人", "phone": "13800138001", "role": "CONSIGNOR"},
        })
        assert response.status_code == 201, response.text
        assert seeded_db.scalar(select(OrderCustomerRole.id).where(OrderCustomerRole.order_id == order.id, OrderCustomerRole.customer_id == customer.id, OrderCustomerRole.role == "CONSIGNOR"))
        assert len(seeded_db.scalars(select(Customer.id).where(Customer.display_name == "代挂委托人")).all()) == 1
        event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL"))
        assert event.amount == Decimal("20") and Decimal(event.form_extra["sale_amount"]) == Decimal("200")

    def test_stock_sale_commits_event_contract_and_down_payment_together(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "atomic-sale-success")
        account.bound_phone = "13700000001"
        seeded_db.flush()
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        order.form_extra = {"intermediary_platform": "买号平台", "bound_phone_owner": "买号绑定人"}
        seeded_db.flush()
        _buy(seeded_db, order.id, "100")
        pool = seeded_db.scalar(select(Pool).where(Pool.status == "ACTIVE"))
        seeded_db.commit()
        def transactional_db():
            try:
                yield seeded_db
                seeded_db.commit()
            except Exception:
                seeded_db.rollback()
                raise
        seeded_client.app.dependency_overrides[get_db] = transactional_db
        response = seeded_client.post("/api/v1/installments/stock-sale", headers=headers, json={
            "order_id": order.id, "principal": "200", "down_payment": "50", "periods": 1,
            "per_period": "150", "first_due_on": TODAY.isoformat(), "paid_on": TODAY.isoformat(),
            "pool_id": pool.id, "operator_user_ids": [1],
            "customer_input": {"display_name": "分期售出买家", "role": "BUYER"},
            "delivery_form_extra": {"delivery_responsible_ids": [1], "intermediary_platform": "其他", "intermediary_platform_other": "分期平台", "bound_phone": "13900000002"},
        })
        assert response.status_code == 201, response.text
        contract = seeded_db.scalar(select(Installment).where(Installment.order_id == order.id))
        assert contract is not None and contract.paid_amount == Decimal("50")
        assert seeded_db.scalar(select(OrderEvent.id).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL"))
        flow = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == order.id, Cashflow.category == "INSTALLMENT_PAYMENT"))
        assert flow is not None and flow.amount == Decimal("50") and flow.pool_id == pool.id
        customer = seeded_db.scalar(select(Customer).where(Customer.display_name == "分期售出买家"))
        assert customer is not None
        assert seeded_db.scalar(select(OrderCustomerRole.id).where(OrderCustomerRole.order_id == order.id, OrderCustomerRole.customer_id == customer.id, OrderCustomerRole.role == "BUYER"))
        saved_extra = seeded_db.get(Order, order.id).form_extra
        assert saved_extra["sell_delivery_responsible_ids"] == [1]
        assert saved_extra["sell_intermediary_platform_other"] == "分期平台"
        assert saved_extra["bound_phone"] == "13700000001"
        assert saved_extra["sell_bound_phone"] == "13900000002"
        seeded_db.refresh(account)
        assert account.bound_phone == "13900000002"
        detail = seeded_client.get(f"/api/v1/orders/{order.id}/execution-detail", headers=headers)
        assert detail.status_code == 200, detail.text
        assert detail.json()["orders"][0]["extra_values"]["sell_intermediary_platform_other"] == "分期平台"
        edited = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={
            "events": [], "orders": [{"order_id": order.id, "form_extra": {
                "sell_intermediary_platform_other": "新平台", "bound_phone_owner": "新买号绑定人",
            }}],
        })
        assert edited.status_code == 200, edited.text
        detail = seeded_client.get(f"/api/v1/orders/{order.id}/execution-detail", headers=headers)
        assert detail.status_code == 200, detail.text
        assert detail.json()["orders"][0]["extra_values"]["sell_intermediary_platform_other"] == "新平台"
        assert detail.json()["orders"][0]["extra_values"]["bound_phone_owner"] == "新买号绑定人"
        cleared = seeded_client.patch(f"/api/v1/orders/{order.id}/execution-edit", headers=headers, json={
            "events": [], "orders": [{"order_id": order.id, "form_extra": {
                "sell_intermediary_platform": "盼之", "sell_intermediary_platform_other": None,
            }}],
        })
        assert cleared.status_code == 200, cleared.text
        detail = seeded_client.get(f"/api/v1/orders/{order.id}/execution-detail", headers=headers)
        assert detail.status_code == 200, detail.text
        assert detail.json()["orders"][0]["extra_values"]["sell_intermediary_platform_other"] is None
        assert detail.json()["orders"][0]["extra_values"]["intermediary_platform"] == "买号平台"
        assert detail.json()["orders"][0]["extra_values"]["bound_phone_owner"] == "新买号绑定人"

    def test_stock_sale_rolls_back_when_down_payment_fails(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "atomic-sale-rollback")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, "100")
        order_id, account_id = order.id, account.id
        seeded_db.commit()
        def transactional_db():
            try:
                yield seeded_db
                seeded_db.commit()
            except Exception:
                seeded_db.rollback()
                raise
        seeded_client.app.dependency_overrides[get_db] = transactional_db
        response = seeded_client.post("/api/v1/installments/stock-sale", headers=headers, json={
            "order_id": order_id, "principal": "200", "down_payment": "50", "periods": 1,
            "per_period": "150", "first_due_on": TODAY.isoformat(), "paid_on": TODAY.isoformat(),
            "pool_id": 999999999, "operator_user_ids": [1],
            "customer_input": {"display_name": "分期失败买家", "role": "BUYER"},
            "delivery_form_extra": {"delivery_responsible_ids": [1]},
        })
        assert response.status_code in (400, 404, 409, 422), response.text
        seeded_db.expire_all()
        assert seeded_db.get(Account, account_id).status == "WAITING"
        assert seeded_db.scalar(select(Installment.id).where(Installment.order_id == order_id)) is None
        assert seeded_db.scalar(select(OrderEvent.id).where(OrderEvent.order_id == order_id, OrderEvent.event_type == "SELL")) is None
        assert seeded_db.scalar(select(Cashflow.id).where(Cashflow.order_id == order_id, Cashflow.category == "INSTALLMENT_PAYMENT")) is None
        assert seeded_db.scalar(select(Customer.id).where(Customer.display_name == "分期失败买家")) is None
        assert not (seeded_db.get(Order, order_id).form_extra or {}).get("sell_delivery_responsible_ids")

    def test_stock_sale_rolls_back_when_contract_plan_is_invalid(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "atomic-sale-invalid-plan")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, "100")
        order_id, account_id = order.id, account.id
        seeded_db.commit()
        def transactional_db():
            try:
                yield seeded_db
                seeded_db.commit()
            except Exception:
                seeded_db.rollback()
                raise
        seeded_client.app.dependency_overrides[get_db] = transactional_db
        response = seeded_client.post("/api/v1/installments/stock-sale", headers=headers, json={
            "order_id": order_id, "principal": "200", "down_payment": "250", "periods": 1,
            "per_period": "0", "first_due_on": TODAY.isoformat(), "paid_on": TODAY.isoformat(),
            "operator_user_ids": [1],
        })
        assert response.status_code in (400, 409, 422), response.text
        seeded_db.expire_all()
        assert seeded_db.get(Account, account_id).status == "WAITING"
        assert seeded_db.scalar(select(Installment.id).where(Installment.order_id == order_id)) is None
        assert seeded_db.scalar(select(OrderEvent.id).where(OrderEvent.order_id == order_id, OrderEvent.event_type == "SELL")) is None

    def test_stock_sale_with_zero_down_payment_creates_no_cashflow(self, seeded_client, seeded_db, headers):
        from app.business.stocks.profile import create_account
        account = create_account(seeded_db, game_account="atomic-sale-zero-down", business_mode="DISTRIBUTION", inventory_type="PICKUP", actor="pytest")
        order = _order(seeded_db, order_type="TH", account_id=account.id)
        _buy(seeded_db, order.id, "100")
        response = seeded_client.post("/api/v1/installments/stock-sale", headers=headers, json={
            "order_id": order.id, "principal": "200", "down_payment": "0", "periods": 1,
            "per_period": "200", "first_due_on": TODAY.isoformat(), "paid_on": TODAY.isoformat(),
            "operator_user_ids": [1],
        })
        assert response.status_code == 201, response.text
        assert seeded_db.scalar(select(Installment.id).where(Installment.order_id == order.id))
        assert seeded_db.scalar(select(Cashflow.id).where(Cashflow.order_id == order.id, Cashflow.category == "INSTALLMENT_PAYMENT")) is None

    def test_scoped_user_cannot_read_or_pay_other_order_contract(
        self, seeded_client, seeded_db
    ):
        own_order = _order(seeded_db, owner_id=9)
        other_order = _order(seeded_db, owner_id=8)
        own_contract = _contract(seeded_db, own_order.id)
        other_contract = _contract(seeded_db, other_order.id)
        user = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(user)}"}

        listing = seeded_client.get("/api/v1/installments", headers=scoped_headers)
        assert listing.status_code == 200
        assert [row["id"] for row in listing.json()["items"]] == [own_contract.id]

        schedules = seeded_client.get(
            f"/api/v1/installments/{other_contract.id}/schedules",
            headers=scoped_headers,
        )
        assert schedules.status_code == 404

        payment = seeded_client.post(
            f"/api/v1/installments/{other_contract.id}/payments",
            json={"amount": "1.00", "paid_on": TODAY.isoformat()},
            headers=scoped_headers,
        )
        assert payment.status_code == 404

    def test_list_endpoint(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, first_due_on=PAST, note="分期备注")
        response = seeded_client.get(
            "/api/v1/installments", params={"status": "PENDING"}, headers=headers
        )
        assert response.status_code == 200, response.text
        assert [item["inst_no"] for item in response.json()["items"]] == [contract.inst_no]
        row = response.json()["items"][0]
        assert row["first_due_on"] == PAST.isoformat()
        assert row["note"] == "分期备注"

    def test_detail_can_update_action_operators(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id)

        response = seeded_client.put(
            f"/api/v1/installments/{contract.id}/operation-operators/CREATE",
            json={"operator_user_ids": [1, 2]},
            headers=headers,
        )

        assert response.status_code == 200, response.text
        create_operator_row = next(
            row for row in response.json()["operation_operators"]
            if row["operation_key"] == "CREATE"
        )
        assert create_operator_row["operator_user_ids"] == [1, 2]

    def test_list_endpoint_returns_order_context_from_database(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db, order_type="TH", trade_date=PAST)
        contract = _contract(seeded_db, order.id)

        response = seeded_client.get("/api/v1/installments", headers=headers)

        assert response.status_code == 200, response.text
        row = next(item for item in response.json()["items"] if item["id"] == contract.id)
        assert {
            key: row["order"][key]
            for key in ("id", "order_no", "order_type", "trade_date")
        } == {
            "id": order.id,
            "order_no": order.order_no,
            "order_type": "TH",
            "trade_date": PAST.isoformat(),
        }

    def test_list_endpoint_returns_schedule_and_disposition_details(
        self, seeded_client, seeded_db, headers
    ):
        account = _account(seeded_db, "installment-list-details")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, amount="800")
        contract = _contract(
            seeded_db,
            order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
            principal="1000",
            down_payment="100",
            periods=1,
            per_period="900",
            first_due_on=PAST,
        )
        inst_recovery.mark_overdue(seeded_db, as_of=TODAY)
        inst_recovery.recover_account(
            seeded_db,
            contract.id,
            occurred_on=TODAY,
            note="逾期回收",
            actor="pytest",
        )

        response = seeded_client.get("/api/v1/installments", headers=headers)

        assert response.status_code == 200, response.text
        row = next(item for item in response.json()["items"] if item["id"] == contract.id)
        assert row["schedules"][0]["installment_id"] == contract.id
        assert row["dispositions"][0]["action"] == "RECOVER"

    def test_deliver_endpoint(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="500"
        )
        inst_pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        inst_pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        response = seeded_client.post(
            f"/api/v1/installments/{contract.id}/deliver",
            json={
                "delivered_on": TODAY.isoformat(),
                "note": "平台操作换绑凭证",
                "bound_phone": "13800000000",
                "bound_phone_owner": "张三",
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["status"] == InstallmentStatus.DELIVERED.value
        seeded_db.refresh(order)
        # 该测试订单没有账号快照；换绑字段仍以交付事件关联保存。
        assert order.account_snapshot is None
        event = seeded_db.scalar(
            select(OrderEvent).where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == EventType.DELIVER.value,
            )
        )
        assert event is not None
        assert event.form_extra == {
            "bound_phone": "13800000000",
            "bound_phone_owner": "张三",
            "delivery_direction": "SELL",
        }

    def test_settle_early_and_default_endpoints(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="100",
            periods=1,
            per_period="300",
        )
        paid = seeded_client.post(
            f"/api/v1/installments/{contract.id}/payments",
            json={
                "amount": "100",
                "paid_on": TODAY.isoformat(),
                "period_no": 0,
            },
            headers=headers,
        )
        assert paid.status_code == 200, paid.text

        early = seeded_client.post(
            f"/api/v1/installments/{contract.id}/settle-early",
            json={"paid_on": TODAY.isoformat(), "note": "一次性结清"},
            headers=headers,
        )
        assert early.status_code == 200, early.text
        assert early.json()["status"] == InstallmentStatus.SETTLED.value

        overdue_order = _order(seeded_db)
        overdue_contract = _contract(
            seeded_db,
            overdue_order.id,
            down_payment="100",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )
        overdue_paid = seeded_client.post(
            f"/api/v1/installments/{overdue_contract.id}/payments",
            json={
                "amount": "100",
                "paid_on": TODAY.isoformat(),
                "period_no": 0,
            },
            headers=headers,
        )
        assert overdue_paid.status_code == 200, overdue_paid.text
        marked = seeded_client.post(
            "/api/v1/installments/mark-overdue",
            params={"as_of": TODAY.isoformat()},
            headers=headers,
        )
        assert marked.status_code == 200, marked.text
        defaulted = seeded_client.post(
            f"/api/v1/installments/{overdue_contract.id}/default",
            json={"reason": "超过约定期限"},
            headers=headers,
        )
        assert defaulted.status_code == 200, defaulted.text
        assert defaulted.json()["status"] == InstallmentStatus.DEFAULTED.value

    def test_mark_overdue_endpoint(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        _contract(
            seeded_db, order.id, down_payment="0", periods=2, per_period="300",
            first_due_on=PAST,
        )
        response = seeded_client.post(
            "/api/v1/installments/mark-overdue",
            params={"as_of": TODAY.isoformat()},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["marked"] == 2

    def test_waive_and_extend_schedule_endpoints(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, periods=1, per_period="300", first_due_on=TODAY
        )
        extended = seeded_client.post(
            f"/api/v1/installments/{contract.id}/schedules/1/extend",
            json={"new_due_on": "2026-12-31", "reason": "客户申请展期"},
            headers=headers,
        )
        assert extended.status_code == 200, extended.text
        assert extended.json()["due_on"] == "2026-12-31"

        waived = seeded_client.post(
            f"/api/v1/installments/{contract.id}/schedules/1/waive",
            json={
                "amount": "300",
                "waived_on": TODAY.isoformat(),
                "reason": "审批减免",
            },
            headers=headers,
        )
        assert waived.status_code == 200, waived.text
        assert waived.json()["status"] == ScheduleStatus.WAIVED.value
        assert waived.json()["waived_amount"] == "300.00"

    def test_recover_endpoint_records_disposition(self, seeded_client, seeded_db, headers):
        account = _account(seeded_db, "recover-endpoint-account")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, amount="800")
        contract = _contract(
            seeded_db, order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
            principal="1000", down_payment="100", periods=1,
            per_period="900", first_due_on=PAST,
        )
        seeded_client.post(
            "/api/v1/installments/mark-overdue",
            params={"as_of": TODAY.isoformat()},
            headers=headers,
        )

        response = seeded_client.post(
            f"/api/v1/installments/{contract.id}/recover",
            json={"occurred_on": TODAY.isoformat(), "note": "客户逾期回收"},
            headers=headers,
        )

        assert response.status_code == 200, response.text
        assert response.json()["action"] == "RECOVER"

    def test_scoped_user_mark_overdue_only_updates_visible_orders(
        self, seeded_client, seeded_db
    ):
        own_order = _order(seeded_db, owner_id=9)
        foreign_order = _order(seeded_db, owner_id=8)
        own_contract = _contract(
            seeded_db, own_order.id, down_payment="0", periods=1, per_period="300",
            first_due_on=PAST,
        )
        foreign_contract = _contract(
            seeded_db, foreign_order.id, down_payment="0", periods=1, per_period="300",
            first_due_on=PAST,
        )
        user = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(user)}"}

        response = seeded_client.post(
            "/api/v1/installments/mark-overdue",
            params={"as_of": TODAY.isoformat()},
            headers=scoped_headers,
        )

        assert response.status_code == 200, response.text
        assert response.json()["marked"] == 1

        own_schedule = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == own_contract.id,
                InstallmentSchedule.period_no == 1,
            )
        )
        foreign_schedule = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == foreign_contract.id,
                InstallmentSchedule.period_no == 1,
            )
        )
        assert own_schedule.status == ScheduleStatus.OVERDUE.value
        assert foreign_schedule.status == ScheduleStatus.PENDING.value

    def test_overdue_account_can_be_recovered_without_rewriting_contract(self, seeded_db):
        account = _account(seeded_db, "overdue-recovery-account")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        _buy(seeded_db, order.id, amount="800")
        contract = _contract(
            seeded_db, order.id,
            contract_type=InstallmentContractType.STOCK_SALE.value,
            principal="1000", down_payment="100", periods=1,
            per_period="900", first_due_on=PAST,
        )
        inst_recovery.mark_overdue(seeded_db, as_of=TODAY)
        recovered = inst_recovery.recover_account(
            seeded_db, contract.id, occurred_on=TODAY,
            actor="recovery-operator", note="客户逾期回收",
        )

        assert recovered.action == "RECOVER"
        assert recovered.installment_id == contract.id
        seeded_db.refresh(account)
        seeded_db.refresh(contract)
        assert account.status == "WAITING"
        assert contract.status == InstallmentStatus.CLOSED.value


