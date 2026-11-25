"""ORDERIMPORT-01 订单导入模板与预检：兼容台账导出且不得凭汇总值虚构资金流水。"""
from __future__ import annotations

from io import BytesIO

import pytest
from openpyxl import Workbook, load_workbook

from app.business.orders.importing import parser
from app.business.orders.importing.parser import parse_order_import
from app.business.orders.importing.template import build_order_import_template
from app.core.errors import Validation


def test_imports_and_updates_configured_order_columns_with_typed_values(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.foundation import AuditLog
    from app.domain.lists import ListCustomColumn
    from app.domain.trade import Order, OrderFormField

    for key, label, kind, options, section in (
        ("priority_note", "备注级别", "TEXT", [], "BUSINESS"),
        ("priority_level", "优先等级", "SELECT", [{"value": "HIGH", "label": "高"}, {"value": "LOW", "label": "低"}], "BUSINESS"),
        ("account_tag", "账号标签", "TEXT", [], "ACCOUNT_PRODUCT"),
    ):
        seeded_db.add(OrderFormField(order_type_code="DG", field_key=key, label=label,
                                     field_type=kind, options=options, section=section,
                                     is_custom=True, is_active=True, required=False, sort_order=950))
        seeded_db.add(ListCustomColumn(scope="LEDGER", column_key=f"extra:{key}", source_key=key,
                                      label=label, field_type=kind,
                                      value_labels={item["value"]: item["label"] for item in options}))
    seeded_db.commit()

    def submit(choice, note, level):
        content = f"订单号,业务日期,业务类型,游戏账号/产品,备注级别,优先等级,账号标签\nDG0950,2026-10-17,代挂,历史账号,{note},{level},账号历史标签\n".encode()
        return seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": choice},
                                  files={"file": ("订单.csv", content, "text/csv")})

    created = submit("skip", "普通", "高")
    assert created.status_code == 200, created.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0950"))
    seeded_db.refresh(order)
    assert order.form_extra["priority_note"] == "普通"
    assert order.form_extra["priority_level"] == "HIGH"
    fetched = seeded_client.get(f"/api/orders/{order.id}", headers=headers)
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["form_extra"]["priority_level"] == "HIGH"
    assert fetched.json()["account_snapshot"]["extra_values"]["account_tag"] == "账号历史标签"

    updated = submit("update", "已复核", "低")
    assert updated.status_code == 200, updated.text
    seeded_db.refresh(order)
    assert order.form_extra["priority_note"] == "已复核"
    assert order.form_extra["priority_level"] == "LOW"
    listed = seeded_client.get("/api/orders", headers=headers, params={"keyword": "DG0950"})
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["extra_values"]["account_tag"] == "账号历史标签"
    for extension in ("csv", "xlsx"):
        exported = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": "DG0950"})
        assert exported.status_code == 200, exported.text
        table = parse_order_import(f"订单.{extension}", exported.content)["main"]
        row = dict(zip(table.headers, table.rows[0].values))
        assert row["账号标签"] == "账号历史标签"
        assert row["优先等级"] == "低"
    audit = seeded_db.scalar(select(AuditLog).where(AuditLog.entity_type == "order", AuditLog.entity_id == order.order_no,
                                                    AuditLog.action == "ORDER_UPDATE").order_by(AuditLog.id.desc()))
    assert audit.before_json["form_extra"] == {"priority_note": "普通", "priority_level": "HIGH"}
    assert audit.after_json["form_extra"] == {"priority_note": "已复核", "priority_level": "LOW"}


def test_ledger_custom_account_field_uses_current_inventory_value(seeded_client, seeded_db, headers):
    from datetime import date
    from app.business.orders.create import create_order
    from app.domain.lists import ListCustomColumn
    from app.domain.trade import Account, OrderFormField

    seeded_db.add(OrderFormField(order_type_code="DG", field_key="account_tag", label="账号标签",
                                 field_type="TEXT", options=[], section="ACCOUNT_PRODUCT",
                                 is_custom=True, is_active=True, required=False, sort_order=950))
    seeded_db.add(ListCustomColumn(scope="LEDGER", column_key="extra:account_tag", source_key="account_tag",
                                  label="账号标签", field_type="TEXT"))
    seeded_db.flush()
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                         account_snapshot={"game_account": "库存自定义字段", "extra_values": {"account_tag": "旧标签"}})
    account = seeded_db.get(Account, order.account_id)
    account.form_extra = {"account_tag": "库存当前标签"}
    seeded_db.commit()

    listed = seeded_client.get("/api/orders", headers=headers, params={"keyword": order.order_no})
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["extra_values"]["account_tag"] == "库存当前标签"
    inventory = seeded_client.get("/api/stocks/inventory/ledger", headers=headers, params={"keyword": "库存自定义字段", "include_images": False})
    assert inventory.status_code == 200, inventory.text
    assert inventory.json()["items"][0]["order"]["extra_values"]["account_tag"] == "库存当前标签"
    exported = seeded_client.get("/api/orders/export.csv", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text
    table = parse_order_import("订单.csv", exported.content)["main"]
    assert dict(zip(table.headers, table.rows[0].values))["账号标签"] == "库存当前标签"


@pytest.mark.parametrize(("kind", "raw", "expected"), [
    ("TEXT", "  保留空格  ", "  保留空格  "),
    ("NUMBER", "120.0", 120),
    ("BOOLEAN", "否", False),
    ("DATE", "2026-10-17 11:30:00", "2026-10-17"),
    ("MULTI_SELECT", '["HIGH","LOW"]', ["HIGH", "LOW"]),
])
def test_custom_column_values_follow_the_field_type(kind, raw, expected):
    from types import SimpleNamespace
    from app.business.orders.importing.custom_columns import read_custom_order_values

    definition = SimpleNamespace(field_type=kind, field_key="field", label="字段", section="BUSINESS",
                                 options=[{"value": "HIGH"}, {"value": "LOW"}])
    column = SimpleNamespace(source_key="field", value_labels={"HIGH": "高", "LOW": "低"})
    result, account_fields = read_custom_order_values({"字段": raw}, "DG", {("DG", "字段"): (column, definition)})
    assert result == {"field": expected}
    assert not account_fields


def test_custom_column_rejects_ambiguous_options_and_lossy_numbers():
    from types import SimpleNamespace
    from app.business.orders.importing.custom_columns import read_custom_order_values

    definition = SimpleNamespace(field_type="SELECT", field_key="field", label="字段", section="BUSINESS", options=[])
    column = SimpleNamespace(source_key="field", value_labels={"A": "相同", "B": "相同"})
    with pytest.raises(Validation, match="不唯一"):
        read_custom_order_values({"字段": "相同"}, "DG", {("DG", "字段"): (column, definition)})
    definition.field_type = "NUMBER"
    with pytest.raises(Validation, match="无法无损"):
        read_custom_order_values({"字段": "0.1"}, "DG", {("DG", "字段"): (column, definition)})
    with pytest.raises(Validation, match="重名"):
        read_custom_order_values({"业务类型": "代挂"}, "DG", {("DG", "业务类型"): None})


def test_readonly_detail_json_compares_values_and_types():
    from app.business.orders.importing.detail_reference import same_readonly_detail

    assert same_readonly_detail('{"a": 1, "b": [true]}', '{"b":[true],"a":1}')
    assert not same_readonly_detail('{"a": true}', '{"a":1}')
    assert not same_readonly_detail('{"a": 1}', '{"a":1.0}')


def test_detail_reference_respects_order_scope_and_audit_permission(seeded_db):
    import json
    from datetime import date
    from app.business.orders.create import create_order
    from app.business.orders.importing.detail_reference import detail_reference_values
    from app.core.security import CurrentUser

    own = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest", owner_id=1)
    other = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest", owner_id=2)
    limited = CurrentUser.build(id=1, username="seeduser1", roles=["OPERATOR"], owner_scope="SELF")
    admin = CurrentUser.build(id=17, username="admin", roles=["ADMIN"], owner_scope="ALL")
    references = detail_reference_values(seeded_db, {own.order_no, other.order_no}, limited, workbook=True)
    assert set(references) == {own.order_no}
    assert json.loads(references[own.order_no]["审计记录"]) == []
    admin_reference = detail_reference_values(seeded_db, {own.order_no}, admin, workbook=True)
    assert json.loads(admin_reference[own.order_no]["审计记录"])


def test_preview_rejects_ambiguous_custom_column_names(seeded_client, seeded_db, headers):
    from app.domain.lists import ListCustomColumn
    from app.domain.trade import OrderFormField

    for key in ("first_flag", "second_flag"):
        seeded_db.add(OrderFormField(order_type_code="DG", field_key=key, label="标记", field_type="TEXT",
                                     section="BUSINESS", is_custom=True, is_active=True, required=False, sort_order=950))
        seeded_db.add(ListCustomColumn(scope="LEDGER", column_key=f"extra:{key}", source_key=key,
                                      label="标记", field_type="TEXT"))
    seeded_db.commit()
    content = "订单号,业务日期,业务类型,标记\nDG0953,2026-10-17,代挂,待核对\n".encode()
    response = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"},
                                  files={"file": ("订单.csv", content, "text/csv")})
    assert response.status_code == 200, response.text
    assert any("重名" in error for error in response.json()["rows"][0]["errors"])


