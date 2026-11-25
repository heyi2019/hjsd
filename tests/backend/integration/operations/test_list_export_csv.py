"""EXPORT-01 主列表导出（/xxx/export.csv）：列配置口径 —— 可见列 + 中文表头 + 自定义列 + 值翻译。

口径：
- 导出列 = 「设置 → 列表字段」该 scope 的可见列（隐藏列不导，actions 等 UI 列不导）；
- 自定义列值从行扩展字段注入，SELECT 选项翻中文；
- 客户联系方式沿用列表原值口径；
- 每次导出写 LIST_EXPORT 审计。
"""
from __future__ import annotations

import csv
import io
from datetime import date
from decimal import Decimal

import openpyxl
import pytest
from sqlalchemy import event as sqlalchemy_event, select

from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog
from app.domain.trade import Order, OrderFormField, RebateRecord
from app.domain.users import User
from app.settings.lists.export import build_list_csv
from app.business.orders.export_fields import _delivery_export_fields, _event_platform, _order_detail_export_fields


def test_delivery_export_translates_stable_dictionary_codes():
    labels = {
        "intermediary_platform": {"intermediary_platform_01": "其他"},
        "intermediary_platform_behavior": {"intermediary_platform_01": "OTHER"},
        "intermediary_type": {"intermediary_type_01": "包赔"},
        "compensation_type": {"compensation_type_01": "首保"},
    }
    fields = _delivery_export_fields({}, labels, {
        "intermediary_platform": "intermediary_platform_01", "intermediary_platform_other": "某平台",
        "intermediary_type": "intermediary_type_01", "compensation_type": "compensation_type_01",
    })
    assert fields["detail_buy_delivery_platform"] == "其他（某平台）"
    assert fields["detail_buy_delivery_type"] == "包赔"
    assert fields["detail_buy_delivery_compensation"] == "首保"


def test_order_keeps_original_game_and_channel_labels_after_rename(seeded_client, headers, seeded_db):
    from app.business.orders.create import create_order
    from app.settings.field_definitions.game_types import create_game_type, update_game_type

    game = create_game_type(seeded_db, name="历史游戏", actor="pytest", channel_regions=[{"label": "历史渠道"}])
    channel = game.channel_regions[0]["value"]
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 1, 1), actor="pytest",
                         account_snapshot={"game_account": "history-label-test", "game_type": game.value,
                                           "channel_region": channel})
    assert order.account_snapshot.get("game_type_label") == "历史游戏"
    assert order.account_snapshot.get("channel_region_label") == "历史渠道"
    update_game_type(seeded_db, game.id, actor="pytest", name="新游戏名称",
                     channel_regions=[{"value": channel, "label": "新渠道名称"}])
    seeded_db.commit()
    response = seeded_client.get("/api/orders", headers=headers)
    assert response.status_code == 200, response.text
    row = next(item for item in response.json()["items"] if item["id"] == order.id)
    assert row.get("account_game_type_label") == "历史游戏"
    exported = seeded_client.get("/api/orders/export.csv", headers=headers)
    assert exported.status_code == 200, exported.text
    assert "历史游戏" in exported.text
    assert "历史渠道" in exported.text


def test_order_linked_to_existing_inventory_keeps_original_names(seeded_client, headers, seeded_db):
    from app.business.inventory.profile import create_account
    from app.business.orders.create import create_order
    from app.settings.field_definitions.game_types import create_game_type, update_game_type

    game = create_game_type(seeded_db, name="原游戏名", actor="pytest", channel_regions=[{"label": "原渠道名"}])
    channel = game.channel_regions[0]["value"]
    account = create_account(seeded_db, game_account="linked-history-test", game_type=game.value,
                             channel_region=channel, business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 1, 1), actor="pytest", account_id=account.id)
    assert order.account_snapshot["game_type_label"] == "原游戏名"
    assert order.account_snapshot["channel_region_label"] == "原渠道名"
    update_game_type(seeded_db, game.id, actor="pytest", name="新游戏名",
                     channel_regions=[{"value": channel, "label": "新渠道名"}])
    seeded_db.commit()
    exported = seeded_client.get("/api/orders/export.csv", headers=headers)
    assert exported.status_code == 200, exported.text
    assert "原游戏名" in exported.text
    assert "原渠道名" in exported.text


