"""AUTH-01 批次五：认证与权限 6 条逻辑缺陷回归（#20/#21/#22/#23/#24/#25）。

#20 合作方联系方式默认脱敏（读全值须权限+审计）
#21 客户 update/status/merge 不再硬编码回显明文
#22 登录限流客户端 IP 取 X-Real-IP / XFF 最右段，绝不取可伪造首段
#23 生产环境判定统一为 Settings.is_production（抗大小写/空白），mock 短信生产必拒
#24 微信绑定惰性失效（账号停用/手机号变更）写审计
#25 资金流水附件写须持资金写权限，非仅 finance.read
"""
from __future__ import annotations

import pytest
from sqlalchemy import select
from starlette.requests import Request

from app.attachments import service as attachments_service
from app.auth import router as auth_router
from app.auth import sms as sms_module
from app.auth import wechat_router, wechat_service
from app.auth.wechat import WeChatIdentity
from app.core.errors import AuthError, PermissionDenied, Validation
from app.core.security import (
    PERM_DEPOSIT_POST,
    PERM_FINANCE_READ,
    CurrentUser,
)
from app.core.settings import Settings
from app.core.audit import AuditLog
from app.domain.enums import AuditAction
from app.domain.users import User, UserWeChatBinding
from app.parties.customers import create_customer

COUNTERPARTIES = "/api/v1/counterparties"
CUSTOMERS = "/api/v1/customers"


def _request(client_ip: str | None, headers: list[tuple[bytes, bytes]]) -> Request:
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": headers,
        "query_string": b"",
        "client": (client_ip, 12345) if client_ip else None,
    }
    return Request(scope)


def _user(perms=()) -> CurrentUser:
    return CurrentUser(
        id=2, username="u2", roles=(), permissions=frozenset(perms),
        pool_ids=frozenset(), owner_scope="SELF",
    )


# --------------------------------------------------------- #22 XFF 抗伪造
def test_client_ip_prefers_x_real_ip():
    req = _request(
        "9.9.9.9",
        [(b"x-real-ip", b"203.0.113.10"), (b"x-forwarded-for", b"1.1.1.1, 2.2.2.2")],
    )
    assert auth_router._client_ip(req) == "203.0.113.10"
    assert wechat_router._client_ip(req) == "203.0.113.10"


def test_client_ip_uses_rightmost_forwarded_not_spoofable_left():
    """攻击者可在 XFF 左侧塞任意伪造 IP；nginx 把真实对端追加到最右，必须取最右。"""
    req = _request("9.9.9.9", [(b"x-forwarded-for", b"666.666.666.666, 198.51.100.7")])
    assert auth_router._client_ip(req) == "198.51.100.7"
    assert wechat_router._client_ip(req) == "198.51.100.7"


def test_client_ip_falls_back_to_peer():
    req = _request("9.9.9.9", [])
    assert auth_router._client_ip(req) == "9.9.9.9"


# --------------------------------------------------------- #23 is_production 归一
@pytest.mark.parametrize("raw", ["production", "PRODUCTION", " Production "])
def test_is_production_normalizes_case_and_space(raw):
    assert Settings(app_env=raw).is_production is True


@pytest.mark.parametrize("raw", ["development", "dev", "staging", ""])
def test_is_production_false_for_non_prod(raw):
    assert Settings(app_env=raw).is_production is False


def test_mock_sms_rejected_in_production():
    settings = Settings(app_env="PRODUCTION", sms_provider="mock")
    with pytest.raises(Validation, match="mock 且运行在生产环境"):
        sms_module.deliver_code(settings, phone="13800001111", code="123456", purpose="LOGIN")


def test_mock_sms_allowed_in_dev():
    settings = Settings(app_env="development", sms_provider="mock")
    out = sms_module.deliver_code(settings, phone="13800001111", code="123456", purpose="LOGIN")
    assert out.echo_code == "123456"


# --------------------------------------------------------- #20 合作方脱敏
def test_counterparty_list_masks_contact_without_permission(seeded_client):
    # EMPLOYEE: 有 counterparty.read，无 customer.contact.read
    seeded_client.post(
        COUNTERPARTIES,
        json={
            "display_name": "同行甲", "type": "PEER", "phone": "13800009999",
            "wechat": "wx_peer_001", "qq": "123456789",
        },
        headers={"X-Dev-User": "admin"},
    )
    resp = seeded_client.get(COUNTERPARTIES, headers={"X-Dev-User": "employee"})
    assert resp.status_code == 200, resp.text
    row = resp.json()[0]
    assert row["contact_masked"] is True
    assert row["phone"] == "138****9999"
    assert row["wechat"].startswith("wx") and "*" in row["wechat"]


def test_counterparty_detail_reveal_requires_permission_and_writes_audit(seeded_client, seeded_db):
    cp = seeded_client.post(
        COUNTERPARTIES,
        json={"display_name": "同行乙", "type": "PEER", "phone": "13800008888"},
        headers={"X-Dev-User": "admin"},
    ).json()

    # 无权限者即使传 reveal=true 也拿不到明文
    masked = seeded_client.get(
        f"{COUNTERPARTIES}/{cp['id']}?reveal=true", headers={"X-Dev-User": "employee"}
    ).json()
    assert masked["contact_masked"] is True
    assert masked["phone"] == "138****8888"

    # 有权限者显式 reveal=true 拿到明文并写审计
    full = seeded_client.get(
        f"{COUNTERPARTIES}/{cp['id']}?reveal=true", headers={"X-Dev-User": "admin"}
    ).json()
    assert full["contact_masked"] is False
    assert full["phone"] == "13800008888"
    seeded_db.commit()
    audits = seeded_db.scalars(
        select(AuditLog).where(
            AuditLog.action == AuditAction.CONTACT_READ.value,
            AuditLog.entity_type == "counterparty",
        )
    ).all()
    assert len(audits) == 1