def test_parse_csv_uses_visible_export_columns_and_restores_escaped_text():
    content = "\ufeff订单号,入库时间,业务类型,游戏账号/产品,成本\r\nHS0001,2026-10-17,回收,'=example,100.00\r\n".encode()
    result = parse_order_import("订单.csv", content)
    assert result["main"].headers == ("订单号", "入库时间", "业务类型", "游戏账号/产品", "成本")
    assert result["main"].rows[0].row == 2
    assert result["main"].rows[0].values == ("HS0001", "2026-10-17", "回收", "=example", "100.00")


def test_parse_xlsx_reads_export_sheets_and_three_row_detail_header():
    workbook = Workbook()
    main = workbook.active
    main.title = "主订单信息"
    main.append(["订单号", "业务类型"])
    main.append(["HS0001", "回收"])
    detail = workbook.create_sheet("详情信息")
    detail.append(["订单标识", "订单信息"])
    detail.append([None, None])
    detail.append(["订单号", "订单备注"])
    detail.append(["HS0001", "历史备注"])
    events = workbook.create_sheet("操作明细")
    events.append(["订单号", "动作", "金额"])
    events.append(["HS0001", "买号", 100])
    continued = workbook.create_sheet("操作明细（10）")
    continued.append(["订单号", "动作", "金额"])
    continued.append(["HS0002", "售出", 200])
    output = BytesIO()
    workbook.save(output)
    result = parse_order_import("订单.xlsx", output.getvalue())
    assert result["main"].rows[0].values == ("HS0001", "回收")
    assert result["details"].headers == ("订单号", "订单备注")
    assert result["events"].rows[0].values == ("HS0001", "买号", "100")
    assert result["events"].rows[1].sheet == "操作明细（10）"
    assert result["events"].rows[1].values == ("HS0002", "售出", "200")


def test_parse_rejects_duplicate_headers_and_formula_cells():
    with pytest.raises(Validation, match="重复列名"):
        parse_order_import("订单.csv", "订单号,订单号\nHS0001,HS0002\n".encode())
    workbook = Workbook()
    workbook.active.title = "主订单信息"
    workbook.active.append(["订单号"])
    workbook.active.append(["=1+1"])
    output = BytesIO()
    workbook.save(output)
    with pytest.raises(Validation, match="公式"):
        parse_order_import("订单.xlsx", output.getvalue())


def test_parse_rejects_unsupported_or_excessively_large_files():
    with pytest.raises(Validation, match="格式"):
        parse_order_import("订单.txt", b"no")
    with pytest.raises(Validation, match="过大"):
        parse_order_import("订单.csv", b"x" * (10 * 1024 * 1024 + 1))


def test_csv_line_numbers_and_row_limit_include_multiline_fields(monkeypatch):
    content = '订单号,备注\nHS0001,"第一行\n第二行"\nHS0002,其他\n'.encode()
    result = parse_order_import("订单.csv", content)
    assert [row.row for row in result["main"].rows] == [2, 4]
    monkeypatch.setattr(parser, "MAX_ROWS", 1)
    with pytest.raises(Validation, match="行数过多"):
        parse_order_import("订单.csv", content)


def test_template_dropdowns_use_supported_values_and_current_authorized_pools(seeded_client, seeded_db, headers):
    from app.domain.foundation import Pool

    seeded_db.add(Pool(code="TEMPLATE_POOL", name="模板测试账户", pool_type="OTHER", status="ACTIVE"))
    seeded_db.commit()
    response = seeded_client.get("/api/order-imports/template.xlsx", params=[("sections", "events"), ("sections", "cashflows"), ("sections", "rebates")], headers=headers)
    assert response.status_code == 200
    workbook = load_workbook(BytesIO(response.content))
    assert workbook["下拉选项"].sheet_state == "hidden"
    for sheet, label, expected in [("主订单信息", "业务类型", "回收"), ("资金明细", "资金账户编码", "TEMPLATE_POOL"), ("返点明细", "返点类型", "买号返点"), ("操作明细", "动作", "运营")]:
        ws = workbook[sheet]
        index = next(cell.column for cell in ws[1] if cell.value == label)
        cell = ws.cell(row=2, column=index)
        validation = next(rule for rule in ws.data_validations.dataValidation if cell.coordinate in rule.sqref)
        reference = workbook.defined_names[validation.formula1].attr_text
        assert reference.startswith("'下拉选项'!")
        assert expected in [item.value for row in workbook["下拉选项"][reference.split("!")[1].replace("$", "")] for item in row]
    assert parse_order_import("模板.xlsx", response.content)["main"].rows == ()


def test_template_includes_visible_columns_required_identifiers_and_selected_details():
    columns = [
        {"key": "order_no", "label": "订单号", "is_visible": False},
        {"key": "cost_amount", "label": "成本", "is_visible": True},
        {"key": "account_game_type", "label": "游戏/产品类型", "is_visible": False},
        {"key": "actions", "label": "操作", "is_visible": True},
    ]
    content = build_order_import_template(columns, {"details", "events", "cashflows", "rebates"}, custom_choices={"成本": ["示例选项"]})
    workbook = load_workbook(BytesIO(content))
    assert workbook.sheetnames == ["主订单信息", "详情信息", "操作明细", "资金明细", "返点明细", "填写说明", "下拉选项"]
    headers = [cell.value for cell in workbook["主订单信息"][1]]
    assert headers == ["订单号", "业务日期", "业务类型", "业务操作人", "成本"]
    assert workbook["主订单信息"].max_row == 1
    secondary_col = next(cell.column for cell in workbook["详情信息"][3] if cell.value == "有无二次")
    assert any(workbook["详情信息"].cell(4, secondary_col).coordinate in rule.sqref for rule in workbook["详情信息"].data_validations.dataValidation)
    assert any(workbook["主订单信息"].cell(2, 5).coordinate in rule.sqref for rule in workbook["主订单信息"].data_validations.dataValidation)
    assert "订单号" in [cell.value for cell in workbook["操作明细"][1]]
    assert {"事件号", "运营动作", "运营详情(JSON)", "关联上架事件号"}.issubset({cell.value for cell in workbook["操作明细"][1]})
    assert "返点单号" in [cell.value for cell in workbook["返点明细"][1]]
    assert "资金账户编码" in [cell.value for cell in workbook["返点明细"][1]]
    assert {"流水号", "核算属性", "来源类型", "资金账户编码"}.issubset({cell.value for cell in workbook["资金明细"][1]})
    assert any("示例" in str(row[0]) for row in workbook["填写说明"].values if row[0] is not None)
    assert parse_order_import("模板.xlsx", content)["main"].headers == tuple(headers)


