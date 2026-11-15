"""API-01 attachments.service 业务函数单测（覆盖 _validate_entity_type / _load_target /
_assert_permission / _assert_visible / _decode_content / _validate_file /
get_attachment / attachment_path / create_attachment 的守卫与分支）。"""
from __future__ import annotations

import base64
from datetime import date
from pathlib import Path

import pytest

from app.attachments import service as svc
from app.core.errors import NotFound, PermissionDenied, Validation
from app.core.money import to_money
from app.core.security import (
    PERM_DEPOSIT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_UPDATE,
    CurrentUser,
    ROLE_ADMIN,
)
from app.domain.attachments import Attachment
from app.domain.trade import Cashflow, Installment, OrderEvent
from app.orders.create import create_order


D = date(2026, 10, 17)


class _Settings:
    def __init__(self, path: str):
        self.attachment_storage_path = Path(path)


def _user(uid=2, perms=(), pool_ids=(), owner_scope="SELF") -> CurrentUser:
    return CurrentUser(
        id=uid,
        username=f"u{uid}",
        roles=(),
        permissions=frozenset(perms),
        pool_ids=frozenset(pool_ids),
        owner_scope=owner_scope,
    )


ADMIN = CurrentUser(
    id=1, username="admin", roles=(ROLE_ADMIN,), permissions=frozenset(),
    pool_ids=frozenset(), owner_scope="ALL",
)


def _order(seeded_db, owner_id=2):
    order = create_order(
        seeded_db, order_type="HS", trade_date=D, actor="pytest"
    )
    order.owner_id = owner_id
    seeded_db.flush()
    return order


# ---- 纯函数守卫 ----

def test_validate_entity_type_rejects_unknown():
    with pytest.raises(Validation, match="附件关联对象类型无效"):
        svc._validate_entity_type("bogus")


def test_decode_content_strips_data_uri_prefix():
    assert svc._decode_content("data:image/png;base64,QUFB") == b"AAA"


def test_decode_content_rejects_invalid_base64():
    with pytest.raises(Validation, match="附件内容必须是有效的 Base64"):
        svc._decode_content("@@@notbase64@@@")


def test_decode_content_rejects_empty():
    with pytest.raises(Validation, match="附件内容不能为空"):
        svc._decode_content(base64.b64encode(b"").decode())


def test_decode_content_rejects_oversize(monkeypatch):
    monkeypatch.setattr(svc, "MAX_ATTACHMENT_BYTES", 10)
    with pytest.raises(Validation, match="附件大小不能超过"):
        svc._decode_content(base64.b64encode(b"x" * 20).decode())


def test_validate_file_rejects_path_traversal():
    with pytest.raises(Validation, match="附件文件名不能包含路径"):
        svc._validate_file("../../etc/passwd", "text/plain")


def test_validate_file_rejects_blank_content_type():
    with pytest.raises(Validation, match="附件类型不能为空"):
        svc._validate_file("x.txt", "  ")


# ---- _load_target 各 entity_type 分支 ----

def test_load_target_rejects_blank_entity_id(seeded_db):
    with pytest.raises(Validation, match="附件关联对象编号不能为空"):
        svc._load_target(seeded_db, "order", "  ")


def test_load_target_order_event_not_found(seeded_db):
    with pytest.raises(NotFound, match="附件关联的订单事件不存在"):
        svc._load_target(seeded_db, "order_event", "NOPE-EVENT")


def test_load_target_order_event_success(seeded_db):
    order = _order(seeded_db)
    event = OrderEvent(
        event_no="OE-TEST-1", order_id=order.id, event_type="BUY",
        amount=to_money("1000"), occurred_on=D,
    )
    seeded_db.add(event)
    seeded_db.flush()
    target = svc._load_target(seeded_db, "order_event", event.event_no)
    assert target.entity_type == "order_event"
    assert target.order is not None


def test_load_target_cashflow_not_found(seeded_db):
    with pytest.raises(NotFound, match="附件关联的资金流水不存在"):
        svc._load_target(seeded_db, "cashflow", "NOPE-FLOW")


def test_load_target_cashflow_success(seeded_db):
    flow = Cashflow(
        flow_no="CF-TEST-1", pool_id=1, occurred_on=D,
        nature="BUSINESS_IN", direction="IN", amount=to_money("10"),
        accounting_attribute="ADDITIONAL_INCOME", fund_nature="BUSINESS",
        category="REBATE",
    )
    seeded_db.add(flow)
    seeded_db.flush()
    target = svc._load_target(seeded_db, "cashflow", flow.flow_no)
    assert target.entity_type == "cashflow"