# --------------------------------------------------------- #21 客户写操作按权限
def test_customer_update_honors_contact_permission(seeded_client):
    """update 端点按 customer.contact.read 决定回显，合法经办路径仍见明文。

    无联系方式读权限的判定与遮罩由 test_customer_update_masks_when_role_lacks_contact_read
    以精确权限集合覆盖（权限矩阵无「有 update 无 contact.read」现成角色）。
    """
    created = seeded_client.post(
        CUSTOMERS,
        json={"display_name": "客户丙", "phone": "13800007777"},
        headers={"X-Dev-User": "admin"},
    ).json()["customer"]
    resp = seeded_client.patch(
        f"{CUSTOMERS}/{created['id']}",
        json={"note": "已更新"},
        headers={"X-Dev-User": "admin"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["contact_masked"] is False
    assert resp.json()["phone"] == "13800007777"


def test_customer_update_masks_when_role_lacks_contact_read(seeded_db):
    """无联系方式读权限、但有 update 权限的用户，写操作返回必须遮罩。

    写操作端点已改为按 user.has(PERM_CUSTOMER_CONTACT_READ) 传 reveal_contact；
    这里用权限集合精确的 CurrentUser 锁住该判定与 to_customer_out 输出契约。
    """
    from app.parties._common import to_customer_out

    cust = create_customer(
        seeded_db, display_name="客户丁", phone="13800006666", actor="pytest"
    )
    actor = _user(perms=("customer.update",))
    reveal = actor.has("customer.contact.read")
    out = to_customer_out(cust, reveal_contact=reveal)
    assert reveal is False
    assert out["contact_masked"] is True
    assert out["phone"] == "138****6666"


# --------------------------------------------------------- #24 微信惰性失效审计
def test_resolve_login_phone_changed_writes_unbind_audit(seeded_db):
    user = User(
        username="wxuser", display_name="微信用户", password_hash="x",
        role="OPERATOR", owner_scope="ALL", pool_ids=[], team_ids=[],
        phone="13800001111", is_active=True,
    )
    seeded_db.add(user)
    seeded_db.flush()
    binding = UserWeChatBinding(
        user_id=user.id, provider="MOCK", open_id="openid-b5", bound_phone="13800001111",
        is_active=True,
    )
    seeded_db.add(binding)
    # 手机号已变更
    user.phone = "13900002222"
    seeded_db.commit()

    settings = Settings(app_env="development", wechat_provider="mock")
    result = wechat_service.resolve_login(
        seeded_db, settings, WeChatIdentity(provider="MOCK", open_id="openid-b5")
    )
    assert result.state == "bind_required"
    seeded_db.refresh(binding)
    assert binding.is_active is False
    seeded_db.commit()
    audits = seeded_db.scalars(
        select(AuditLog).where(
            AuditLog.action == AuditAction.WECHAT_UNBIND.value,
            AuditLog.reason.contains("手机号已变更"),
        )
    ).all()
    assert len(audits) == 1


def test_resolve_login_disabled_user_writes_unbind_audit(seeded_db):
    user = User(
        username="wxuser2", display_name="停用用户", password_hash="x",
        role="OPERATOR", owner_scope="ALL", pool_ids=[], team_ids=[],
        phone="13700001111", is_active=False,
    )
    seeded_db.add(user)
    seeded_db.flush()
    seeded_db.add(UserWeChatBinding(
        user_id=user.id, provider="MOCK", open_id="openid-b5-2",
        bound_phone="13700001111", is_active=True,
    ))
    seeded_db.commit()
    settings = Settings(app_env="development", wechat_provider="mock")
    with pytest.raises(AuthError, match="已停用"):
        wechat_service.resolve_login(
            seeded_db, settings, WeChatIdentity(provider="MOCK", open_id="openid-b5-2")
        )
    seeded_db.commit()
    audits = seeded_db.scalars(
        select(AuditLog).where(
            AuditLog.action == AuditAction.WECHAT_UNBIND.value,
            AuditLog.reason.contains("已停用"),
        )
    ).all()
    assert len(audits) == 1


# --------------------------------------------------------- #25 附件写权限
def test_cashflow_attachment_write_rejects_read_only_role():
    target = attachments_service._Target("cashflow", "x", pool_id=1)
    # 仅 finance.read：读可、写不可
    attachments_service._assert_permission(_user(perms=(PERM_FINANCE_READ,)), target, write=False)
    with pytest.raises(PermissionDenied, match="无权访问"):
        attachments_service._assert_permission(
            _user(perms=(PERM_FINANCE_READ,)), target, write=True
        )


def test_cashflow_attachment_write_allows_fund_write_role():
    target = attachments_service._Target("cashflow", "x", pool_id=1)
    attachments_service._assert_permission(_user(perms=(PERM_DEPOSIT_POST,)), target, write=True)