def test_template_and_preview_api_are_read_only_and_follow_duplicate_choice(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import func, select
    from app.business.orders.create import create_order
    from app.domain.trade import Order

    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest")
    seeded_db.commit()
    template = seeded_client.get("/api/order-imports/template.xlsx", params=[("sections", "events"), ("sections", "rebates")], headers=headers)
    assert template.status_code == 200, template.text
    assert load_workbook(BytesIO(template.content)).sheetnames == ["主订单信息", "操作明细", "返点明细", "填写说明", "下拉选项"]
    content = f"订单号,业务日期,业务类型,成本\n{order.order_no},2026-10-17,回收,100\nHS9998,2026-10-18,回收,200\n".encode()
    count = seeded_db.scalar(select(func.count()).select_from(Order))
    for choice, expected in (("skip", "skip"), ("update", "update")):
        preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": choice}, files={"file": ("订单.csv", content, "text/csv")})
        assert preview.status_code == 200, preview.text
        body = preview.json()
        assert [(row["order_no"], row["action"]) for row in body["rows"]] == [(order.order_no, expected if choice == "skip" else "error"), ("HS9998", "error")]
        assert any("成本" in warning for warning in body["rows"][1]["warnings"])
        assert any("成本" in error for error in body["rows"][1]["errors"])
        assert seeded_db.scalar(select(func.count()).select_from(Order)) == count


def test_preview_reports_missing_business_date_and_denies_read_only_user(seeded_client, headers):
    content = "订单号,入库时间,业务类型\nHS9998,2026-10-17,回收\n".encode()
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"}, files={"file": ("订单.csv", content, "text/csv")})
    assert preview.status_code == 200, preview.text
    row = preview.json()["rows"][0]
    assert row["action"] == "error" and any("业务日期" in error for error in row["errors"])
    denied = seeded_client.post("/api/order-imports/preview", headers={"X-Dev-User": "viewer"}, data={"existing": "skip"}, files={"file": ("订单.csv", content, "text/csv")})
    assert denied.status_code == 403


def test_preview_finds_duplicate_orders_invalid_dates_and_orphan_detail_rows(seeded_client, headers):
    workbook = Workbook()
    main = workbook.active
    main.title = "主订单信息"
    main.append(["订单号", "业务日期", "业务类型"])
    main.append(["HS0001", "2026-10-17", "回收"])
    main.append(["HS0001", "2026-10-17", "回收"])
    main.append(["TH0010", "2026-10-17oops", "代挂"])
    events = workbook.create_sheet("操作明细")
    events.append(["订单号", "动作"])
    events.append(["DG0009", "上架"])
    output = BytesIO()
    workbook.save(output)
    result = seeded_client.post(
        "/api/order-imports/preview", headers=headers,
        data={"existing": "skip", "sections": "events"},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert result.status_code == 200, result.text
    body = result.json()
    assert all(row["action"] == "error" for row in body["rows"])
    assert "重复" in body["rows"][0]["errors"][0]
    assert any("业务日期" in error for error in body["rows"][2]["errors"])
    assert any("业务类型" in error for error in body["rows"][2]["errors"])
    assert body["detail_errors"][0]["sheet"] == "操作明细"
    assert "主订单" in body["detail_errors"][0]["message"]


def test_preview_rejects_selected_detail_without_corresponding_data(seeded_client, headers):
    content = "订单号,业务日期,业务类型\nHS9998,2026-10-17,回收\n".encode()
    result = seeded_client.post(
        "/api/order-imports/preview", headers=headers,
        data={"existing": "skip", "sections": "rebates"},
        files={"file": ("订单.csv", content, "text/csv")},
    )
    assert result.status_code == 200, result.text
    assert "返点" in result.json()["detail_errors"][0]["message"]


def test_preview_reports_unsupported_detail_and_event_before_any_write(seeded_client, seeded_db, headers):
    from sqlalchemy import func, select
    from app.domain.trade import Order
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "业务日期", "业务类型"])
    main.append(["DG0987", "2026-10-17", "代挂"])
    detail = book.create_sheet("详情信息")
    detail.append(["订单标识", "账号详情"])
    detail.append([None, None])
    detail.append(["订单号", "账号图片"])
    detail.append(["DG0987", "2张"])
    event = book.create_sheet("操作明细")
    event.append(["订单号", "事件号", "动作"])
    event.append(["DG0987", "DG0987-EV-UNKNOWN-01", "未知动作"])
    output = BytesIO()
    book.save(output)
    before = seeded_db.scalar(select(func.count()).select_from(Order))
    response = seeded_client.post("/api/order-imports/preview", headers=headers,
        data={"existing": "skip", "sections": ["details", "events"]},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 200, response.text
    errors = response.json()["detail_errors"]
    assert any("账号图片" in error["message"] for error in errors)
    assert any("操作类型" in error["message"] for error in errors)
    assert seeded_db.scalar(select(func.count()).select_from(Order)) == before


def test_import_preserves_required_business_operator_instead_of_guessing(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order, OrderFormField
    from app.domain.users import User
    from app.settings.field_definitions.catalog_seed import seed_business_responsible_fields
    seed_business_responsible_fields(seeded_db, actor="pytest")
    seeded_db.flush()
    field = seeded_db.scalar(select(OrderFormField).where(OrderFormField.order_type_code == "DG",
                                                          OrderFormField.field_key == "business_responsible_ids"))
    field.is_active = True
    field.required = True
    user = seeded_db.scalar(select(User).where(User.username == "admin"))
    seeded_db.commit()
    def submit(path, operator):
        content = f"订单号,业务日期,业务类型,业务操作人\nDG0982,2026-10-17,代挂,{operator}\n".encode()
        return seeded_client.post(f"/api/order-imports/{path}", headers=headers, data={"existing": "skip"},
                                  files={"file": ("订单.csv", content, "text/csv")})
    missing = submit("preview", "")
    assert missing.status_code == 200
    assert any("操作人" in error for error in missing.json()["rows"][0]["errors"])
    response = submit("execute", user.username)
    assert response.status_code == 200, response.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0982"))
    assert order.form_extra["business_responsible_ids"] == [user.id]


def test_unbound_order_export_keeps_business_operator_when_inventory_operator_is_visible(seeded_client, seeded_db, headers):
    import csv
    from io import StringIO
    from sqlalchemy import select
    from app.domain.trade import OrderFormField
    from app.domain.users import User
    from app.settings.field_definitions.catalog_seed import seed_business_responsible_fields

    seed_business_responsible_fields(seeded_db, actor="pytest")
    seeded_db.flush()
    field = seeded_db.scalar(select(OrderFormField).where(OrderFormField.order_type_code == "DG",
                                                          OrderFormField.field_key == "business_responsible_ids"))
    field.is_active = True
    field.required = True
    user = seeded_db.scalar(select(User).where(User.username == "admin"))
    seeded_db.commit()
    content = f"订单号,业务日期,业务类型,业务操作人\nDG0951,2026-10-17,代挂,{user.username}\n".encode()
    created = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                 files={"file": ("订单.csv", content, "text/csv")})
    assert created.status_code == 200, created.text

    exported = seeded_client.get("/api/orders/export.csv", headers=headers, params={"keyword": "DG0951"})
    assert exported.status_code == 200, exported.text
    row = next(csv.DictReader(StringIO(exported.content.decode("utf-8-sig"))))
    assert row["入库操作人"] == ""
    assert row["业务操作人"] in {user.username, user.display_name}
    xlsx = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": "DG0951"})
    assert xlsx.status_code == 200, xlsx.text
    workbook = load_workbook(BytesIO(xlsx.content), read_only=True)
    values = list(workbook["主订单信息"].values)
    assert values[1][values[0].index("业务操作人")] in {user.username, user.display_name}


def test_exported_ledger_updates_existing_order_without_rewriting_derived_columns(seeded_client, seeded_db, headers):
    import csv
    from datetime import date
    from io import StringIO
    from sqlalchemy import func, select
    from app.business.inventory.profile import update_account_profile
    from app.business.orders.create import create_order
    from app.domain.trade import Cashflow, OrderEvent

    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                         account_snapshot={"game_account": "台账回流", "game_type": "手游"})
    update_account_profile(seeded_db, order.account_id, actor="pytest", game_account="已更新账号")
    seeded_db.commit()
    exported = seeded_client.get("/api/orders/export.csv", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text

    def submit(path, content):
        return seeded_client.post(f"/api/order-imports/{path}", headers=headers, data={"existing": "update"},
                                  files={"file": ("订单.csv", content, "text/csv")})

    before_flows = seeded_db.scalar(select(func.count()).select_from(Cashflow))
    before_events = seeded_db.scalar(select(func.count()).select_from(OrderEvent))
    preview = submit("preview", exported.content)
    assert preview.status_code == 200, preview.text
    assert preview.json()["rows"][0]["action"] == "update", preview.json()
    updated = submit("execute", exported.content)
    assert updated.status_code == 200, updated.text
    assert seeded_db.scalar(select(func.count()).select_from(Cashflow)) == before_flows
    assert seeded_db.scalar(select(func.count()).select_from(OrderEvent)) == before_events
    xlsx = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": order.order_no})
    assert xlsx.status_code == 200, xlsx.text
    xlsx_preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "update"},
                                      files={"file": ("订单.xlsx", xlsx.content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert xlsx_preview.status_code == 200, xlsx_preview.text
    assert xlsx_preview.json()["rows"][0]["action"] == "update", xlsx_preview.json()

    reader = csv.DictReader(StringIO(exported.content.decode("utf-8-sig")))
    row = next(reader)
    row["成本"] = "999.00"
    out = StringIO(newline="")
    writer = csv.DictWriter(out, fieldnames=reader.fieldnames)
    writer.writeheader()
    writer.writerow(row)
    mismatch = submit("preview", out.getvalue().encode())
    assert mismatch.status_code == 200, mismatch.text
    assert any("成本" in error for error in mismatch.json()["rows"][0]["errors"])


@pytest.mark.parametrize("extension", ["csv", "xlsx"])
def test_exported_dictionary_labels_can_round_trip_into_existing_order(seeded_client, seeded_db, headers, extension):
    from datetime import date
    from app.business.orders.create import create_order
    from app.settings.field_definitions.game_types import create_game_type, update_game_type

    game = create_game_type(seeded_db, name="原游戏", channel_regions=[{"label": "原渠道"}], actor="pytest")
    channel = game.channel_regions[0]["value"]
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                         account_snapshot={"game_account": "编码回流", "game_type": game.value, "channel_region": channel})
    update_game_type(seeded_db, game.id, name="现游戏", channel_regions=[{"value": channel, "label": "现渠道"}], actor="pytest")
    seeded_db.commit()
    exported = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text
    mime = "text/csv" if extension == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    data = {"existing": "update", "sections": "details"}
    files = {"file": (f"订单.{extension}", exported.content, mime)}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data=data, files=files)
    assert preview.status_code == 200, preview.text
    assert preview.json()["detail_errors"] == []
    assert preview.json()["rows"][0]["action"] == "update"
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data=data, files=files)
    assert result.status_code == 200, result.text
    seeded_db.refresh(order)
    assert order.account_snapshot["game_type"] == game.value
    assert order.account_snapshot["channel_region"] == channel
    assert order.account_snapshot["game_type_label"] == "原游戏"


