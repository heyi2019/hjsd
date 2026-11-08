"""API-01 全局 API 契约护栏：业务 JSON 接口必须声明响应模型。"""
from __future__ import annotations

from typing import Any


NON_JSON_ROUTES = frozenset(
    {
        ("DELETE", "/api/v1/pools/{pool_id}"),
        ("DELETE", "/api/v1/order-form-fields/{field_id}"),
        ("DELETE", "/api/v1/option-sets/{code}"),
        ("DELETE", "/api/v1/orders/{order_id}/links/{link_id}"),
        ("GET", "/api/v1/reports/{report_name}/export.csv"),
        ("GET", "/api/v1/attachments/{attachment_id}/download"),
        ("DELETE", "/api/v1/game-types/{game_type_id}"),
        ("DELETE", "/api/v1/rebates/{rebate_id}"),
        ("DELETE", "/api/v1/stocks/{account_id}"),
        ("GET", "/api/v1/orders/export.csv"),
        ("GET", "/api/v1/orders/export.xlsx"),
        ("GET", "/api/v1/stocks/export.csv"),
        ("GET", "/api/v1/customers/export.csv"),
        ("GET", "/api/v1/installments/export.csv"),
        ("GET", "/api/v1/rebates/export.csv"),
        ("GET", "/api/v1/cashflows/export.csv"),
    }
)


def test_every_json_api_route_declares_response_model(app):
    public_routes = 0
    for route in app.routes:
        methods = getattr(route, "methods", set())
        if not methods or not route.path.startswith("/api/v1"):
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

    # 当前公开路由总数固定为 176，新增或移除路由时同步更新契约。
    assert public_routes == 176
