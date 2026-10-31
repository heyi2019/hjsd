"""主列表导出（/xxx/export.csv）：列配置口径 —— 可见列 + 中文表头 + 自定义列 + 值翻译。

口径：
- 导出列 = 「设置 → 列表字段」该 scope 的可见列（隐藏列不导，actions 等 UI 列不导）；
- 自定义列值从行扩展字段注入，SELECT 选项翻中文；
- 客户联系方式沿用列表脱敏口径：无 `customer.contact.read` 导出脱敏值；
- 每次导出写 LIST_EXPORT 审计。
"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog
from app.domain.trade import Order, OrderFormField


def _seed_select_field(db, *, field_key: str = "trade_role") -> OrderFormField:
    row = OrderFormField(
        order_type_code="CUSTOMER",
        field_key=field_key,
        label="交易角色",
        field_type="SELECT",
        options=[{"value": "BUYER", "label": "买家"}, {"value": "SELLER", "label": "卖家"}],
        flow_direction=None,
        required=False,
        required_when=None,
        is_active=True,
        sort_order=0,
        locked=False,
        is_custom=True,
        section="EXTRA",
        created_by="tester",
        updated_by="tester",
    )
    db.add(row)
    db.flush()
    return row


def _seed_order(db, *, order_no: str = "HS9901", form_extra: dict | None = None) -> Order:
    order = Order(
        order_no=order_no,
        order_type="HS",
        capital_type="STOCK",
        trade_date=date(2026, 1, 1),
        form_extra=form_extra,
        created_by="tester",
        updated_by="tester",
    )
    db.add(order)
    db.flush()
    return order


def _headers(text: str) -> list[str]:
    # 导出带 UTF-8 BOM，表头首列实际是 "\ufeffrow_type"
    return text.splitlines()[0].lstrip("\ufeff").split(",")


def test_orders_export_uses_chinese_visible_columns(seeded_client, headers, seeded_db):
    _seed_order(seeded_db, order_no="HS9801")
    response = seeded_client.get("/api/v1/orders/export.csv", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    body = response.text
    assert body.startswith("\ufeff")  # BOM
    header = _headers(body)
    assert header[0] == "row_type"
    assert "订单号" in header
    assert "对方 / 来源" in header
    assert "操作" not in header  # UI 列不导出
    assert "HS9801" in body  # 明细行带订单号


def test_orders_export_appends_full_detail_in_the_same_csv_table(seeded_client, headers, seeded_db):
    _seed_order(seeded_db, order_no="HS9803", form_extra={"delivery_note": "已交付"})
    body = seeded_client.get("/api/v1/orders/export.csv", headers=headers).text
    header = _headers(body)
    assert "详情" not in header
    assert "账号密码" in header
    assert "操作明细" in header
    assert "delivery_note" in body
    assert "HS9803" in body


def test_installments_export_appends_full_detail_in_the_same_csv_table(seeded_client, headers):
    body = seeded_client.get("/api/v1/installments/export.csv", headers=headers).text
    header = _headers(body)
    assert "详情" not in header
    assert "期次明细" in header
    assert "处置记录" in header


def test_orders_export_respects_hidden_column(seeded_client, headers, seeded_db):
    columns = next(
        scope
        for scope in seeded_client.get("/api/v1/list-columns", headers=headers).json()
        if scope["code"] == "LEDGER"
    )["columns"]
    items = [
        {
            "column_key": column["key"],
            "is_visible": column["key"] != "status",
            "sort_order": index * 10,
        }
        for index, column in enumerate(columns)
    ]
    assert seeded_client.put(
        "/api/v1/list-columns/LEDGER", json={"items": items}, headers=headers
    ).status_code == 200

    body = seeded_client.get("/api/v1/orders/export.csv", headers=headers).text
    header = _headers(body)
    assert "状态" not in header
    assert "订单号" in header  # 其余可见列仍在

    seeded_client.delete("/api/v1/list-columns/LEDGER", headers=headers)


def test_orders_export_includes_custom_column_with_translated_value(
    seeded_client, headers, seeded_db
):
    _seed_select_field(seeded_db)
    _seed_order(seeded_db, order_no="HS9802", form_extra={"trade_role": "BUYER"})
    assert seeded_client.post(
        "/api/v1/list-columns/LEDGER/custom",
        json={"field_key": "trade_role", "label": "交易角色"},
        headers=headers,
    ).status_code == 200

    body = seeded_client.get("/api/v1/orders/export.csv", headers=headers).text
    header = _headers(body)
    assert "交易角色" in header
    assert "买家" in body  # SELECT 码值翻译成中文
    assert "BUYER" not in body.replace("trade_role", "")  # 原码不出现（除字段键外）


def test_customers_export_masks_contact_without_permission(seeded_client, headers, viewer_headers, seeded_db):
    created = seeded_client.post(
        "/api/v1/customers",
        json={"display_name": "导出客户甲", "phone": "13800001111"},
        headers=headers,
    )
    assert created.status_code == 201, created.text

    admin_body = seeded_client.get("/api/v1/customers/export.csv", headers=headers).text
    assert "13800001111" in admin_body  # 有 contact.read 权限 → 明文

    viewer_body = seeded_client.get("/api/v1/customers/export.csv", headers=viewer_headers).text
    assert "13800001111" not in viewer_body  # 无权限 → 脱敏，不泄露明文


def test_cashflows_export_chinese_header(seeded_client, headers, seeded_db):
    response = seeded_client.get("/api/v1/cashflows/export.csv", headers=headers)
    assert response.status_code == 200, response.text
    header = _headers(response.text)
    assert header[0] == "row_type"


def test_rebates_export_chinese_header(seeded_client, headers, seeded_db):
    response = seeded_client.get("/api/v1/rebates/export.csv", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert _headers(response.text)[0] == "row_type"


def test_export_writes_list_export_audit(seeded_client, headers, seeded_db):
    seeded_client.get("/api/v1/orders/export.csv", headers=headers)
    actions = [
        row.action
        for row in seeded_db.scalars(
            select(AuditLog).where(AuditLog.entity_type == "list_export")
        ).all()
    ]
    assert AuditAction.LIST_EXPORT.value in actions