def test_new_order_import_resolves_game_and_channel_labels_to_codes(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order
    from app.settings.field_definitions.game_types import create_game_type

    game = create_game_type(seeded_db, name="导入游戏", channel_regions=[{"label": "安卓一区"}], actor="pytest")
    content = ("订单号,业务日期,业务类型,游戏账号/产品,游戏/产品类型,渠道 / 区服\n"
               "DG0955,2026-10-17,代挂,导入账号,导入游戏,安卓一区\n").encode()
    result = seeded_client.post("/api/order-imports/execute", headers=headers,
                                data={"existing": "skip", "sections": "details"},
                                files={"file": ("订单.csv", content, "text/csv")})
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0955"))
    assert order.account_snapshot["game_type"] == game.value
    assert order.account_snapshot["channel_region"] == game.channel_regions[0]["value"]
    assert order.account_snapshot["game_type_label"] == "导入游戏"
    assert order.account_snapshot["channel_region_label"] == "安卓一区"


def test_new_order_import_preview_rejects_unconfigured_game(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order

    content = ("订单号,业务日期,业务类型,游戏账号/产品,游戏/产品类型\n"
               "DG0956,2026-10-17,代挂,导入账号,未配置游戏\n").encode()
    files = {"file": ("订单.csv", content, "text/csv")}
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip"}, files=files)
    assert preview.status_code == 200, preview.text
    assert preview.json()["rows"][0]["action"] == "error"
    assert any("游戏类型" in error for error in preview.json()["rows"][0]["errors"])
    result = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"}, files=files)
    assert result.status_code == 422
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "DG0956")) is None


@pytest.mark.parametrize("extension", ["csv", "xlsx"])
def test_order_export_uses_current_linked_account_details(seeded_client, seeded_db, headers, extension):
    from datetime import date
    from app.business.inventory.profile import update_account_profile
    from app.business.orders.create import create_order

    order = create_order(
        seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
        account_snapshot={"game_account": "导出账号", "channel_region": "旧区", "bound_phone": "旧手机号", "has_secondary": True},
    )
    update_account_profile(
        seeded_db, order.account_id, actor="pytest", channel_region="新区", bound_phone=None,
        has_secondary=False, account_description="最新账号描述",
        account_images=["data:image/png;base64,one", "data:image/png;base64,two"],
    )
    seeded_db.commit()

    response = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": order.order_no})
    assert response.status_code == 200, response.text
    tables = parse_order_import(f"订单.{extension}", response.content)
    table = tables["details"] if extension == "xlsx" else tables["main"]
    row = dict(zip(table.headers, table.rows[0].values))
    assert row["渠道 / 区服"] == "新区"
    assert row["绑定手机号"] == ""
    assert row["有无二次"] == "无"
    assert row["账号描述"] == "最新账号描述"
    assert row["账号图片"] == "2张"
    update_account_profile(seeded_db, order.account_id, actor="pytest", account_images=None)
    seeded_db.commit()
    response = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": order.order_no})
    assert response.status_code == 200, response.text
    tables = parse_order_import(f"订单.{extension}", response.content)
    table = tables["details"] if extension == "xlsx" else tables["main"]
    assert dict(zip(table.headers, table.rows[0].values))["账号图片"] == ""


def test_execute_creates_unbound_orders_reserves_numbers_and_is_idempotent_on_skip(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.domain.trade import Account, Order
    from app.settings.field_definitions.game_types import create_game_type

    game = create_game_type(seeded_db, name="手游", actor="pytest")
    content = ("订单号,业务日期,业务类型,游戏账号/产品,游戏/产品类型,订单备注\n"
               "HS0998,2026-10-17,回收,导入账号,手游,历史备注\n").encode()
    def submit(choice):
        return seeded_client.post("/api/order-imports/execute", headers=headers,
                                  data={"existing": choice}, files={"file": ("订单.csv", content, "text/csv")})
    response = submit("skip")
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 1 and response.json()["skipped"] == 0
    order = seeded_db.scalar(select(Order).where(Order.order_no == "HS0998"))
    assert order is not None and order.account_id is None
    assert order.account_snapshot["game_account"] == "导入账号"
    assert order.account_snapshot["game_type"] == game.value
    assert order.trade_date == date(2026, 10, 17) and order.note == "历史备注"
    assert seeded_db.scalar(select(Account.id).where(Account.game_account == "导入账号")) is None
    repeated = submit("skip")
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["created"] == 0 and repeated.json()["skipped"] == 1
    next_order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 18), actor="pytest")
    assert next_order.order_no == "HS0999"


