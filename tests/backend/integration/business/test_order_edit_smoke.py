"""ORDER-01 订单主字段可编辑——登记时间(created_at)可改可清空、账号快照(account_snapshot)一律可编辑。

- created_at：可绝对设值，也可清空（置 NULL，列已放可为空）。
- account_snapshot：所有订单（含已有登记事件者）均可编辑。
"""
H = {"X-Dev-User": "admin"}


def _find_order(client, order_no: str) -> int:
    listing = client.get("/api/v1/orders?page=1&page_size=300", headers=H).json()
    items = listing.get("items") or listing.get("data") or []
    target = next((o for o in items if o["order_no"] == order_no), None)
    assert target is not None, f"缺少订单 {order_no}"
    return target["id"]


def test_update_order_created_at_set_and_clear(seeded_orders_client):
    client = seeded_orders_client
    oid = _find_order(client, "E2E-DG-ACTIVE-U-18")  # 无登记事件，最干净
    new_ts = "2026-01-02T03:04:05"
    r = client.patch(f"/api/v1/orders/{oid}", headers=H, json={"created_at": new_ts})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body.get("created_at") or "").startswith("2026-01-02T03:04"), body.get("created_at")

    r2 = client.patch(f"/api/v1/orders/{oid}", headers=H, json={"created_at": None})
    assert r2.status_code == 200, r2.text
    assert r2.json().get("created_at") is None


def test_update_order_account_snapshot_editable_for_unposted(seeded_orders_client):
    client = seeded_orders_client
    oid = _find_order(client, "E2E-DG-ACTIVE-U-18")
    r = client.patch(f"/api/v1/orders/{oid}", headers=H, json={
        "account_snapshot": {"game_account": "edited-snap", "game_type": "王者荣耀"},
    })
    assert r.status_code == 200, r.text
    assert r.json()["account_snapshot"]["game_account"] == "edited-snap"


def test_update_order_account_snapshot_editable_for_posted_order(seeded_orders_client):
    """#15 需求2：已有登记事件的订单，账号快照也应可编辑（无只读保留）。"""
    client = seeded_orders_client
    oid = _find_order(client, "E2E-HS-COMPLETED-U-06")  # 含登记/售出事件
    r = client.patch(f"/api/v1/orders/{oid}", headers=H, json={
        "account_snapshot": {"game_account": "edited-posted-snap", "game_type": "王者荣耀"},
    })
    assert r.status_code == 200, r.text
    assert r.json()["account_snapshot"]["game_account"] == "edited-posted-snap"
