"""EXPORT-01 主列表导出（/xxx/export.csv）：列配置口径 —— 可见列 + 中文表头 + 自定义列 + 值翻译。

口径：
- 导出列 = 「设置 → 列表字段」该 scope 的可见列（隐藏列不导，actions 等 UI 列不导）；
- 自定义列值从行扩展字段注入，SELECT 选项翻中文；
- 客户联系方式沿用列表脱敏口径：无 `customer.contact.read` 导出脱敏值；
- 每次导出写 LIST_EXPORT 审计。
"""
from __future__ import annotations

import io
from datetime import date

import openpyxl
from sqlalchemy import select

from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog
from app.domain.trade import Order, OrderFormField
from app.orders.router import _event_platform


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


def _seed_order(
    db,
    *,
    order_no: str = "HS9901",
    form_extra: dict | None = None,
    order_type: str = "HS",
) -> Order:
    order = Order(
        order_no=order_no,
        order_type=order_type,
        trade_date=date(2026, 1, 1),
        form_extra=form_extra,
        created_by="tester",
        updated_by="tester",
    )
    db.add(order)
    db.flush()
    return order


def _headers(text: str) -> list[str]:
    # 导出带 UTF-8 BOM，表头首列实际是 "\ufeffrow_type"；CSV 恒为单行表头
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
    assert "游戏/产品类型" in header
    assert "操作" not in header  # UI 列不导出
    assert "HS9801" in body  # 明细行带订单号


def test_orders_export_keeps_single_row_header(seeded_client, headers, seeded_db):
    """CSV 必须单行表头：导入解析以首个非空行为表头，多行表头会让回流导入错位。"""
    _seed_order(seeded_db, order_no="HS9804")
    body = seeded_client.get("/api/v1/orders/export.csv", headers=headers).text
    first = body.splitlines()[0].lstrip("\ufeff").split(",")

    assert first[0] == "row_type"
    assert "订单号" in first
    assert "台账信息" not in first  # 不存在分组行
    assert body.splitlines()[1].startswith("ITEM")  # 第二行即数据


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


def test_orders_export_xlsx_has_five_sheets(seeded_client, headers, seeded_db):
    """xlsx 导出：主订单 + 详情 + 操作/资金/返点三类明细，详情表头三级且一级为真合并。"""
    _seed_order(seeded_db, order_no="HS9805", form_extra={"delivery_note": "已交付"})
    response = seeded_client.get("/api/v1/orders/export.xlsx", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )

    workbook = openpyxl.load_workbook(io.BytesIO(response.content))
    assert workbook.sheetnames == ["主订单信息", "详情信息", "操作明细", "资金明细", "返点明细"]

    main_sheet = workbook["主订单信息"]
    assert main_sheet.cell(row=1, column=1).value == "订单号"
    assert main_sheet.cell(row=2, column=1).value == "HS9805"
    assert "操作" not in [main_sheet.cell(row=1, column=index).value for index in range(1, main_sheet.max_column + 1)]

    detail_sheet = workbook["详情信息"]
    # 三级表头：一级板块 / 二级分组（交付信息下分买号·卖号）/ 列名，数据从第 4 行起
    assert detail_sheet.cell(row=1, column=1).value == "订单标识"
    assert detail_sheet.cell(row=2, column=1).value is None
    assert detail_sheet.cell(row=3, column=1).value == "订单号"
    assert detail_sheet.cell(row=4, column=1).value == "HS9805"
    assert detail_sheet.freeze_panes == "B4"
    # 板块单元格被真合并（CSV 做不到的部分）
    merged = {str(cell_range) for cell_range in detail_sheet.merged_cells.ranges}
    assert any(cell_range.startswith("B1:") for cell_range in merged)