def test_execute_updates_only_supplied_fields_and_rolls_back_whole_invalid_file(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.domain.trade import Order

    existing = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 1), actor="pytest", note="旧备注")
    seeded_db.commit()
    content = f"订单号,业务日期,业务类型,订单备注\n{existing.order_no},2026-10-09,代挂,新备注\n".encode()
    updated = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "update"},
                                 files={"file": ("订单.csv", content, "text/csv")})
    assert updated.status_code == 200, updated.text
    seeded_db.refresh(existing)
    assert existing.note == "新备注" and existing.trade_date == date(2026, 10, 9)
    invalid = ("订单号,业务日期,业务类型\nHS0997,2026-10-17,回收\nTH0997,不合法,提号\n").encode()
    rejected = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip"},
                                  files={"file": ("订单.csv", invalid, "text/csv")})
    assert rejected.status_code == 422
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "HS0997")) is None


def test_rebate_import_is_idempotent_and_updates_the_linked_cashflow(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.foundation import Pool
    from app.domain.trade import Cashflow, Order, RebateRecord

    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    def workbook(amount):
        book = Workbook()
        main = book.active
        main.title = "主订单信息"
        main.append(["订单号", "业务日期", "业务类型"])
        main.append(["DG0988", "2026-10-17", "代挂"])
        detail = book.create_sheet("返点明细")
        detail.append(["订单号", "返点单号", "返点类型", "返点金额", "收到日期", "资金账户编码"])
        detail.append(["DG0988", "DG0988-RB01", "卖号返点", amount, "2026-10-18", pool.code])
        output = BytesIO()
        book.save(output)
        return output.getvalue()

    def submit(choice, amount):
        return seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": choice, "sections": "rebates"},
                                  files={"file": ("订单.xlsx", workbook(amount), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    first = submit("skip", "12.50")
    assert first.status_code == 200, first.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0988"))
    rebate = seeded_db.scalar(select(RebateRecord).where(RebateRecord.source_order_id == order.id))
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == order.id))
    assert order.account_id is None and rebate.rebate_no == "DG0988-RB01"
    assert str(rebate.amount) == "12.50" and str(flow.amount) == "12.50" and flow.pool_id == pool.id
    repeated = submit("skip", "12.50")
    assert repeated.status_code == 200, repeated.text
    assert len(seeded_db.scalars(select(RebateRecord).where(RebateRecord.source_order_id == order.id)).all()) == 1
    updated = submit("update", "15.75")
    assert updated.status_code == 200, updated.text
    seeded_db.refresh(rebate)
    seeded_db.refresh(flow)
    assert str(rebate.amount) == "15.75" and str(flow.amount) == "15.75"


def test_rebate_import_requires_a_real_target_pool_and_rolls_back(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Order
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "业务日期", "业务类型"])
    main.append(["DG0989", "2026-10-17", "代挂"])
    rebates = book.create_sheet("返点明细")
    rebates.append(["订单号", "返点单号", "返点类型", "返点金额", "收到日期", "资金账户编码"])
    rebates.append(["DG0989", "DG0989-RB01", "卖号返点", "12.50", "2026-10-18", "不存在"])
    output = BytesIO()
    book.save(output)
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip", "sections": "rebates"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 422
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "DG0989")) is None


def test_manual_cashflow_import_preserves_accounting_and_does_not_duplicate(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.foundation import Pool
    from app.domain.trade import Cashflow, Order

    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "业务日期", "业务类型"])
    main.append(["DG0975", "2026-10-17", "代挂"])
    flows = book.create_sheet("资金明细")
    flows.append(["订单号", "流水号", "业务类别编码", "方向", "金额", "时间", "资金账户编码", "核算属性", "来源类型"])
    flows.append(["DG0975", "SR00975", "OTHER", "收入", "25.75", "2026-10-18", pool.code, "OTHER_INCOME", "MANUAL"])
    output = BytesIO()
    book.save(output)
    def submit(choice):
        return seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": choice, "sections": "cashflows"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    first = submit("skip")
    assert first.status_code == 200, first.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0975"))
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.flow_no == "SR00975"))
    assert order.account_id is None and flow.order_id == order.id and flow.pool_id == pool.id
    assert str(flow.amount) == "25.75" and flow.accounting_attribute == "OTHER_INCOME" and flow.source_type == "MANUAL"
    repeated = submit("update")
    assert repeated.status_code == 200, repeated.text
    assert len(seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()) == 1


def test_event_derived_cashflow_cannot_be_imported_without_its_business_source(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.foundation import Pool
    from app.domain.trade import Order
    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "业务日期", "业务类型"])
    main.append(["DG0976", "2026-10-17", "代挂"])
    flows = book.create_sheet("资金明细")
    flows.append(["订单号", "流水号", "业务类别编码", "方向", "金额", "时间", "资金账户编码", "核算属性", "来源类型", "来源编号"])
    flows.append(["DG0976", "SR00976", "SELL", "收入", "10", "2026-10-18", pool.code, "DG_REVENUE", "ORDER_EVENT", "DG0976-EV01"])
    output = BytesIO()
    book.save(output)
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip", "sections": "cashflows"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 422 and "来源" in response.text
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "DG0976")) is None


def test_operational_events_import_with_stable_unlisting_reference(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.business.shared.listing_state import active_listings
    from app.domain.trade import Order, OrderEvent
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "业务日期", "业务类型"])
    main.append(["DG0970", "2026-10-17", "代挂"])
    events = book.create_sheet("操作明细")
    events.append(["订单号", "事件号", "事件顺序", "动作", "运营动作", "动作时间", "运营详情(JSON)", "关联上架事件号", "备注", "原因"])
    events.append(["DG0970", "DG0970-EV-OPERATE-01", "1", "运营", "CONSIGNMENT", "2026-10-17",
                   '{"consignment_platforms":["千寻"],"listed_at":"2026-10-17T10:00:00"}', "", "上架"])
    events.append(["DG0970", "DG0970-EV-OPERATE-02", "2", "运营", "UNLIST", "2026-10-18",
                   '{"consignment_platforms":["千寻"],"platform_unlist_scope":"PLATFORM"}', "DG0970-EV-OPERATE-01", "下架", "平台停售"])
    output = BytesIO()
    book.save(output)
    def submit(choice):
        return seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": choice, "sections": "events"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    first = submit("skip")
    assert first.status_code == 200, first.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0970"))
    rows = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id).order_by(OrderEvent.id)).all()
    assert len(rows) == 2 and rows[1].form_extra["consignment_event_id"] == rows[0].id
    assert not active_listings(seeded_db, order.id)
    repeated = submit("update")
    assert repeated.status_code == 200, repeated.text
    assert len(seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()) == 2


