"""全局 API 契约护栏：业务 JSON 接口必须声明响应模型。"""
from __future__ import annotations

from typing import Any


NON_JSON_ROUTES = frozenset(
    {
        ("DELETE", "/api/v1/pools/{pool_id}"),
        ("DELETE", "/api/v1/field-definitions/{definition_id}"),
        ("DELETE", "/api/v1/order-form-fields/{field_id}"),
        ("DELETE", "/api/v1/option-sets/{code}"),
        ("DELETE", "/api/v1/orders/{order_id}/links/{link_id}"),
        ("GET", "/api/v1/reports/{report_name}/export.csv"),
        ("GET", "/api/v1/attachments/{attachment_id}/download"),
        ("DELETE", "/api/v1/game-types/{game_type_id}"),
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

    # public_routes = 167（实测）。基线演变：160 → 161（GET /order-form-fields/scopes）
    # → 166（状态收口五端点：policy supersede / expire-sweep、rebate void、
    # deposit cancel、import batch reject）→ 167（补 game-types DELETE 豁免后复核：
    # 该路由此前因缺 response_model 在中途断言失败，掩盖了计数差异，实际总数已是 167）。
    # 以当前应用实际路由数为准。
    assert public_routes == 167