def test_orders_export_xlsx_splits_delivery_into_buy_and_sell_groups(seeded_client, headers, seeded_db):
    """交付字段按订单角色分落两组：DG 代挂单进卖号交付、未成交的 HS 单进买号交付。

    同一套 form_extra 字段在两类单上语义不同，拆组后每单只有其中一组有值，
    另一组整行留空 —— 比给一列「交付方向」更直观。
    """
    _seed_order(
        seeded_db,
        order_no="HS9806",
        form_extra={"bound_phone": "13800000001"},
    )
    _seed_order(
        seeded_db,
        order_no="DG9801",
        order_type="DG",
        form_extra={"bound_phone": "13800000002"},
    )

    response = seeded_client.get("/api/v1/orders/export.xlsx", headers=headers)
    workbook = openpyxl.load_workbook(io.BytesIO(response.content))
    sheet = workbook["详情信息"]

    # 二级表头（第 2 行）能定位两组
    sub_by_column = {
        index: sheet.cell(row=2, column=index).value
        for index in range(1, sheet.max_column + 1)
    }
    assert "买号交付" in sub_by_column.values()
    assert "卖号交付" in sub_by_column.values()

    labels = {
        index: sheet.cell(row=3, column=index).value
        for index in range(1, sheet.max_column + 1)
    }
    buy_phone_column = next(
        index for index, label in labels.items() if label == "买号交付-换绑手机号"
    )
    sell_phone_column = next(
        index for index, label in labels.items() if label == "卖号交付-换绑手机号"
    )
    assert sub_by_column[buy_phone_column] == "买号交付"
    assert sub_by_column[sell_phone_column] == "卖号交付"

    rows = {
        sheet.cell(row=row, column=1).value: {
            "buy": sheet.cell(row=row, column=buy_phone_column).value,
            "sell": sheet.cell(row=row, column=sell_phone_column).value,
        }
        for row in range(4, sheet.max_row + 1)
    }
    assert rows["HS9806"] == {"buy": "13800000001", "sell": None}
    assert rows["DG9801"] == {"buy": None, "sell": "13800000002"}


def test_orders_export_xlsx_splits_detail_json_into_columns(seeded_client, headers, seeded_db):
    """操作 / 资金 / 返点明细拆成独立 sheet 的列，不再塞成单个 JSON 单元格。"""
    _seed_order(seeded_db, order_no="HS9807")

    response = seeded_client.get("/api/v1/orders/export.xlsx", headers=headers)
    workbook = openpyxl.load_workbook(io.BytesIO(response.content))

    # 详情 sheet 不再承载这三类 JSON 列
    detail_labels = [
        workbook["详情信息"].cell(row=3, column=index).value
        for index in range(1, workbook["详情信息"].max_column + 1)
    ]
    for moved in ("操作明细", "资金明细", "返点明细"):
        assert moved not in detail_labels

    expected = {
        "操作明细": ["订单号", "操作分类", "动作", "平台", "动作时间", "操作人", "金额", "备注"],
        "资金明细": ["订单号", "业务类别", "方向", "金额", "时间", "状态", "操作人", "资金池", "备注"],
        "返点明细": ["订单号", "返点单号", "返点类型", "渠道", "费率(%)", "基数", "关联状态", "状态", "收到日期", "操作人", "备注"],
    }
    for title, columns in expected.items():
        sheet = workbook[title]
        header = [sheet.cell(row=1, column=index).value for index in range(1, sheet.max_column + 1)]
        assert header == columns
        # 明细 sheet 单行表头，数据从第 2 行起
        assert sheet.freeze_panes == "B2"

    # 系统内部字段不得混进业务明细表：它们在界面上看不到，导出里也没有对应用户语义
    system_only = {"事件号", "流水号", "是否过账", "现金性质", "比例", "金额归属", "portion"}
    for title in ("操作明细", "资金明细"):
        header = {
            workbook[title].cell(row=1, column=index).value
            for index in range(1, workbook[title].max_column + 1)
        }
        assert not (header & system_only), f"{title} 出现系统内部字段：{header & system_only}"


def test_event_platform_follows_unlist_scope():
    """操作明细「平台」列：普通事件用账号平台，下架事件按下架方式区分系统/平台。

    与库存视角的执行明细同口径，避免同一个人在两处看到不同的平台名。
    """
    plain = {"event_type": "BUY"}
    assert _event_platform(plain, {}, "安卓QQ区") == "安卓QQ区"

    canceled_system = {"event_type": "CANCEL"}
    assert (
        _event_platform(canceled_system, {"form_extra": {"platform_unlist_scope": "SYSTEM"}}, "安卓QQ区")
        == "本系统"
    )

    canceled_platform = {"event_type": "CANCEL"}
    detail = {"form_extra": {"platform_unlist_scope": "PLATFORM", "consignment_platform": "交易猫"}}
    assert _event_platform(canceled_platform, detail, "安卓QQ区") == "交易猫"

    # 平台下架但没填寄售平台时回落到账号平台，不留空
    assert _event_platform(canceled_platform, {"form_extra": {}}, "安卓QQ区") == "安卓QQ区"


def test_orders_export_xlsx_writes_list_export_audit(seeded_client, headers, seeded_db):
    seeded_client.get("/api/v1/orders/export.xlsx", headers=headers)
    audits = seeded_db.scalars(
        select(AuditLog).where(AuditLog.entity_type == "list_export")
    ).all()
    assert any(
        row.action == AuditAction.LIST_EXPORT.value
        and (row.after_json or {}).get("format") == "xlsx"
        for row in audits
    )


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