def test_selected_order_details_imports_snapshot_and_note_without_binding_stock(seeded_client, seeded_db, headers):
    from sqlalchemy import select
    from app.domain.trade import Account, Order
    from app.settings.field_definitions.game_types import create_game_type
    game = create_game_type(seeded_db, name="手游", channel_regions=[{"label": "一区"}], actor="pytest")
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "业务日期", "业务类型", "游戏账号/产品", "游戏/产品类型"])
    main.append(["DG0960", "2026-10-17", "代挂", "历史账号", "手游"])
    details = book.create_sheet("详情信息")
    details.append(["订单标识", "账号详情", None, None, None, "订单信息"])
    details.append([None, None, None, None, None, None])
    details.append(["订单号", "渠道 / 区服", "绑定手机号", "有无二次", "账号描述", "订单备注"])
    details.append(["DG0960", "一区", "12345", "有", "历史账号描述", "历史订单备注"])
    output = BytesIO()
    book.save(output)
    response = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "skip", "sections": "details"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 200, response.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0960"))
    assert order.account_id is None and order.note == "历史订单备注"
    assert order.account_snapshot["channel_region"] == game.channel_regions[0]["value"]
    assert order.account_snapshot["bound_phone"] == "12345" and order.account_snapshot["has_secondary"] is True
    assert order.account_snapshot["account_description"] == "历史账号描述"
    assert seeded_db.scalar(select(Account.id).where(Account.game_account == "历史账号")) is None
    fetched = seeded_client.get(f"/api/orders/{order.id}", headers=headers)
    assert fetched.status_code == 200, fetched.text
    snapshot = fetched.json()["account_snapshot"]
    assert snapshot["bound_phone"] == "12345" and snapshot["has_secondary"] is True
    assert snapshot["account_description"] == "历史账号描述"
    exported = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text
    details_table = parse_order_import("订单.xlsx", exported.content)["details"]
    detail = dict(zip(details_table.headers, details_table.rows[0].values))
    assert detail["渠道 / 区服"] == "一区" and detail["绑定手机号"] == "12345"
    assert detail["账号描述"] == "历史账号描述"
    repeated = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "update", "sections": "details"},
                                  files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert repeated.status_code == 200, repeated.text
    details.cell(4, 5, "尝试覆盖描述")
    changed = BytesIO()
    book.save(changed)
    changed_preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "update", "sections": "details"},
                                         files={"file": ("订单.xlsx", changed.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert changed_preview.status_code == 200, changed_preview.text
    assert any("账号描述" in item["message"] for item in changed_preview.json()["detail_errors"])
    rejected = seeded_client.post("/api/order-imports/execute", headers=headers, data={"existing": "update", "sections": "details"},
                                  files={"file": ("订单.xlsx", changed.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert rejected.status_code == 422, rejected.text
    seeded_db.refresh(order)
    assert order.account_snapshot["account_description"] == "历史账号描述"
    main.cell(2, 1, "TH0960")
    main.cell(2, 3, "提号")
    details.cell(4, 1, "TH0960")
    invalid = BytesIO()
    book.save(invalid)
    preview = seeded_client.post("/api/order-imports/preview", headers=headers, data={"existing": "skip", "sections": "details"},
                                 files={"file": ("订单.xlsx", invalid.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert preview.status_code == 200, preview.text
    assert any("仅适用于回收或代挂" in item["message"] for item in preview.json()["detail_errors"])
    assert seeded_db.scalar(select(Order.id).where(Order.order_no == "TH0960")) is None


def test_order_creation_keeps_account_description_on_inventory_and_enforces_scope(seeded_client, seeded_db, headers):
    from app.domain.trade import Account

    payload = {"order_type": "DG", "trade_date": "2026-10-17",
               "account_snapshot": {"game_account": "普通建单-描述", "account_description": "代挂介绍"}}
    created = seeded_client.post("/api/orders", headers=headers, json=payload)
    assert created.status_code == 201, created.text
    assert seeded_db.get(Account, created.json()["account_id"]).account_description == "代挂介绍"
    payload["order_type"] = "TH"
    payload["account_snapshot"]["game_account"] = "提号-描述不允许"
    denied = seeded_client.post("/api/orders", headers=headers, json=payload)
    assert denied.status_code == 422, denied.text
    assert "仅适用于回收或代挂" in denied.text


@pytest.mark.parametrize("extension", ["csv", "xlsx"])
def test_exported_details_can_update_the_same_order_without_rewriting_readonly_fields(seeded_client, seeded_db, headers, extension):
    import csv
    from datetime import date
    from io import StringIO
    from app.business.inventory.profile import update_account_profile
    from app.business.orders.create import create_order
    from app.domain.trade import Account

    order = create_order(
        seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
        account_snapshot={"game_account": "详情回流", "channel_region": "一区", "account_description": "账号介绍"},
        form_extra={"business_responsible_ids": [1]},
    )
    update_account_profile(seeded_db, order.account_id, actor="pytest", account_images=["data:image/png;base64,one"])
    seeded_db.commit()
    exported = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text
    mime = "text/csv" if extension == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    def submit(path):
        return seeded_client.post(f"/api/order-imports/{path}", headers=headers,
                                  data={"existing": "update", "sections": "details"},
                                  files={"file": (f"订单.{extension}", exported.content, mime)})
    preview = submit("preview")
    assert preview.status_code == 200, preview.text
    assert preview.json()["rows"][0]["action"] == "update", preview.json()
    assert any("只读详情" in warning for warning in preview.json()["rows"][0]["warnings"])
    assert preview.json()["detail_errors"] == [], preview.json()
    if extension == "csv":
        reader = csv.DictReader(StringIO(exported.content.decode("utf-8-sig")))
        rows = list(reader)
        rows[0]["订单扩展字段"] = '{"业务负责人":"错误人员"}'
        output = StringIO(newline="")
        writer = csv.DictWriter(output, fieldnames=reader.fieldnames)
        writer.writeheader()
        writer.writerows(rows)
        modified = output.getvalue().encode()
    else:
        book = load_workbook(BytesIO(exported.content))
        sheet = book["详情信息"]
        headers_row = [cell.value for cell in sheet[3]]
        sheet.cell(4, headers_row.index("订单扩展字段") + 1, '{"业务负责人":"错误人员"}')
        output = BytesIO()
        book.save(output)
        modified = output.getvalue()
    rejected = seeded_client.post("/api/order-imports/preview", headers=headers,
                                  data={"existing": "update", "sections": "details"},
                                  files={"file": (f"订单.{extension}", modified, mime)})
    assert rejected.status_code == 200, rejected.text
    assert any("订单扩展字段" in item["message"] for item in rejected.json()["detail_errors"])
    result = submit("execute")
    assert result.status_code == 200, result.text
    assert result.json()["updated"] == 1
    seeded_db.refresh(order)
    assert order.form_extra["business_responsible_ids"] == [1]
    assert seeded_db.get(Account, order.account_id).account_images == ["data:image/png;base64,one"]


def test_detail_import_rechecks_readonly_values_after_preview(seeded_client, seeded_db, headers):
    from datetime import date
    from app.business.orders.create import create_order
    from app.business.orders.mutations import update_order

    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                         account_snapshot={"game_account": "并发详情回流"},
                         form_extra={"business_responsible_ids": [1]})
    seeded_db.commit()
    exported = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": order.order_no})
    assert exported.status_code == 200, exported.text
    def submit(path):
        return seeded_client.post(f"/api/order-imports/{path}", headers=headers,
                                  data={"existing": "update", "sections": "details"},
                                  files={"file": ("订单.xlsx", exported.content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    preview = submit("preview")
    assert preview.status_code == 200 and not preview.json()["detail_errors"], preview.text
    update_order(seeded_db, order.id, actor="other", form_extra={"business_responsible_ids": [2]}, form_extra_scope="DG")
    seeded_db.commit()
    rejected = submit("execute")
    assert rejected.status_code == 422, rejected.text
    seeded_db.refresh(order)
    assert order.form_extra["business_responsible_ids"] == [2]


@pytest.mark.parametrize("extension", ["csv", "xlsx"])
def test_order_export_includes_identity_needed_for_import_even_when_hidden(seeded_client, seeded_db, headers, extension):
    from datetime import date
    from app.business.orders.create import create_order
    from app.settings.lists.service import save_config
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest")
    save_config(seeded_db, "LEDGER", [
        {"column_key": "order_no", "is_visible": False, "sort_order": 1},
        {"column_key": "inventory_type", "is_visible": False, "sort_order": 2},
    ], actor="pytest")
    seeded_db.commit()
    response = seeded_client.get(f"/api/orders/export.{extension}", headers=headers, params={"keyword": order.order_no})
    assert response.status_code == 200, response.text
    table = parse_order_import(f"订单.{extension}", response.content)["main"]
    record = dict(zip(table.headers, table.rows[0].values))
    assert record["订单号"] == order.order_no
    assert record["业务日期"].startswith("2026-10-17")
    assert record["业务类型"] in {"代挂", "CONSIGNMENT", "DG"}


def test_buy_sell_and_their_cashflows_import_once_as_linked_facts(seeded_client, seeded_db, headers):
    from decimal import Decimal
    from sqlalchemy import select
    from app.domain.foundation import Pool
    from app.domain.trade import Cashflow, Order, OrderEvent
    from app.shared.order_amounts import order_cashflow_profit
    pool = seeded_db.scalar(select(Pool).where(Pool.is_default.is_(True)))
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "业务日期", "业务类型", "游戏账号/产品"])
    main.append(["HS0980", "2026-10-17", "回收", "历史回收账号"])
    events = book.create_sheet("操作明细")
    events.append(["订单号", "事件号", "事件顺序", "动作", "动作时间", "金额", "金额归属", "资金账户编码", "已过账"])
    events.append(["HS0980", "HS0980-EV-BUY-01", "1", "买入", "2026-10-17", "100", "PRINCIPAL", pool.code, "是"])
    events.append(["HS0980", "HS0980-EV-SELL-01", "2", "售出", "2026-10-18", "150", "GROSS", pool.code, "是"])
    flows = book.create_sheet("资金明细")
    flows.append(["订单号", "流水号", "业务类别编码", "方向", "金额", "时间", "资金账户编码", "核算属性", "来源类型", "来源编号"])
    flows.append(["HS0980", "ZC07890", "BUY", "支出", "100", "2026-10-17", pool.code, "SELF_DIRECT_COST", "ORDER_EVENT", "HS0980-EV-BUY-01"])
    flows.append(["HS0980", "SR07890", "SELL", "收入", "150", "2026-10-18", pool.code, "SELF_REVENUE", "ORDER_EVENT", "HS0980-EV-SELL-01"])
    output = BytesIO()
    book.save(output)
    response = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": ["events", "cashflows"]},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 200, response.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "HS0980"))
    event_rows = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    flow_rows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()
    assert order.account_id is None and order.status == "COMPLETED"
    assert len(event_rows) == 2 and len(flow_rows) == 2
    assert {flow.source_id for flow in flow_rows} == {event.event_no for event in event_rows}
    assert order_cashflow_profit(seeded_db, order.id) == Decimal("50.00")


def test_rebate_event_and_cashflow_are_imported_once_together_from_export(seeded_client, seeded_db, headers):
    from datetime import date
    from decimal import Decimal
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.domain.trade import Cashflow, Order, OrderEvent, RebateRecord
    from app.finance.rebates import create_rebate
    from app.shared.order_amounts import order_cashflow_profit

    original = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest")
    create_rebate(seeded_db, source_order_id=original.id, rebate_type="SELL", amount="12.50",
                  collected_on=date(2026, 10, 18), actor="pytest", note="渠道返点")
    seeded_db.commit()
    response = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": original.order_no})
    assert response.status_code == 200, response.text
    source = load_workbook(BytesIO(response.content))
    book = Workbook()
    main = book.active
    main.title = "主订单信息"
    main.append(["订单号", "业务日期", "业务类型"])
    main.append(["DG0985", "2026-10-17", "代挂"])
    for title in ("操作明细", "资金明细", "返点明细"):
        sheet = book.create_sheet(title)
        for cells in source[title].values:
            row = [cell.replace(original.order_no, "DG0985") if isinstance(cell, str) else cell for cell in cells]
            if title == "资金明细" and row[0] == "DG0985":
                row[1] = "SR09850"
            sheet.append(row)
    event_headers = [cell.value for cell in book["操作明细"][1]]
    assert "来源编号" in event_headers
    output = BytesIO()
    book.save(output)
    def submit(choice):
        return seeded_client.post("/api/order-imports/execute", headers=headers,
            data={"existing": choice, "sections": ["events", "cashflows", "rebates"]},
            files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    first = submit("skip")
    assert first.status_code == 200, first.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0985"))
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    flows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()
    rebates = seeded_db.scalars(select(RebateRecord).where(RebateRecord.source_order_id == order.id)).all()
    assert len(events) == len(flows) == len(rebates) == 1
    assert events[0].source_id == rebates[0].rebate_no and flows[0].source_id == events[0].event_no
    assert order_cashflow_profit(seeded_db, order.id) == Decimal("12.50")
    assert submit("update").status_code == 200
    assert len(seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()) == 1


def test_csv_export_rebate_details_keep_machine_codes_for_import(seeded_client, seeded_db, headers):
    import csv
    import json
    from datetime import date
    from io import StringIO
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.domain.trade import Cashflow, Order, OrderEvent, RebateRecord
    from app.finance.rebates import create_rebate

    original = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest")
    create_rebate(seeded_db, source_order_id=original.id, rebate_type="SELL", amount="12.50",
                  collected_on=date(2026, 10, 18), actor="pytest")
    seeded_db.commit()
    response = seeded_client.get("/api/orders/export.csv", headers=headers, params={"keyword": original.order_no})
    assert response.status_code == 200, response.text
    record = next(csv.DictReader(StringIO(response.text.lstrip("\ufeff"))))
    event = json.loads(record["操作明细"])[0]
    flow = json.loads(record["资金明细"])[0]
    assert event["来源类型"] == "REBATE"
    assert event["来源编号"].startswith(original.order_no)
    assert flow["业务类别编码"] == "REBATE" and flow["来源类型"] == "ORDER_EVENT"
    columns = ["订单号", "业务日期", "业务类型", "操作明细", "资金明细", "返点明细"]
    target = {key: record[key].replace(original.order_no, "DG0986") for key in columns}
    flows = json.loads(target["资金明细"])
    flows[0]["流水号"] = "SR09860"
    target["资金明细"] = json.dumps(flows, ensure_ascii=False)
    text = StringIO(newline="")
    writer = csv.DictWriter(text, fieldnames=columns)
    writer.writeheader()
    writer.writerow(target)
    imported = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": ["events", "cashflows", "rebates"]},
        files={"file": ("订单.csv", text.getvalue().encode(), "text/csv")})
    assert imported.status_code == 200, imported.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0986"))
    assert len(seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()) == 1
    assert len(seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()) == 1
    assert len(seeded_db.scalars(select(RebateRecord).where(RebateRecord.source_order_id == order.id)).all()) == 1


def test_exported_sale_cancellation_imports_with_original_event_reference(seeded_client, seeded_db, headers):
    from datetime import date
    from decimal import Decimal
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.business.orders.events import post_event
    from app.domain.trade import Cashflow, Order, OrderEvent
    from app.shared.order_amounts import order_cashflow_profit

    original = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                            account_snapshot={"game_account": "cancel-source"})
    sale, _ = post_event(seeded_db, original.id, event_type="SELL", sale_mode="FULL", portion="GROSS", amount="50",
                         occurred_on=date(2026, 10, 18), actor="pytest")
    post_event(seeded_db, original.id, event_type="CANCEL", amount="50", offset_event_id=sale.id,
               occurred_on=date(2026, 10, 19), actor="pytest", reason="售出取消")
    seeded_db.commit()
    export = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": original.order_no})
    assert export.status_code == 200, export.text
    source = load_workbook(BytesIO(export.content))
    book = Workbook()
    book.active.title = "主订单信息"
    book.active.append(["订单号", "业务日期", "业务类型"])
    book.active.append(["DG0983", "2026-10-17", "代挂"])
    for title in ("操作明细", "资金明细"):
        sheet = book.create_sheet(title)
        for cells in source[title].values:
            row = [cell.replace(original.order_no, "DG0983") if isinstance(cell, str) else cell for cell in cells]
            if title == "资金明细" and row[0] == "DG0983":
                row[1] = ("SR" if str(row[1]).startswith("SR") else "ZC") + "09830"
            sheet.append(row)
    output = BytesIO()
    book.save(output)
    result = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": ["events", "cashflows"]},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0983"))
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id).order_by(OrderEvent.id)).all()
    assert len(events) == 2 and events[1].offset_event_id == events[0].id
    assert order.account_id is None and order.status == "CANCELLED"
    assert len(seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()) == 2
    assert order_cashflow_profit(seeded_db, order.id) == Decimal("0.00")


def test_exported_delivery_import_restores_recorded_phone_and_order_details(seeded_client, seeded_db, headers):
    from datetime import date
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.business.orders.events import post_event
    from app.domain.trade import Order, OrderEvent

    original = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest",
                            account_snapshot={"game_account": "delivery-source"})
    post_event(seeded_db, original.id, event_type="SELL", sale_mode="FULL", portion="GROSS", amount="50",
               occurred_on=date(2026, 10, 18), actor="pytest")
    post_event(seeded_db, original.id, event_type="DELIVER", delivery_direction="SELL", note="交接完成",
               bound_phone="13900000001", bound_phone_owner="张三", occurred_on=date(2026, 10, 19), actor="pytest")
    seeded_db.commit()
    export = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": original.order_no})
    assert export.status_code == 200, export.text
    source = load_workbook(BytesIO(export.content))
    book = Workbook()
    book.active.title = "主订单信息"
    book.active.append(["订单号", "业务日期", "业务类型", "游戏账号/产品"])
    book.active.append(["DG0984", "2026-10-17", "代挂", "delivery-target"])
    events = book.create_sheet("操作明细")
    for cells in source["操作明细"].values:
        events.append([cell.replace(original.order_no, "DG0984") if isinstance(cell, str) else cell for cell in cells])
    output = BytesIO()
    book.save(output)
    result = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": "events"},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0984"))
    delivery = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "DELIVER"))
    assert delivery.form_extra["delivery_direction"] == "SELL"
    assert order.form_extra["sell_bound_phone"] == "13900000001"
    assert order.account_snapshot["bound_phone_owner"] == "张三"


