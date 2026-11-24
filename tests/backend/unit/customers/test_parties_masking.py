"""CONTACT-01 客户与合作方联系方式直接返回原值。"""
from __future__ import annotations

from app.domain.parties import Counterparty, Customer
from app.customers._common import to_counterparty_out, to_customer_out


def test_customer_output_always_returns_full_contact():
    cust = Customer(
        id=1, customer_no="CUS0001", display_name="张三",
        contact_name="张三", phone="13800001111", wechat="wxid_abc", qq="123456",
        owner_id=1, status="ACTIVE", created_by="admin",
    )
    out = to_customer_out(cust)
    assert "contact_masked" not in out
    assert out["phone"] == "13800001111"
    assert out["wechat"] == "wxid_abc"
    assert out["qq"] == "123456"
    assert out["created_by"] == "admin"


def test_counterparty_output_always_returns_full_contact():
    counterparty = Counterparty(
        id=1,
        counterparty_no="CP0001",
        display_name="同行A",
        type="PEER",
        contact_name="联系人",
        phone="13800002222",
        wechat="wx_peer",
        qq="654321",
        status="ACTIVE",
        created_by="admin",
    )
    out = to_counterparty_out(counterparty)
    assert "contact_masked" not in out
    assert out["phone"] == "13800002222"
    assert out["wechat"] == "wx_peer"
    assert out["qq"] == "654321"
    assert out["created_by"] == "admin"
