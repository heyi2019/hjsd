"""API-01 全局 API 契约护栏：业务 JSON 接口必须声明响应模型。"""
from __future__ import annotations

from typing import Any


NON_JSON_ROUTES = frozenset(
    {
        ("DELETE", "/api/pools/{pool_id}"),
        ("DELETE", "/api/order-form-fields/{field_id}"),
        ("DELETE", "/api/option-sets/{code}"),
        ("DELETE", "/api/orders/{order_id}/links/{link_id}"),
        ("DELETE", "/api/orders/{order_id}"),
        ("GET", "/api/reports/{report_name}/export.csv"),
        ("GET", "/api/attachments/{attachment_id}/download"),
        ("DELETE", "/api/game-types/{game_type_id}"),
        ("DELETE", "/api/stocks/{account_id}"),
        ("DELETE", "/api/cashflows/{cashflow_id}"),
        ("DELETE", "/api/deposits/{deposit_id}"),
        ("GET", "/api/orders/export.csv"),
        ("GET", "/api/orders/export.xlsx"),
        ("GET", "/api/order-imports/template.xlsx"),
        ("GET", "/api/stocks/export.csv"),
        ("GET", "/api/customers/export.csv"),
        ("GET", "/api/installments/export.csv"),
        ("GET", "/api/cashflows/export.csv"),
        ("GET", "/api/stocks/inventory/ledger/export.csv"),
    }
)


def test_api_routes_use_unversioned_prefix(app):
    from fastapi.testclient import TestClient

    paths = {getattr(route, "path", "") for route in app.routes}
    assert "/api/pools" in paths
    assert "/api/health" in paths
    assert not any(path.startswith("/api/" + "v1/") for path in paths)
    with TestClient(app) as client:
        assert client.get("/api/pools").status_code == 401
        assert client.get("/api/" + "v1/pools").status_code == 404


def test_every_json_api_route_declares_response_model(app):
    public_routes = 0
    for route in app.routes:
        methods = getattr(route, "methods", set())
        if not methods or not route.path.startswith("/api"):
            continue
        for method in methods:
            if method == "HEAD":
                continue
            public_routes += 1
            if (method, route.path) in NON_JSON_ROUTES:
                continue
            assert route.response_model is not None, (
                f"{method} {route.path} must publish a response model"
            )
            assert route.response_model is not Any, (
                f"{method} {route.path} must not use Any as its response model"
            )

    assert public_routes > 0