def test_order_keeps_original_delivery_option_labels_after_rename(seeded_client, headers, seeded_db):
    from app.business.orders.create import create_order
    from app.domain.options import OptionSet
    from app.settings.field_definitions.catalog_seed import seed_catalog
    from scripts.test_example_seed import seed_example_catalog

    seed_catalog(seeded_db, actor="pytest")
    seed_example_catalog(seeded_db)
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 1, 1), actor="pytest",
                         account_snapshot={"game_account": "history-delivery-test"},
                         form_extra={"intermediary_type": "intermediary_type_02", "business_responsible_ids": [1]})
    assert getattr(order, "option_label_snapshot", None) == {"intermediary_type": "包赔"}
    dictionary = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "INTERMEDIARY_TYPE"))
    dictionary.options = [{**item, "label": "保障交易"} if item["value"] == "intermediary_type_02" else item
                          for item in dictionary.options]
    seeded_db.commit()
    exported = seeded_client.get("/api/orders/export.csv", headers=headers)
    assert exported.status_code == 200, exported.text
    assert "包赔" in exported.text
    assert "保障交易" not in exported.text


def test_order_party_source_keeps_original_option_label(seeded_client, headers, seeded_db):
    from app.business.orders.create import create_order
    from app.customers.customer_ops.writes import create_customer
    from app.domain.options import OptionSet
    from app.settings.field_definitions.catalog_seed import seed_catalog
    from scripts.test_example_seed import seed_example_catalog

    seed_catalog(seeded_db, actor="pytest")
    seed_example_catalog(seeded_db)
    customer = create_customer(seeded_db, display_name="老客户", source="customer_source_02", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 1, 1), actor="pytest",
                         account_snapshot={"game_account": "history-source-test"},
                         form_extra={"business_responsible_ids": [1]},
                         customer_roles=[(customer.id, "SELLER")])
    dictionary = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "CUSTOMER_SOURCE"))
    dictionary.options = [{**item, "label": "新微博"} if item["value"] == "customer_source_02" else item
                          for item in dictionary.options]
    seeded_db.commit()
    listing = seeded_client.get("/api/orders", headers=headers)
    assert listing.status_code == 200, listing.text
    row = next(item for item in listing.json()["items"] if item["id"] == order.id)
    assert row["party_source"] == "customer_source_02"
    assert row["party_source_label"] == "微博"
    assert order.option_label_snapshot[f"party_source:customer:{customer.id}"] == "微博"


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
    # 导出带 UTF-8 BOM，表头首列实际是 "\ufeff行类型"；CSV 恒为单行表头
    return text.splitlines()[0].lstrip("\ufeff").split(",")


