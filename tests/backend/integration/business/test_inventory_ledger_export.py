"""EXPORT-01 库存台账导出由服务端按注册列输出。"""
from __future__ import annotations


def test_inventory_ledger_export_is_server_owned(seeded_client, headers):
    response = seeded_client.get(
        "/api/v1/stocks/inventory/ledger/export.csv",
        params={
            "business_mode": "SELF",
            "inventory_type": "RECOVERY",
            "game_type": "王者荣耀",
            "keyword": "账号-1",
            "date_from": "2026-01-01",
            "date_to": "2026-12-31",
            "sort_desc": "false",
        },
        headers=headers,
    )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.text.startswith("\ufeff订单号,业务,类型")
