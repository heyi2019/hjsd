"""EXPORT-02 工作簿超过单表容量时续表并重复表头。"""
from app.settings.lists import xlsx
from decimal import Decimal
from io import BytesIO
from openpyxl import load_workbook


def test_large_export_continues_on_new_sheets_with_headers(monkeypatch):
    monkeypatch.setattr(xlsx, "EXCEL_SHEET_ROW_LIMIT", 4, raising=False)
    workbook = xlsx.new_workbook()
    rows = [{"order_no": f"HS{number:04}"} for number in range(8)]
    xlsx.write_sheet(workbook, title="订单", rows=rows, columns=[("order_no", "订单号", True)])
    assert workbook.sheetnames == ["订单", "订单（2）", "订单（3）"]
    assert [[cell.value for cell in sheet["A"]] for sheet in workbook.worksheets] == [
        ["订单号", "HS0000", "HS0001", "HS0002"],
        ["订单号", "HS0003", "HS0004", "HS0005"],
        ["订单号", "HS0006", "HS0007"],
    ]


def test_continuation_repeats_grouped_headers(monkeypatch):
    monkeypatch.setattr(xlsx, "EXCEL_SHEET_ROW_LIMIT", 4)
    workbook = xlsx.new_workbook()
    xlsx.write_sheet(
        workbook,
        title="详情",
        rows=[{"order_no": "HS1"}, {"order_no": "HS2"}],
        columns=[("order_no", "订单号", True)],
        header_groups={"order_no": "订单"},
        sub_header_groups={"order_no": "编号"},
    )
    assert workbook.sheetnames == ["详情", "详情（2）"]
    assert [[cell.value for cell in sheet["A"]] for sheet in workbook.worksheets] == [
        ["订单", "编号", "订单号", "HS1"],
        ["订单", "编号", "订单号", "HS2"],
    ]


def test_xlsx_writes_formula_like_headers_and_values_as_literal_text():
    workbook = xlsx.new_workbook()
    xlsx.write_sheet(workbook, title="订单", rows=[{"note": "=SUM(1,1)", "amount": Decimal("-12.50")}],
                     columns=[("note", "=表头", True), ("amount", "金额", True)],
                     header_groups={"note": "=分组", "amount": "数据"})
    sheet = load_workbook(BytesIO(xlsx.xlsx_bytes(workbook)), data_only=False)["订单"]
    assert [(sheet[ref].value, sheet[ref].data_type) for ref in ("A1", "A2", "A3")] == [
        ("=分组", "s"), ("=表头", "s"), ("=SUM(1,1)", "s"),
    ]
    assert sheet["B3"].value == -12.5 and sheet["B3"].data_type == "n"


def test_streaming_export_preserves_grouped_headers_and_continuation(monkeypatch):
    monkeypatch.setattr(xlsx, "EXCEL_SHEET_ROW_LIMIT", 5)
    workbook = xlsx.new_workbook(write_only=True)
    xlsx.write_sheet(
        workbook,
        title="详情",
        rows=[{"number": "HS0001", "note": "=文本", "amount": Decimal("12.50")},
              {"number": "HS0002", "note": "备注", "amount": Decimal("-1.00")},
              {"number": "HS0003", "note": "其他", "amount": Decimal("0.00")}],
        columns=[("number", "订单号", True), ("note", "=备注", True), ("amount", "金额", True)],
        header_groups={"number": "订单", "note": "=业务", "amount": "=业务"},
        sub_header_groups={"note": "明细", "amount": "明细"},
    )
    result = load_workbook(BytesIO(xlsx.xlsx_bytes(workbook)), data_only=False)
    assert result.sheetnames == ["详情", "详情（2）"]
    first, second = result.worksheets
    assert {str(item) for item in first.merged_cells.ranges} == {"B1:C1", "B2:C2"}
    assert first.freeze_panes == "B4"
    assert first.auto_filter.ref == "A3:C5"
    assert first.column_dimensions["A"].width >= 8
    assert first["B1"].data_type == "s" and first["B3"].data_type == "s"
    assert first["B1"].fill.fgColor.rgb.endswith("2E75B6")
    assert first["B3"].fill.fgColor.rgb.endswith("1F4E79")
    assert first["B4"].value == "=文本" and first["B4"].data_type == "s"
    assert first["C4"].value == 12.5 and first["C5"].value == -1
    assert second["A3"].value == "订单号" and second["A4"].value == "HS0003"
    empty = xlsx.new_workbook(write_only=True)
    xlsx.write_sheet(empty, title="空列", rows=[{"a": "值"}], columns=[("a", "列", False)])
    empty_sheet = load_workbook(BytesIO(xlsx.xlsx_bytes(empty)))["空列"]
    assert empty_sheet.max_row == 1 and empty_sheet["A1"].value == "（无可导出列）"
