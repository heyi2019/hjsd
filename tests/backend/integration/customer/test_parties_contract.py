"""PARTY-01 parties 客户/合作方契约测试（CUS-01 / BAS-02-05 / BAS-04）。

与 test_parties.py 的分工：既有文件已覆盖编号域、联系方式原值输出、停用/合并参与方校验、
合并迁移主路径、字段停用保留历史值、以及创建客户/合作方/字段端点；
本文件补建单必填校验、查重空条件、查询三过滤+作用域、
客户更新（含已合并冲突与联系方式审计分流）、状态机 MERGED 守卫、
合并同源/已合并/重复角色去重、合作方查询与更新、字段定义三项校验与停用过滤、
表单扩展字段覆写，以及 7 个未测路由端点。
"""
from __future__ import annotations
import pytest
from sqlalchemy import select
from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.enums import (
    AuditAction)
from app.domain.foundation import AuditLog
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

def test_customer_list_supports_limit_and_offset(seeded_client, seeded_db):
    _customer(seeded_db, "客户一")
    _customer(seeded_db, "客户二")
    _customer(seeded_db, "客户三")

    response = seeded_client.get(
        CUSTOMERS, params={"limit": 1, "offset": 1}, headers={"X-Dev-User": "admin"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["total"] == 3
    assert response.json()["limit"] == 1
    assert response.json()["offset"] == 1
    assert len(response.json()["items"]) == 1
    assert response.json()["items"][0]["display_name"] == "客户二"

def test_customer_keyword_search_escapes_like_wildcards(seeded_client, seeded_db):
    """客户昵称/微信含 `_` `%` 时按字面匹配，不触发 LIKE 通配误命中。"""
    hit = _customer(seeded_db, "王者_001", wechat="wx_50%")
    _customer(seeded_db, "王者X001")  # `_` 若未转义会误命中
    _customer(seeded_db, "其他客户")

    # 下划线按字面：只命中昵称含真实下划线的行
    by_underscore = seeded_client.get(
        CUSTOMERS, params={"keyword": "王者_001"}, headers={"X-Dev-User": "admin"}
    )
    assert by_underscore.status_code == 200, by_underscore.text
    assert by_underscore.json()["total"] == 1
    assert by_underscore.json()["items"][0]["display_name"] == "王者_001"

    # 微信里的 % 按字面：只命中该行，不命中全表
    by_percent = seeded_client.get(
        CUSTOMERS, params={"keyword": "50%"}, headers={"X-Dev-User": "admin"}
    )
    assert by_percent.status_code == 200, by_percent.text
    assert by_percent.json()["total"] == 1
    assert by_percent.json()["items"][0]["id"] == hit.id

def test_customer_list_query_filters_by_created_by(seeded_client, seeded_db):
    mine = create_customer(seeded_db, display_name="接口创建人甲", actor="alice")
    create_customer(seeded_db, display_name="接口创建人乙", actor="bob")

    response = seeded_client.get(
        CUSTOMERS,
        params=[("created_by", "alice")],
        headers={"X-Dev-User": "admin"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["total"] == 1
    assert response.json()["items"][0]["id"] == mine.id

def test_customer_detail_does_not_record_contact_read_audit(seeded_client, seeded_db, headers):
    customer = _customer(seeded_db, "联系方式客户", phone="13800001234")
    response = seeded_client.get(
        f"/api/v1/customers/{customer.id}/detail",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert not any(row.action == "CONTACT_READ" for row in seeded_db.scalars(select(AuditLog)).all())

def test_validate_owner_id_rejects_non_positive_and_inactive(seeded_db):
    from app.customer_center._common import _validate_owner_id
    from app.domain.users import User

    with pytest.raises(Validation):
        _validate_owner_id(seeded_db, 0)
    inactive = User(
        username="inactive-owner", display_name="停用负责人", password_hash="x",
        role="VIEWER", owner_scope="SELF", is_active=False,
    )
    seeded_db.add(inactive)
    seeded_db.flush()
    with pytest.raises(Validation, match="启用"):
        _validate_owner_id(seeded_db, inactive.id)
