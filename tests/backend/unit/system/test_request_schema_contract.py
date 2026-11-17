"""API-01 请求模型字段契约：未知字段必须显式拒绝，不再静默兼容旧结构。"""
from __future__ import annotations

from datetime import date

import pytest
from pydantic import BaseModel, ValidationError

from app.stocks.schemas import AccountProfileUpdate
from app.auth.router import (
    LoginRequest,
    PasswordChange,
    PasswordResetRequest,
    TeamCreate,
    TeamUpdate,
    UserCreate,
    UserUpdate,
)
from app.finance.schemas import (
    CashflowCreate,
    CashflowReverse,
    DepositCreate,
    DepositLoss,
    DepositReturn,
    RebateCreate,
    ReconciliationCreate,
    ReconciliationResolve,
    TransferCreate,
    TransferRepair,
)
from app.foundation.schemas import (
    OrderTypeCreate,
    OrderTypeUpdate,
    PoolCreate,
    PoolStatusUpdate,
    PoolUpdate,
)
from app.installments.schemas import (
    DefaultIn,
    DeliverIn,
    EarlySettlementIn,
    InstallmentCreate,
    PaymentIn,
    ScheduleCreate,
    ScheduleExtendIn,
    ScheduleWaiveIn,
)
from app.orders.schemas import EventCreate
from app.customer_center.schemas import (
    CounterpartyCreate,
    CounterpartyUpdate,
    CustomerCreate,
    CustomerStatusUpdate,
    CustomerUpdate,
    ExtraValueIn,
    MergeRequest,
)


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (LoginRequest, {"username": "alice", "password": "password123"}),
        (PasswordChange, {"old_password": "oldpass1", "new_password": "newpass1"}),
        (PasswordResetRequest, {"password": "newpass1"}),
        (
            UserCreate,
            {"username": "alice", "display_name": "Alice", "password": "password123"},
        ),
        (UserUpdate, {}),
        (TeamCreate, {"code": "TEAM1", "name": "一组"}),
        (TeamUpdate, {}),
        (ScheduleCreate, {"period_no": 1, "due_on": date(2026, 10, 1)}),
        (
            InstallmentCreate,
            {"order_id": 1, "contract_type": "STOCK_SALE", "periods": 1, "first_due_on": date(2026, 10, 1)},
        ),
        (PaymentIn, {"amount": "1.00", "paid_on": date(2026, 10, 1)}),
        (EarlySettlementIn, {"paid_on": date(2026, 10, 1)}),
        (DefaultIn, {"reason": "风险处置"}),
        (
            ScheduleWaiveIn,
            {"amount": "1.00", "waived_on": date(2026, 10, 1), "reason": "授权减免"},
        ),
        (ScheduleExtendIn, {"new_due_on": date(2026, 10, 2), "reason": "客户申请"}),
        (
            DeliverIn,
            {"delivery_mode": "CUSTOMER_SELF", "delivered_on": date(2026, 10, 1), "note": "已确认"},
        ),
        (CustomerCreate, {"display_name": "客户"}),
        (CustomerUpdate, {}),
        (CustomerStatusUpdate, {"status": "ACTIVE"}),
        (MergeRequest, {"target_customer_id": 1, "reason": "重复建档"}),
        (CounterpartyCreate, {"display_name": "平台", "type": "PLATFORM"}),
        (CounterpartyUpdate, {}),
        (ExtraValueIn, {"field_key": "level"}),
        (DepositCreate, {"pool_id": 1, "amount": "1.00", "paid_on": date(2026, 10, 1)}),
        (DepositReturn, {"amount": "1.00", "released_on": date(2026, 10, 1)}),
        (
            DepositLoss,
            {"amount": "1.00", "lost_on": date(2026, 10, 1), "category": "OTHER", "reason": "损失"},
        ),
        (
            CashflowCreate,
            {"pool_id": 1, "occurred_on": date(2026, 10, 1), "direction": "IN", "nature": "BUSINESS_IN", "category": "OTHER", "amount": "1.00"},
        ),
        (CashflowReverse, {"reversed_on": date(2026, 10, 1), "reason": "重复"}),
        (
            ReconciliationCreate,
            {"pool_id": 1, "reconciled_on": date(2026, 10, 1), "account_label": "银行卡", "statement_balance": "1.00"},
        ),
        (ReconciliationResolve, {"reason": "已核实"}),
        (
            TransferCreate,
            {"source_pool_id": 1, "target_pool_id": 2, "amount": "1.00", "occurred_on": date(2026, 10, 1)},
        ),
        (TransferRepair, {"counterpart_pool_id": 2, "reason": "补齐"}),
        (RebateCreate, {"source_order_id": 1, "amount": "1.00", "collected_on": date(2026, 10, 1)}),
        (AccountProfileUpdate, {}),
        (PoolCreate, {"code": "POOL1", "name": "资金账户"}),
        (PoolUpdate, {}),
        (PoolStatusUpdate, {"status": "ACTIVE"}),
        (OrderTypeCreate, {"code": "TB", "name": "测试业务"}),
        (OrderTypeUpdate, {}),
        (EventCreate, {"event_type": "SELL", "occurred_on": date(2026, 10, 1)}),
    ],
)
def test_request_models_reject_unknown_fields(
    model: type[BaseModel], payload: dict[str, object]
):
    with pytest.raises(ValidationError):
        model.model_validate({**payload, "legacy_field": "must not be ignored"})


def test_sell_event_accepts_sale_mode_attribute():
    payload = EventCreate(
        event_type="SELL",
        sale_mode="INSTALLMENT",
        amount="1000.00",
        occurred_on=date(2026, 10, 1),
    )

    assert payload.sale_mode == "INSTALLMENT"


def test_operate_event_accepts_operation_type_attribute():
    payload = EventCreate(
        event_type="OPERATE",
        operation_type="CONSIGNMENT",
        occurred_on=date(2026, 10, 1),
        note="已上架寄售平台",
    )

    assert payload.operation_type == "CONSIGNMENT"
