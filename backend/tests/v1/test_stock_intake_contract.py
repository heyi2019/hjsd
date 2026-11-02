"""tests/v1/test_stock_intake_contract：账号入库（库存创建）契约测试（BIZ-INV-INTAKE）。

业务背景
--------
本 ERP 没有独立的「入库」接口：库存账号（Account）由订单建档时**内联创建**
（orders.create._create_inline_inventory_account）。HS/TH/DG 订单携带 account_snapshot
建单即生成库存编号并写入 inventory_entry_at（入库时间）。因此「账号入库」的真实入口是
``POST /api/v1/orders``（HS/TH/DG + account_snapshot）。

本文件覆盖入库链路上的**高风险业务规则**（对应验收标准第七阶段·订单与库存）：
- 入库成功：建单即生成库存账号，且入库时间被写入（DB 状态而非仅响应）；
- 重复入库拦截：同一 game_account + game_type 已有未售账号时拒绝（INVENTORY_ACCOUNT_IN_STOCK），
  且事务回滚、**不产生幽灵库存行**；
- 已售复购：历史同账号已售出时须显式 confirm_repurchase，否则拒绝（REPURCHASE_CONFIRM_REQUIRED）；
- 未知业务类型拒绝；
- 引用已有库存账号（account_id）建单时**不再新建**库存行。

测试分类：API 集成（seeded_client + 真实 PG）+ 服务级集成（seeded_db，直接校验 DB 状态）。
不依赖生产库；conftest 已强制 TEST_DATABASE_URL 与 dev 库隔离、库名含 test。
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import func, select

from app.core.errors import ErrorCode
from app.domain.enums import AccountStatus
from app.domain.trade import Account, Order
from app.orders import service as orders_service

TODAY = date(2026, 10, 4)


def _make_account(session, *, game_account: str, game_type: str, status: str) -> Account:
    """直接落一条库存账号（绕过订单），用于构造"已存在同账号"的判重前提。"""
    account = Account(
        game_account=game_account,
        game_type=game_type,
        platform="微信",
        business_mode="SELF",
        inventory_type="RECOVERY",
        status=status,
        created_by="pytest",
        updated_by="pytest",
    )
    session.add(account)
    session.commit()
    return account


def _count_accounts(session, game_account: str) -> int:
    return int(
        session.scalar(
            select(func.count())
            .select_from(Account)
            .where(Account.game_account == game_account)
        )
        or 0
    )


# ---------------------------------------------------------------------------
# API 集成测试（黑盒：输入 → 操作 → 输出 → 数据状态）
# ---------------------------------------------------------------------------


def test_hs_intake_creates_inventory_account_and_writes_entry_at(
    seeded_client, headers, seeded_db
):
    """BIZ-INV-INTAKE-001：HS 快照建单即入库，且入库时间写入 DB。

    黑盒：提交 HS + account_snapshot → 201 且返回 account_id；
    白盒补充：该库存行的 inventory_entry_at 不为空、状态非 SOLD（已落入库存）。
    """
    resp = seeded_client.post(
        "/api/v1/orders",
        json={
            "order_type": "HS",
            "trade_date": TODAY.isoformat(),
            "account_snapshot": {
                "game_account": "intake-hs-001",
                "game_type": "王者荣耀",
            },
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    account_id = body["account_id"]
    assert account_id is not None

    account = seeded_db.get(Account, account_id)
    assert account is not None
    assert account.inventory_entry_at is not None
    assert account.status != AccountStatus.SOLD.value
    # 建单成功即生成库存编号（KU_+5），是"已入库"的直接证据。
    assert (account.stock_no or "").startswith("KU_")


def test_duplicate_intake_of_unsold_account_rejected_and_no_phantom_row(
    seeded_client, headers, seeded_db
):
    """BIZ-INV-INTAKE-002（高）：同一未售账号重复入库被拒，且不产生幽灵库存行。"""
    _make_account(
        seeded_db,
        game_account="dup-unsold-001",
        game_type="王者荣耀",
        status=AccountStatus.WAITING.value,
    )
    before = _count_accounts(seeded_db, "dup-unsold-001")
    assert before == 1

    resp = seeded_client.post(
        "/api/v1/orders",
        json={
            "order_type": "HS",
            "trade_date": TODAY.isoformat(),
            "account_snapshot": {
                "game_account": "dup-unsold-001",
                "game_type": "王者荣耀",
            },
        },
        headers=headers,
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == ErrorCode.INVENTORY_ACCOUNT_IN_STOCK

    # 事务回滚：失败建单不应留下第二条库存账号。
    after = _count_accounts(seeded_db, "dup-unsold-001")
    assert after == before == 1


def test_sold_account_repurchase_requires_confirm(seeded_client, headers, seeded_db):
    """BIZ-INV-INTAKE-003（高）：历史已售同账号复购回流须显式确认。"""
    sold = _make_account(
        seeded_db,
        game_account="repurchase-001",
        game_type="王者荣耀",
        status=AccountStatus.SOLD.value,
    )

    # 未确认 → 拒绝
    rejected = seeded_client.post(
        "/api/v1/orders",
        json={
            "order_type": "HS",
            "trade_date": TODAY.isoformat(),
            "account_snapshot": {
                "game_account": "repurchase-001",
                "game_type": "王者荣耀",
            },
        },
        headers=headers,
    )
    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["code"] == ErrorCode.REPURCHASE_CONFIRM_REQUIRED

    # 确认 → 放行，且为复购回流新建一条库存账号（不覆盖原已售行）
    confirmed = seeded_client.post(
        "/api/v1/orders",
        json={
            "order_type": "HS",
            "trade_date": TODAY.isoformat(),
            "confirm_repurchase": True,
            "account_snapshot": {
                "game_account": "repurchase-001",
                "game_type": "王者荣耀",
            },
        },
        headers=headers,
    )
    assert confirmed.status_code == 201, confirmed.text
    new_account_id = confirmed.json()["account_id"]
    assert new_account_id != sold.id
    assert _count_accounts(seeded_db, "repurchase-001") == 2


def test_unknown_order_type_rejected(seeded_client, headers):
    """BIZ-INV-INTAKE-004：未知业务类型建单被拒（契约边界）。"""
    resp = seeded_client.post(
        "/api/v1/orders",
        json={
            "order_type": "ZZ",
            "trade_date": TODAY.isoformat(),
            "account_snapshot": {"game_account": "x", "game_type": "王者荣耀"},
        },
        headers=headers,
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == ErrorCode.VALIDATION_ERROR


# ---------------------------------------------------------------------------
# 服务级集成测试（白盒：直接校验 DB 状态与关键分支）
# ---------------------------------------------------------------------------


def test_inline_intake_sets_entry_at_equal_to_order_created(seeded_db):
    """BIZ-INV-INTAKE-001 白盒：内联建库写入的入库时间等于订单建档时间。"""
    order = orders_service.create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_snapshot={
            "game_account": "svc-intake-001",
            "game_type": "王者荣耀",
        },
    )
    seeded_db.commit()
    assert order.account_id is not None
    account = seeded_db.get(Account, order.account_id)
    assert account is not None
    assert account.inventory_entry_at is not None
    # 入库时间以建单成功时间为准（create.py 用 order.created_at.replace(microsecond=0)）。
    assert account.inventory_entry_at == order.created_at.replace(microsecond=0)


def test_referencing_existing_account_does_not_create_new_row(seeded_db):
    """BIZ-INV-INTAKE-005：引用已有库存账号建单时不再新建库存行。"""
    existing = _make_account(
        seeded_db,
        game_account="ref-existing-001",
        game_type="王者荣耀",
        status=AccountStatus.WAITING.value,
    )
    before = _count_accounts(seeded_db, "ref-existing-001")
    assert before == 1

    order = orders_service.create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_id=existing.id,
    )
    seeded_db.commit()
    assert order.account_id == existing.id
    # 未提供快照、仅引用已有账号 → 库存行数量不变。
    assert _count_accounts(seeded_db, "ref-existing-001") == before