def test_load_target_installment_not_found(seeded_db):
    with pytest.raises(NotFound, match="附件关联的分期合约不存在"):
        svc._load_target(seeded_db, "installment", "NOPE-INST")


def test_load_target_installment_success(seeded_db):
    order = _order(seeded_db)
    inst = Installment(
        inst_no="INST-TEST-1", order_id=order.id,
        contract_type="STOCK_SALE", periods=1,
    )
    seeded_db.add(inst)
    seeded_db.flush()
    target = svc._load_target(seeded_db, "installment", inst.inst_no)
    assert target.entity_type == "installment"
    assert target.order is not None


# ---- _assert_permission 非 admin 各分支 ----

def test_assert_permission_cashflow_requires_finance_read(seeded_db):
    target = svc._Target("cashflow", "x", pool_id=1)
    with pytest.raises(PermissionDenied, match="当前角色无权访问该附件"):
        svc._assert_permission(_user(), target, write=False)
    read_only = _user(perms=(PERM_FINANCE_READ,))
    svc._assert_permission(read_only, target, write=False)
    with pytest.raises(PermissionDenied, match="当前角色无权访问该附件"):
        svc._assert_permission(read_only, target, write=True)
    svc._assert_permission(_user(perms=(PERM_DEPOSIT_POST,)), target, write=True)


def test_assert_permission_write_requires_update_or_event_post(seeded_db):
    target = svc._Target("order", "x", order=_order(seeded_db))
    with pytest.raises(PermissionDenied, match="当前角色无权访问该附件"):
        svc._assert_permission(_user(), target, write=True)
    svc._assert_permission(_user(perms=(PERM_ORDER_UPDATE,)), target, write=True)


def test_assert_permission_read_requires_create_or_event_post(seeded_db):
    target = svc._Target("order", "x", order=_order(seeded_db))
    with pytest.raises(PermissionDenied, match="当前角色无权访问该附件"):
        svc._assert_permission(_user(), target, write=False)
    svc._assert_permission(_user(perms=(PERM_ORDER_CREATE,)), target, write=False)


# ---- _assert_visible 各分支 ----

def test_assert_visible_order_owner_match_and_mismatch(seeded_db):
    order = _order(seeded_db, owner_id=2)
    target = svc._Target("order", "x", order=order)
    svc._assert_visible(seeded_db, _user(uid=2), target)  # 匹配
    with pytest.raises(NotFound, match="附件不存在"):
        svc._assert_visible(seeded_db, _user(uid=9), target)  # 不匹配


def test_assert_visible_pool_not_visible(seeded_db):
    target = svc._Target("cashflow", "x", pool_id=1)
    with pytest.raises(NotFound, match="附件不存在"):
        svc._assert_visible(seeded_db, _user(pool_ids=()), target)


def test_assert_visible_cashflow_without_pool(seeded_db):
    target = svc._Target("cashflow", "x", pool_id=None)
    with pytest.raises(NotFound, match="附件不存在"):
        svc._assert_visible(seeded_db, _user(), target)


# ---- get_attachment / attachment_path ----

def test_get_attachment_not_found(seeded_db):
    with pytest.raises(NotFound, match="附件不存在"):
        svc.get_attachment(seeded_db, 999999, ADMIN)


def test_attachment_path_rejects_traversal(monkeypatch, tmp_path):
    monkeypatch.setattr(svc, "get_settings", lambda: _Settings(str(tmp_path)))
    with pytest.raises(Validation, match="附件存储路径无效"):
        svc.attachment_path(Attachment(storage_key="../evil"))


def test_attachment_path_rejects_missing_file(monkeypatch, tmp_path):
    monkeypatch.setattr(svc, "get_settings", lambda: _Settings(str(tmp_path)))
    with pytest.raises(NotFound, match="附件文件不存在"):
        svc.attachment_path(Attachment(storage_key="nope.bin"))


def test_create_attachment_unlinks_file_on_audit_error(seeded_db, monkeypatch, tmp_path):
    monkeypatch.setattr(svc, "get_settings", lambda: _Settings(str(tmp_path)))
    monkeypatch.setattr(
        svc, "record_audit",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    order = _order(seeded_db)
    with pytest.raises(RuntimeError):
        svc.create_attachment(
            seeded_db,
            entity_type="order",
            entity_id=order.order_no,
            file_name="x.txt",
            content_type="text/plain",
            content_base64=base64.b64encode(b"hi").decode(),
            user=ADMIN,
        )
    assert list(tmp_path.glob("*.txt")) == []
