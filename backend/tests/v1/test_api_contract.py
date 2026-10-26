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

    # 165 = 159（2026-10 基线）+ 后续新增端点，含选项词典 5 个、订单表单字段、审计 /audit-logs/stats 等；
    # 2026-10-26 全量移除「资金池账户」板块后扣减其 5 个端点（GET/POST /pool-accounts、PATCH /{id}/status、PATCH /{id}、POST /batch-status）。
    assert public_routes == 165