@pytest.mark.parametrize(("order_type", "resell"), [("HS", False), ("TH", False), ("HS", True)])
def test_unbound_historical_sale_cancellation_retains_order_lifecycle(seeded_client, seeded_db, headers, order_type, resell):
    from datetime import date
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.business.orders.events import post_event
    from app.domain.trade import Order, OrderEvent
    original = create_order(seeded_db, order_type=order_type, trade_date=date(2026, 10, 17), actor="pytest",
                            account_snapshot={"game_account": f"cancel-{order_type}-{resell}"})
    post_event(seeded_db, original.id, event_type="BUY", amount="30", occurred_on=date(2026, 10, 17), actor="pytest")
    sale, _ = post_event(seeded_db, original.id, event_type="SELL", sale_mode="FULL", amount="50",
                         occurred_on=date(2026, 10, 18), actor="pytest")
    post_event(seeded_db, original.id, event_type="CANCEL", amount="50", offset_event_id=sale.id,
               occurred_on=date(2026, 10, 19), actor="pytest", reason="售出取消")
    latest = sale
    if resell:
        latest, _ = post_event(seeded_db, original.id, event_type="SELL", sale_mode="FULL", amount="60",
                               occurred_on=date(2026, 10, 20), actor="pytest")
    seeded_db.commit()
    execution = seeded_client.get(f"/api/orders/{original.id}/execution-detail", headers=headers)
    assert execution.status_code == 200, execution.text
    assert execution.json()["orders"][0]["latest_sale_event_id"] == latest.id
    export = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": original.order_no})
    source = load_workbook(BytesIO(export.content))
    target = f"{order_type}0984"
    book = Workbook()
    book.active.title = "主订单信息"
    book.active.append(["订单号", "业务日期", "业务类型", "游戏账号/产品"])
    book.active.append([target, "2026-10-17", order_type, "未绑定历史账号"])
    events = book.create_sheet("操作明细")
    for cells in source["操作明细"].values:
        events.append([cell.replace(original.order_no, target) if isinstance(cell, str) else cell for cell in cells])
    output = BytesIO()
    book.save(output)
    result = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": "events"},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == target))
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id).order_by(OrderEvent.id)).all()
    assert events[2].offset_event_id == events[1].id and order.account_id is None
    assert order.status == ("COMPLETED" if resell else "ACTIVE")