def test_orders_export_uses_chinese_visible_columns(seeded_client, headers, seeded_db):
    _seed_order(seeded_db, order_no="HS9801")
    response = seeded_client.get("/api/orders/export.csv", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    body = response.text
    assert body.startswith("\ufeff")  # BOM
    header = _headers(body)
    assert header[0] == "行类型"
    assert "订单号" in header
    assert "游戏/产品类型" in header
    assert "操作" not in header  # UI 列不导出
    assert "HS9801" in body  # 明细行带订单号


@pytest.mark.parametrize("descending", [True, False])
@pytest.mark.parametrize("extension", ["csv", "xlsx"])
def test_orders_export_follows_ledger_sort(seeded_client, headers, seeded_db, descending, extension):
    first = _seed_order(seeded_db, order_no="HS-SORT-1")
    second = _seed_order(seeded_db, order_no="HS-SORT-2")
    third = _seed_order(seeded_db, order_no="HS-SORT-3")
    first.trade_date, second.trade_date, third.trade_date = date(2026, 12, 1), date(2026, 1, 1), date(2026, 6, 1)
    seeded_db.flush()
    params = {"sort_desc": str(descending).lower()}
    listing = seeded_client.get("/api/orders", params=params, headers=headers)
    expected = [item["order_no"] for item in listing.json()["items"]]
    response = seeded_client.get(f"/api/orders/export.{extension}", params=params, headers=headers)
    assert response.status_code == 200
    if extension == "csv":
        rows = csv.DictReader(io.StringIO(response.text.lstrip("\ufeff")))
        assert [row["订单号"] for row in rows] == expected
    else:
        workbook = openpyxl.load_workbook(io.BytesIO(response.content), read_only=True)
        for title in ("主订单信息", "详情信息"):
            actual = [value for row in workbook[title].values for value in row if value in expected]
            assert actual == expected


@pytest.mark.parametrize("extension", ["csv", "xlsx"])
def test_orders_export_batches_detail_queries(seeded_client, headers, seeded_db, extension):
    _seed_order(seeded_db, order_no="HS-BATCH-0")
    statements = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        sql = " ".join(statement.lower().split())
        if sql.startswith("select") and any(f"from {name}" in sql for name in ("order_events", "cashflow", "rebate_records", "installments", "attachments", "audit_logs")):
            statements.append(sql)

    sqlalchemy_event.listen(seeded_db.get_bind(), "before_cursor_execute", capture)
    try:
        first = seeded_client.get(f"/api/orders/export.{extension}", headers=headers)
        assert first.status_code == 200, first.text
        first_count = len(statements)
        statements.clear()
        for i in range(1, 5):
            _seed_order(seeded_db, order_no=f"HS-BATCH-{i}")
        response = seeded_client.get(f"/api/orders/export.{extension}", headers=headers)
    finally:
        sqlalchemy_event.remove(seeded_db.get_bind(), "before_cursor_execute", capture)
    assert response.status_code == 200, response.text
    if extension == "csv":
        assert all(f"HS-BATCH-{i}" in response.text for i in range(5))
    else:
        values = list(openpyxl.load_workbook(io.BytesIO(response.content), read_only=True).worksheets[0].values)
        assert all(any(f"HS-BATCH-{i}" in row for row in values) for i in range(5))
    assert len(statements) <= first_count + 1


def test_orders_export_mine_only_includes_my_orders(seeded_client, headers, seeded_db):
    """「我的订单」视图导出必须走 mine 过滤，不能借导出绕过视图拿全量。

    headers = X-Dev-User: admin → id=1；入库操作人是本人，另一单的入库操作人是他人。
    """
    mine = _seed_order(seeded_db, order_no="HSMINE01", form_extra={"business_responsible_ids": [1]})
    mine.account_snapshot = {"game_type": "王者荣耀"}
    _seed_order(seeded_db, order_no="HSFOREIGN01", form_extra={"business_responsible_ids": [2]})
    other_game = _seed_order(seeded_db, order_no="HSMINE02", form_extra={"business_responsible_ids": [1]})
    other_game.account_snapshot = {"game_type": "原神"}
    seeded_db.flush()

    full = seeded_client.get("/api/orders/export.csv", headers=headers).text
    assert "HSMINE01" in full
    assert "HSFOREIGN01" in full  # 不带 mine 仍是全量

    scoped = seeded_client.get(
        "/api/orders/export.csv", headers=headers, params={"mine": True}
    ).text
    assert "HSMINE01" in scoped
    assert "HSFOREIGN01" not in scoped

    # XLSX 与 CSV 同口径
    xlsx = seeded_client.get(
        "/api/orders/export.xlsx", headers=headers, params={"mine": True}
    )
    assert xlsx.status_code == 200
    workbook = openpyxl.load_workbook(io.BytesIO(xlsx.content))
    cells = [
        str(cell.value)
        for row in workbook.worksheets[0].iter_rows()
        for cell in row
        if cell.value is not None
    ]
    assert "HSMINE01" in cells
    assert "HSFOREIGN01" not in cells

    filters = {
        "mine": True, "status": "IN_PROGRESS", "trade_date_from": "2026-01-01",
        "trade_date_to": "2026-01-01", "game_type": "王者荣耀", "inventory_operator_ids": [1],
    }
    filtered_csv = seeded_client.get("/api/orders/export.csv", headers=headers, params=filters)
    assert filtered_csv.status_code == 200, filtered_csv.text
    assert "HSMINE01" in filtered_csv.text
    assert "HSMINE02" not in filtered_csv.text
    assert "HSFOREIGN01" not in filtered_csv.text
    filtered_xlsx = seeded_client.get("/api/orders/export.xlsx", headers=headers, params=filters)
    assert filtered_xlsx.status_code == 200
    workbook = openpyxl.load_workbook(io.BytesIO(filtered_xlsx.content))
    cells = [str(cell.value) for row in workbook.worksheets[0].iter_rows() for cell in row if cell.value is not None]
    assert "HSMINE01" in cells
    assert "HSMINE02" not in cells
    assert "HSFOREIGN01" not in cells


def test_orders_export_keeps_single_row_header(seeded_client, headers, seeded_db):
    """CSV 必须单行表头：导入解析以首个非空行为表头，多行表头会让回流导入错位。"""
    _seed_order(seeded_db, order_no="HS9804")
    body = seeded_client.get("/api/orders/export.csv", headers=headers).text
    first = body.splitlines()[0].lstrip("\ufeff").split(",")

    assert first[0] == "行类型"
    assert "订单号" in first
    assert "台账信息" not in first  # 不存在分组行
    assert body.splitlines()[1].startswith("明细")  # 第二行即数据


def test_orders_export_appends_full_detail_in_the_same_csv_table(seeded_client, headers, seeded_db):
    _seed_order(seeded_db, order_no="HS9803", form_extra={"delivery_note": "已交付"})
    body = seeded_client.get("/api/orders/export.csv", headers=headers).text
    header = _headers(body)
    assert "详情" not in header
    assert "账号密码" not in header
    assert "操作明细" in header
    assert "delivery_note" in body
    assert "HS9803" in body


def test_order_detail_export_does_not_include_account_password():
    fields = _order_detail_export_fields(
        {"account_snapshot": {"game_password": "secret-password"}},
        {},
    )

    assert "detail_account_password" not in fields
    assert "secret-password" not in str(fields)


def test_installments_export_appends_full_detail_in_the_same_csv_table(seeded_client, headers):
    body = seeded_client.get("/api/installments/export.csv", headers=headers).text
    header = _headers(body)
    assert "详情" not in header
    assert "期次明细" in header
    assert "处置记录" in header


def test_orders_export_respects_hidden_column(seeded_client, headers, seeded_db):
    columns = next(
        scope
        for scope in seeded_client.get("/api/list-columns", headers=headers).json()
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
        "/api/list-columns/LEDGER", json={"items": items}, headers=headers
    ).status_code == 200

    body = seeded_client.get("/api/orders/export.csv", headers=headers).text
    header = _headers(body)
    assert "状态" not in header
    assert "订单号" in header  # 其余可见列仍在

    seeded_client.delete("/api/list-columns/LEDGER", headers=headers)


def test_orders_export_includes_custom_column_with_translated_value(
    seeded_client, headers, seeded_db
):
    _seed_select_field(seeded_db)
    _seed_order(seeded_db, order_no="HS9802", form_extra={"trade_role": "BUYER"})
    assert seeded_client.post(
        "/api/list-columns/LEDGER/custom",
        json={"field_key": "trade_role", "label": "交易角色"},
        headers=headers,
    ).status_code == 200

    body = seeded_client.get("/api/orders/export.csv", headers=headers).text
    header = _headers(body)
    assert "交易角色" in header
    assert "买家" in body  # SELECT 码值翻译成中文
    assert "BUYER" not in body.replace("trade_role", "")  # 原码不出现（除字段键外）


def test_orders_export_xlsx_has_five_sheets(seeded_client, headers, seeded_db):
    """xlsx 导出：主订单 + 详情 + 操作/资金/返点三类明细，详情表头三级且一级为真合并。"""
    order = _seed_order(seeded_db, order_no="HS9805", form_extra={"delivery_note": "已交付"})
    seeded_db.add(RebateRecord(
        rebate_no="HS9805-REB01", source_order_id=order.id, rebate_type="BUY",
        amount=Decimal("26.50"), collected_on=date(2026, 1, 2),
        created_by="tester", updated_by="tester",
    ))
    seeded_db.flush()
    response = seeded_client.get("/api/orders/export.xlsx", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )

    workbook = openpyxl.load_workbook(io.BytesIO(response.content))
    assert workbook.sheetnames == ["主订单信息", "详情信息", "操作明细", "资金明细", "返点明细"]
    rebate_sheet = workbook["返点明细"]
    rebate_headers = {rebate_sheet.cell(row=1, column=i).value: i for i in range(1, rebate_sheet.max_column + 1)}
    assert rebate_sheet.cell(row=2, column=rebate_headers["订单号"]).value == "HS9805"
    assert rebate_sheet.cell(row=2, column=rebate_headers["返点单号"]).value == "HS9805-REB01"
    assert rebate_sheet.cell(row=2, column=rebate_headers["返点类型"]).value in ("BUY", "买号返点")
    assert Decimal(str(rebate_sheet.cell(row=2, column=rebate_headers["返点金额"]).value)) == Decimal("26.50")

    main_sheet = workbook["主订单信息"]
    assert main_sheet.cell(row=1, column=1).value == "库存编号"
    assert main_sheet.cell(row=2, column=1).value is None
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
    """同一订单的买号和卖号交付分别导出，只有卖号资料的订单买号列留空。"""
    from app.settings.field_definitions.catalog_seed import seed_catalog
    from scripts.test_example_seed import seed_example_catalog

    seed_catalog(seeded_db, actor="pytest")
    seed_example_catalog(seeded_db)
    _seed_order(
        seeded_db,
        order_no="HS9806",
        form_extra={"bound_phone": "13800000001", "intermediary_platform": "intermediary_platform_06", "intermediary_platform_other": "星河平台", "delivery_responsible_ids": [1], "sell_bound_phone": "13900000003", "sell_intermediary_platform": "intermediary_platform_02", "sell_delivery_responsible_ids": [2]},
    )
    _seed_order(
        seeded_db,
        order_no="DG9801",
        order_type="DG",
        form_extra={"sell_bound_phone": "13800000002", "sell_intermediary_platform": "intermediary_platform_06", "sell_intermediary_platform_other": "分期平台"},
    )

    response = seeded_client.get("/api/orders/export.xlsx", headers=headers)
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
    buy_platform_column = next(index for index, label in labels.items() if label == "买号交付-交易平台")
    sell_platform_column = next(index for index, label in labels.items() if label == "卖号交付-交易平台")

    rows = {
        sheet.cell(row=row, column=1).value: {
            "buy": sheet.cell(row=row, column=buy_phone_column).value,
            "sell": sheet.cell(row=row, column=sell_phone_column).value,
        }
        for row in range(4, sheet.max_row + 1)
    }
    assert rows["HS9806"] == {"buy": "13800000001", "sell": "13900000003"}
    assert rows["DG9801"] == {"buy": None, "sell": "13800000002"}
    platform_rows = {sheet.cell(row=row, column=1).value: (
        sheet.cell(row=row, column=buy_platform_column).value,
        sheet.cell(row=row, column=sell_platform_column).value,
    ) for row in range(4, sheet.max_row + 1)}
    assert platform_rows["HS9806"] == ("其他（星河平台）", "盼之")
    assert platform_rows["DG9801"] == (None, "其他（分期平台）")
    responsible_columns = [next(index for index, label in labels.items() if label == f"{direction}交付-交付操作人") for direction in ("买号", "卖号")]
    first_order_row = next(row for row in range(4, sheet.max_row + 1) if sheet.cell(row=row, column=1).value == "HS9806")
    users = [seeded_db.get(User, user_id) for user_id in (1, 2)]
    assert [sheet.cell(row=first_order_row, column=column).value for column in responsible_columns] == [user.display_name or user.username for user in users]


def test_orders_export_xlsx_splits_detail_json_into_columns(seeded_client, headers, seeded_db):
    """操作 / 资金 / 返点明细拆成独立 sheet 的列，不再塞成单个 JSON 单元格。"""
    _seed_order(seeded_db, order_no="HS9807")

    response = seeded_client.get("/api/orders/export.xlsx", headers=headers)
    workbook = openpyxl.load_workbook(io.BytesIO(response.content))

    # 详情 sheet 不再承载这三类 JSON 列
    detail_labels = [
        workbook["详情信息"].cell(row=3, column=index).value
        for index in range(1, workbook["详情信息"].max_column + 1)
    ]
    for moved in ("操作明细", "资金明细", "返点明细"):
        assert moved not in detail_labels

    expected = {
        "操作明细": ["订单号", "事件号", "事件顺序", "操作分类", "动作", "运营动作", "结算方式", "交付方向", "金额归属", "资金账户编码", "冲销来源事件号", "来源类型", "来源编号", "已过账", "平台", "动作时间", "操作人", "金额", "备注", "原因", "运营详情(JSON)", "关联上架事件号"],
        "资金明细": ["订单号", "流水号", "业务类别", "业务类别编码", "方向", "金额", "时间", "操作人", "资金账户", "资金账户编码", "核算属性", "来源类型", "来源编号", "备注"],
        "返点明细": ["订单号", "返点单号", "返点类型", "渠道", "返点金额", "收到日期", "资金账户编码", "操作人", "备注"],
    }
    for title, columns in expected.items():
        sheet = workbook[title]
        header = [sheet.cell(row=1, column=index).value for index in range(1, sheet.max_column + 1)]
        assert header == columns
        # 明细 sheet 单行表头，数据从第 2 行起
        assert sheet.freeze_panes == "B2"

    # 事件号与流水号用于回流去重和来源关联；无导入用途的内部字段仍不输出。
    system_only = {"是否过账", "比例", "portion"}
    for title in ("操作明细", "资金明细"):
        header = {
            workbook[title].cell(row=1, column=index).value
            for index in range(1, workbook[title].max_column + 1)
        }
        assert not (header & system_only), f"{title} 出现系统内部字段：{header & system_only}"


def test_event_platform_follows_unlist_scope():
    """操作明细「平台」列是寄售平台口径：普通事件记「-」，下架事件按下架方式区分系统/平台。

    账号自身平台概念已删除；寄售平台缺数据时记「-」，与库存执行明细同口径。
    """
    plain = {"event_type": "BUY"}
    assert _event_platform(plain, {}) == "-"

    canceled_system = {"event_type": "CANCEL"}
    assert (
        _event_platform(canceled_system, {"form_extra": {"platform_unlist_scope": "SYSTEM"}})
        == "本系统"
    )

    canceled_platform = {"event_type": "CANCEL"}
    detail = {"form_extra": {"platform_unlist_scope": "PLATFORM", "consignment_platforms": ["交易猫"]}}
    assert _event_platform(canceled_platform, detail) == "交易猫"

    # 平台下架但没填寄售平台时记「-」，不留空
    assert _event_platform(canceled_platform, {"form_extra": {}}) == "-"


def test_orders_export_xlsx_writes_list_export_audit(seeded_client, headers, seeded_db):
    seeded_client.get("/api/orders/export.xlsx", headers=headers)
    audits = seeded_db.scalars(
        select(AuditLog).where(AuditLog.entity_type == "list_export")
    ).all()
    assert any(
        row.action == AuditAction.LIST_EXPORT.value
        and (row.after_json or {}).get("format") == "xlsx"
        for row in audits
    )


def test_customers_export_returns_full_contact(seeded_client, headers, seeded_db):
    created = seeded_client.post(
        "/api/customers",
        json={"display_name": "导出客户甲", "phone": "13800001111"},
        headers=headers,
    )
    assert created.status_code == 201, created.text

    admin_body = seeded_client.get("/api/customers/export.csv", headers=headers).text
    assert "13800001111" in admin_body



def test_cashflows_export_chinese_header(seeded_client, headers, seeded_db):
    response = seeded_client.get("/api/cashflows/export.csv", headers=headers)
    assert response.status_code == 200, response.text
    header = _headers(response.text)
    assert header[0] == "行类型"


def test_rebates_export_csv_route_is_retired(app, seeded_client, headers):
    assert "/api/rebates/export.csv" not in app.openapi()["paths"]
    assert "/api/rebates" in app.openapi()["paths"]
    assert "/api/rebates/{rebate_id}" in app.openapi()["paths"]
    response = seeded_client.get("/api/rebates/export.csv", headers=headers)
    assert response.status_code in (404, 422)


def test_export_writes_list_export_audit(seeded_client, headers, seeded_db):
    seeded_client.get("/api/orders/export.csv", headers=headers)
    actions = [
        row.action
        for row in seeded_db.scalars(
            select(AuditLog).where(AuditLog.entity_type == "list_export")
        ).all()
    ]
    assert AuditAction.LIST_EXPORT.value in actions


# 主列表导出上限与截断口径

def test_build_list_csv_does_not_truncate_rows(seeded_db):
    rows = [{"row_type": "明细", "title": f"第{i}行"} for i in range(10001)]
    csv_text, meta = build_list_csv(seeded_db, "CUSTOMER", rows)
    assert meta["row_count"] == 10001
    assert meta["truncated"] is False
    assert len([line for line in csv_text.splitlines() if line.strip()]) - 1 == 10001

def test_build_list_csv_under_limit_not_truncated(seeded_db):
    rows = [{"row_type": "明细", "title": "甲"}, {"row_type": "明细", "title": "乙"}]
    _csv_text, meta = build_list_csv(seeded_db, "CUSTOMER", rows)
    assert meta["row_count"] == 2
    assert meta["truncated"] is False

def test_order_exports_have_no_total_limit(seeded_client, headers, monkeypatch):
    from app.business.orders.queries import list_orders
    seen = []
    def spy(db, **kwargs):
        seen.append(kwargs.get("limit"))
        return list_orders(db, **kwargs)
    monkeypatch.setattr("app.business.orders.export_router.orders_list_orders", spy)
    for suffix in ("csv", "xlsx"):
        response = seeded_client.get(f"/api/orders/export.{suffix}", headers=headers)
        assert response.status_code == 200, response.text
    assert seen == [None, None]


def test_stocks_export_has_no_total_limit(seeded_client, headers, monkeypatch):
    """库存导出不截断结果。"""
    from app.business.inventory.inventory import list_accounts

    seen: dict[str, object] = {}
    original = list_accounts

    def spy(db, **kwargs):
        seen.update(kwargs)
        return original(db, **kwargs)

    monkeypatch.setattr("app.business.inventory.router.query_inventory_accounts", spy)
    resp = seeded_client.get("/api/stocks/export.csv", headers=headers)
    assert resp.status_code == 200, resp.text
    assert "limit" in seen and seen["limit"] is None

def test_customers_export_has_no_total_limit(seeded_client, headers, monkeypatch):
    """客户导出不截断结果。"""
    from app.customers.customers import list_customers

    seen: dict[str, object] = {}
    original = list_customers

    def spy(db, **kwargs):
        seen.update(kwargs)
        return original(db, **kwargs)

    monkeypatch.setattr("app.customers.customers_router.parties_list_customers", spy)
    resp = seeded_client.get("/api/customers/export.csv", headers=headers)
    assert resp.status_code == 200, resp.text
    assert "limit" in seen and seen["limit"] is None

def test_stocks_export_audit_records_row_count_and_truncated(
    seeded_client, headers, seeded_db
):
    seeded_client.get("/api/stocks/export.csv", headers=headers)
    audit = seeded_db.scalars(
        select(AuditLog)
        .where(
            AuditLog.entity_type == "list_export",
            AuditLog.entity_id == "INVENTORY",
        )
        .order_by(AuditLog.id.desc())
    ).first()
    assert audit is not None
    after = audit.after_json or {}
    assert "rows" in after
    assert after["truncated"] is False

def test_installments_export_all_query_params_explicitly_none(seeded_client, headers):
    """分期导出直接调用列表路由函数：每个 Query(default=None) 参数都须显式传 None。

    此前漏传 contract_type，Query(None) 对象被透传进 SQL 触发 psycopg 适配 500。
    本用例锁定「无筛选导出应正常返回」契约。
    """
    resp = seeded_client.get("/api/installments/export.csv", headers=headers)
    assert resp.status_code == 200, resp.text
