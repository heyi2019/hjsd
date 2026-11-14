"""API-01 全局 API 契约护栏：业务 JSON 接口必须声明响应模型。"""
from __future__ import annotations

from typing import Any


NON_JSON_ROUTES = frozenset(
    {
        ("DELETE", "/api/v1/pools/{pool_id}"),
        ("DELETE", "/api/v1/order-form-fields/{field_id}"),
        ("DELETE", "/api/v1/option-sets/{code}"),
        ("DELETE", "/api/v1/orders/{order_id}/links/{link_id}"),
        ("DELETE", "/api/v1/orders/{order_id}"),
        ("GET", "/api/v1/reports/{report_name}/export.csv"),
        ("GET", "/api/v1/attachments/{attachment_id}/download"),
        ("DELETE", "/api/v1/game-types/{game_type_id}"),
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

    # public_routes = 170（实测）。基线演变：160 → 161（GET /order-form-fields/scopes）
    # → 166（状态收口五端点：policy supersede / expire-sweep、
    # deposit cancel、import batch reject）→ 167（补 game-types DELETE 豁免后复核：
    # 该路由此前因缺 response_model 在中途断言失败，掩盖了计数差异，实际总数已是 167）
    # → 170（168 为并行会话新增端点后的实测值；列表列配置再 +2：GET /list-columns、
    # PUT /list-columns/{scope}）→ 171（+DELETE /list-columns/{scope}：恢复默认）
    # → 174（自定义列 +3：GET /list-columns/custom-fields、POST /list-columns/{scope}/custom、
    # DELETE /list-columns/{scope}/custom/{column_key}）。返点结算/冲销/取消旧入口已移除。
    # → 176（主列表导出 +6：/orders /stocks /customers /installments /rebates /cashflows）。
    # → 174（删除资金流水审核/驳回端点：POST /cashflows/{id}/approve、POST /cashflows/{id}/reject，
    # 资金流水改为创建即入账；下游 reporting/orders 仍按 ==APPROVED 过滤，不受影响）。
    # order-types 路由配置的两个端点已包含在 174 的当前实际基线中，
    # 不再重复叠加计数：GET /order-types/{order_type_id}/routes、
    # GET /order-types/{code}/routes/impact-preview。
    # → 175（订单台账 xlsx 导出：GET /orders/export.xlsx，非 JSON 已入豁免表）。
    # → 179（派生运算下沉后端 +4：GET /pools/balances、GET /installments/totals、
    # GET /cashflows/studio-summary、POST /stocks/inventory/stats）。
    # → 189（2026-11-05 实测：账号删除 + 免密登录/绑定、列表列配置、库存统计等累计 +10）
    # → 190（订单退款改为独立资金明细接口）→ 191（订单关联收入/支出资金明细）
    # → 190（2026-11-12 复核实测：此前断言 192 已过时——HEAD 实测即 190；
    #        注释停在 191 但从未同步断言，属既有漂移，本次据实校正）
    # → 189（2026-11-12 裁决：删除 DELETE /rebates/{id}（返点不可作废），-1）。
    # → 190（2026-11-12 裁决：返点退回改走真实 OUT，新增 POST /rebates/{id}/return，+1）。
    # → 181（移除手机号验证码 / 微信登录公开接口，-9）→ 170（下线质量分析、全局搜索、
    # 附件中心、系统提醒和资金属性分析独立入口及其后端路由）。
    # 注：public_routes 在豁免判断之前 +1，故豁免路由（含已删的 DELETE /rebates）也计数。
    assert public_routes == 170
