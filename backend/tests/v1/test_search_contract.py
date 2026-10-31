"""SYS-01-02 全局搜索契约测试。"""
from __future__ import annotations

from datetime import date

from app.stocks import service as stocks_service
from app.core.security import CurrentUser, build_access_token
from app.orders import service as orders_service
from app.parties import service as parties_service


def _types(response) -> set[str]:
    return {item["type"] for item in response.json()["items"]}


def test_global_search_covers_order_inventory_customer_and_counterparty(
    seeded_client, seeded_db, headers
):
    customer = parties_service.create_customer(
        seeded_db, display_name="搜索客户", owner_id=9, actor="pytest"
    )
    counterparty = parties_service.create_counterparty(
        seeded_db, display_name="搜索平台", type="PLATFORM", actor="pytest"
    )
    account = stocks_service.create_account(
        seeded_db,
        game_account="search-game-account",
        game_type="王者",
        platform="平台A",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = orders_service.create_order(
        seeded_db,
        order_type="HS",
        trade_date=date(2026, 10, 17),
        owner_id=9,
        actor="pytest",
    )

    for query, expected_type in (
        (order.order_no, "ORDER"),
        (account.game_account, "ACCOUNT"),
        (customer.customer_no, "CUSTOMER"),
        (counterparty.counterparty_no, "COUNTERPARTY"),
    ):
        response = seeded_client.get(
            "/api/v1/search", params={"q": query}, headers=headers
        )
        assert response.status_code == 200, response.text
        assert expected_type in _types(response)

    account_result = seeded_client.get(
        "/api/v1/search", params={"q": account.game_account}, headers=headers
    ).json()["items"][0]
    assert account_result["route"] == f"/stocks/{account.id}/execution-detail"

    counterparty_detail = seeded_client.get(
        f"/api/v1/counterparties/{counterparty.id}", headers=headers
    )
    assert counterparty_detail.status_code == 200, counterparty_detail.text
    assert counterparty_detail.json()["counterparty_no"] == counterparty.counterparty_no


def test_global_search_respects_customer_and_owner_scope(seeded_client, seeded_db):
    customer = parties_service.create_customer(
        seeded_db, display_name="不可见客户", owner_id=1, actor="pytest"
    )
    viewer = CurrentUser.build(
        id=5, username="viewer", roles=["VIEWER"], owner_scope="SELF"
    )
    response = seeded_client.get(
        "/api/v1/search",
        params={"q": customer.customer_no},
        headers={"Authorization": f"Bearer {build_access_token(viewer)}"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["items"] == []


def test_global_search_rejects_blank_query(seeded_client, headers):
    response = seeded_client.get(
        "/api/v1/search", params={"q": "   "}, headers=headers
    )
    assert response.status_code == 422
