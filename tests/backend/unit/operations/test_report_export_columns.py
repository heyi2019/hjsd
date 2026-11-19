"""EXPORT-01 报表导出与「设置 → 列表字段」列配置的一致性（2026-10-29 口径）。

规则：
- 导出列 = 该报表对应 `RPT_*` 作用域的可见列，顺序与界面一致；
- 表头用注册表中文名，不再是原始英文键名；
- 「已登记但被隐藏」的列一律不导 —— 隐藏列不能以英文键回填成新列；
- 唯一例外：**完全未登记**的键（如合计行独有字段）追加末尾，避免合计信息丢失；
- 枚举列的值按 `option_sets` 字典翻成中文（列注册表用 value_set 声明归属），
  row_type 是机器标记，保持 ITEM / TOTAL 英文。
"""
from __future__ import annotations

import csv
import io
from app.operations.export import report_csv


def _header(csv_text: str) -> list[str]:
    return csv_text.lstrip("\ufeff").splitlines()[0].split(",")


def test_report_csv_uses_chinese_headers_in_configured_order():
    report = {
        "items": [{"order_no": "HS-1", "income": "100.00", "net_profit": "20.00"}],
        "total": {"net_profit": "20.00"},
    }
    text = report_csv(
        report,
        columns=[
            ("income", "收入", True),
            ("order_no", "订单号", True),
            ("net_profit", "净利", True),
        ],
    )
    lines = text.lstrip("\ufeff").splitlines()
    assert lines[0] == "row_type,收入,订单号,净利"
    assert lines[1] == "ITEM,100.00,HS-1,20.00"
    assert lines[2] == "TOTAL,,,20.00"


def test_report_csv_drops_hidden_registered_column_without_refilling_key():
    """隐藏列既不出现在表头，也不得以英文键「作为未登记字段」回填。"""
    report = {
        "items": [{"order_no": "HS-1", "income": "100.00", "net_profit": "20.00"}],
        "total": {"net_profit": "20.00"},
    }
    header = _header(
        report_csv(
            report,
            columns=[
                ("order_no", "订单号", True),
                ("income", "收入", False),
                ("net_profit", "净利", True),
            ],
        )
    )
    assert header == ["row_type", "订单号", "净利"]
    assert "income" not in header
    assert "收入" not in header


def test_report_csv_appends_total_only_keys_and_drops_item_internal_keys():
    """合计行独有的键要保留（否则合计丢了），明细里的内部字段一律不导。"""
    report = {
        "items": [{"order_no": "HS-1", "order_id": 7, "extra_values": {"a": 1}}],
        "total": {"net_profit": "20.00"},
    }
    header = _header(report_csv(report, columns=[("order_no", "订单号", True)]))
    # 合计行独有键保留英文键（注册表里没有中文名），排在上表头之后
    assert header == ["row_type", "订单号", "net_profit"]
    assert "order_id" not in header
    assert "extra_values" not in header


def test_report_csv_does_not_refill_keys_shared_by_item_and_total():
    """明细与合计都有的未登记键不算「合计独有」，不能漏回导出表。"""
    report = {
        "items": [{"order_no": "HS-1", "cost": "5.00"}],
        "total": {"cost": "5.00"},
    }
    header = _header(report_csv(report, columns=[("order_no", "订单号", True)]))
    assert header == ["row_type", "订单号"]


def test_report_csv_without_columns_keeps_legacy_behaviour():
    report = {"items": [{"order_no": "HS-1"}]}
    assert _header(report_csv(report)) == ["row_type", "order_no"]


def test_report_csv_translates_enum_values_and_keeps_row_type():
    """值中文：命中的码翻译，row_type / 金额保持原样。"""
    report = {
        "items": [
            {"biz_kind": "STOCK", "direction": "IN", "status": "COMPLETED", "amount": "100.00"},
            {"biz_kind": "CONSIGN", "direction": "OUT", "status": "ACTIVE", "amount": "40.00"},
        ],
        "total": None,
    }
    lines = report_csv(
        report,
        columns=[
            ("biz_kind", "业务类型", True),
            ("direction", "现金方向", True),
            ("status", "状态", True),
            ("amount", "发生额", True),
        ],
        value_labels={
            "biz_kind": {"STOCK": "回收现货", "CONSIGN": "代挂寄售"},
            "direction": {"IN": "收入", "OUT": "支出"},
            "status": {"COMPLETED": "已完成", "ACTIVE": "进行中"},
        },
    ).lstrip("\ufeff").splitlines()
    assert lines[0] == "row_type,业务类型,现金方向,状态,发生额"
    assert lines[1] == "ITEM,回收现货,收入,已完成,100.00"
    assert lines[2] == "ITEM,代挂寄售,支出,进行中,40.00"


def test_report_csv_translates_custom_column_value():
    """自定义列（router 已把值注入明细行）：中文表头 + 选项码翻中文。"""
    report = {"items": [{"order_no": "HS-1", "extra:vip_tag": "A"}], "total": None}
    lines = report_csv(
        report,
        columns=[("order_no", "订单号", True), ("extra:vip_tag", "会员等级", True)],
        value_labels={"extra:vip_tag": {"A": "甲"}},
    ).lstrip("\ufeff").splitlines()
    assert lines[0] == "row_type,订单号,会员等级"
    assert lines[1] == "ITEM,HS-1,甲"


def test_report_csv_keeps_untranslated_values_intact():
    """未命中码 / 无映射的列 / None / 嵌套值都不该被翻译函数改写。"""
    report = {
        "items": [
            {"status": "UNKNOWN_CODE", "amount": "100.00", "note": None, "meta": {"k": 1}},
        ],
        "total": None,
    }
    rows = list(
        csv.reader(
            io.StringIO(
                report_csv(
                    report,
                    columns=[
                        ("status", "状态", True),
                        ("amount", "发生额", True),
                        ("note", "备注", True),
                        ("meta", "附加", True),
                    ],
                    value_labels={"status": {"COMPLETED": "已完成"}},
                ).lstrip("\ufeff")
            )
        )
    )
    assert rows[0] == ["row_type", "状态", "发生额", "备注", "附加"]
    assert rows[1] == ["ITEM", "UNKNOWN_CODE", "100.00", "", '{"k": 1}']
