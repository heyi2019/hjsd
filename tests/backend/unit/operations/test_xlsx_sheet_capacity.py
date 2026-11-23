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