def test_event_split_between_multiple_accounts_imports_without_double_counting(seeded_client, seeded_db, headers):
    from datetime import date
    from decimal import Decimal
    from sqlalchemy import select
    from app.business.orders.create import create_order
    from app.business.orders.events import post_event
    from app.domain.foundation import Pool
    from app.domain.trade import Cashflow, Order, OrderEvent
    from app.finance.cashflow.writes.create import create_cashflow
    from app.shared.order_amounts import order_cashflow_profit
    other_pool = Pool(code="split-import", name="分账测试", created_by="pytest", updated_by="pytest")
    seeded_db.add(other_pool)
    seeded_db.flush()
    original = create_order(seeded_db, order_type="DG", trade_date=date(2026, 10, 17), actor="pytest")
    event, first = post_event(seeded_db, original.id, event_type="SELL", sale_mode="FULL", portion="GROSS",
                              amount="100", occurred_on=date(2026, 10, 18), actor="pytest")
    first.amount = Decimal("60.00")
    first.operator_user_ids = [11]
    create_cashflow(seeded_db, pool_id=other_pool.id, occurred_on=date(2026, 10, 18), direction="IN",
                    category="SELL", accounting_attribute=first.accounting_attribute, amount="40", actor="pytest",
                    order_id=original.id, source_type="ORDER_EVENT", source_id=event.event_no, operator_user_ids=[12])
    seeded_db.commit()
    export = seeded_client.get("/api/orders/export.xlsx", headers=headers, params={"keyword": original.order_no})
    source = load_workbook(BytesIO(export.content))
    book = Workbook()
    book.active.title = "主订单信息"
    book.active.append(["订单号", "业务日期", "业务类型"])
    book.active.append(["DG0989", "2026-10-17", "代挂"])
    for title in ("操作明细", "资金明细"):
        sheet = book.create_sheet(title)
        for index, cells in enumerate(source[title].values):
            row = [cell.replace(original.order_no, "DG0989") if isinstance(cell, str) else cell for cell in cells]
            if title == "资金明细" and index:
                row[1] = f"SR{9800 + index:05d}"
            sheet.append(row)
    output = BytesIO()
    book.save(output)
    result = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "skip", "sections": ["events", "cashflows"]},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert result.status_code == 200, result.text
    order = seeded_db.scalar(select(Order).where(Order.order_no == "DG0989"))
    imported_event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    flows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()
    assert sorted(flow.amount for flow in flows) == [Decimal("40.00"), Decimal("60.00")]
    assert len({flow.pool_id for flow in flows}) == 2
    assert all(flow.source_id == imported_event.event_no for flow in flows)
    assert {flow.amount: flow.operator_user_ids for flow in flows} == {Decimal("60.00"): [11], Decimal("40.00"): [12]}
    assert order_cashflow_profit(seeded_db, order.id) == Decimal("100.00")
    repeated = seeded_client.post("/api/order-imports/execute", headers=headers,
        data={"existing": "update", "sections": ["events", "cashflows"]},
        files={"file": ("订单.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert repeated.status_code == 200, repeated.text
    assert len(seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order.id)).all()) == 2
