"""报表导出与「设置 → 列表字段」列配置的一致性（2026-10-29 口径）。

规则：
- 导出列 = 该报表对应 `RPT_*` 作用域的可见列，顺序与界面一致；
- 表头用注册表中文名，不再是英文键（此前导出的表头是 order_no / fund_nature 这类键名）；
- 「已登记但被隐藏」的列一律不导 —— 隐藏列不能以英文键回填成新列；
- 唯一例外：**完全未登记**的键（如合计行独有字段）追加末尾，避免合计信息丢失；
- 枚举列的值按 `option_sets` 字典翻成中文（列注册表用 value_set 声明归属），
  row_type 是机器标记，保持 ITEM / TOTAL 英文。
"""
from __future__ import annotations

import csv
import io
from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.foundation import Pool
from app.domain.options import OptionSet
from app.lists import service as lists_service
from app.reporting.service import report_csv


def _header(csv_text: str) -> list[str]:
    return csv_text.lstrip("\ufeff").splitlines()[0].split(",")


def _finance_rows(seeded_db) -> None:
    """在种子池上造两笔已审核流水，使资金属性分析报表非空。"""
    from app.finance.cashflows import create_cashflow

    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None, "种子池 HJ_INVEST 缺失"
    for direction, amount, attribute in (
        ("IN", "100.00", "SELF_REVENUE"),
        ("OUT", "40.00", "SELF_DIRECT_COST"),
    ):
        flow = create_cashflow(
            seeded_db,
            pool_id=pool.id,
            occurred_on=date(2026, 10, 17),
            direction=direction,
            nature="BUSINESS_IN" if direction == "IN" else "BUSINESS_OUT",
            fund_nature="BUSINESS",
            accounting_attribute=attribute,
            category="OTHER",
            amount=Decimal(amount),
            actor="pytest",
            note="导出列配置测试",
        )


def _set_visibility(seeded_client, headers, scope: str, hidden: set[str]) -> None:
    config = next(
        item
        for item in seeded_client.get("/api/v1/list-columns", headers=headers).json()
        if item["code"] == scope
    )
    items = [
        {
            "column_key": column["key"],
            "is_visible": column["key"] not in hidden,
            "sort_order": index * 10,
        }
        for index, column in enumerate(config["columns"])
    ]
    response = seeded_client.put(
        f"/api/v1/list-columns/{scope}", json={"items": items}, headers=headers
    )
    assert response.status_code == 200, response.text


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
        "items": [{"order_no": "HS-1", "buy_amount": "5.00"}],
        "total": {"buy_amount": "5.00"},
    }
    header = _header(report_csv(report, columns=[("order_no", "订单号", True)]))
    assert header == ["row_type", "订单号"]


def test_report_csv_without_columns_keeps_legacy_behaviour():
    report = {"items": [{"order_no": "HS-1"}]}
    assert _header(report_csv(report)) == ["row_type", "order_no"]


def test_export_endpoint_uses_visible_chinese_columns(seeded_db, seeded_client, headers):
    _finance_rows(seeded_db)
    exported = seeded_client.get(
        "/api/v1/reports/finance-dimensions/export.csv", headers=headers
    )
    assert exported.status_code == 200, exported.text
    header = _header(exported.content.decode("utf-8-sig"))
    assert header[0] == "row_type"
    assert "资金性质" in header
    assert "发生额" in header
    assert "fund_nature" not in header

    # 隐藏两列后再导出：中文表头消失，且不会以英文键回填
    _set_visibility(seeded_client, headers, "RPT_FINANCE_DIM", {"fund_nature", "accounting_attribute"})
    again = seeded_client.get(
        "/api/v1/reports/finance-dimensions/export.csv", headers=headers
    )
    assert again.status_code == 200, again.text
    trimmed = _header(again.content.decode("utf-8-sig"))
    assert "资金性质" not in trimmed
    assert "核算属性" not in trimmed
    assert "fund_nature" not in trimmed
    assert "accounting_attribute" not in trimmed
    assert "发生额" in trimmed


def test_export_endpoint_follows_configured_order(seeded_db, seeded_client, headers):
    _finance_rows(seeded_db)
    config = next(
        item
        for item in seeded_client.get("/api/v1/list-columns", headers=headers).json()
        if item["code"] == "RPT_FINANCE_DIM"
    )
    columns = config["columns"]
    amount = next(column for column in columns if column["key"] == "amount")
    ordered = [amount, *[column for column in columns if column["key"] != "amount"]]
    response = seeded_client.put(
        "/api/v1/list-columns/RPT_FINANCE_DIM",
        json={
            "items": [
                {
                    "column_key": column["key"],
                    "is_visible": True,
                    "sort_order": index * 10,
                }
                for index, column in enumerate(ordered)
            ]
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text

    exported = seeded_client.get(
        "/api/v1/reports/finance-dimensions/export.csv", headers=headers
    )
    header = _header(exported.content.decode("utf-8-sig"))
    # row_type 固定第一列，其后按配置顺序
    assert header[:2] == ["row_type", "发生额"]


def _seed_option_sets(seeded_db) -> None:
    """测试库用 create_all 建表、不走 alembic 播种，option_sets 为空；显式补几组字典。

    正式库由 0001 基线播种 57 组，导出时现查该表，无需这段代码。
    """
    sets = {
        "FUND_FLOW_FUND_NATURE": [
            {"value": "BUSINESS", "label": "本方经营"},
            {"value": "EXTERNAL", "label": "外部/受托"},
            {"value": "INTERNAL", "label": "内部调拨"},
        ],
        "FUND_FLOW_ACCOUNTING_ATTRIBUTE": [
            {"value": "SELF_REVENUE", "label": "自营收入"},
            {"value": "SELF_DIRECT_COST", "label": "自营直接成本"},
        ],
        "FUND_FLOW_DIRECTION": [
            {"value": "IN", "label": "收入"},
            {"value": "OUT", "label": "支出"},
        ],
        "ORDER_BUSINESS": [
            {"value": "DG", "label": "代挂"},
            {"value": "DFQ", "label": "代分期"},
        ],
        "ORDER_STATUS": [
            {"value": "ACTIVE", "label": "进行中"},
            {"value": "COMPLETED", "label": "已完成"},
        ],
        "INVENTORY_STATUS": [
            {"value": "IN_STOCK", "label": "在库"},
            {"value": "VOID", "label": "下架"},
        ],
    }
    for code, options in sets.items():
        seeded_db.add(
            OptionSet(
                code=code,
                label=code,
                group="EXPORT_TEST",
                editable=False,
                options=options,
            )
        )
    seeded_db.commit()


def test_report_csv_translates_enum_values_and_keeps_row_type():
    """值中文：命中的码翻译，row_type / 金额保持原样。"""
    report = {
        "items": [
            {"fund_nature": "BUSINESS", "direction": "IN", "status": "COMPLETED", "amount": "100.00"},
            {"fund_nature": "EXTERNAL", "direction": "OUT", "status": "ACTIVE", "amount": "40.00"},
        ],
        "total": None,
    }
    lines = report_csv(
        report,
        columns=[
            ("fund_nature", "资金性质", True),
            ("direction", "现金方向", True),
            ("status", "状态", True),
            ("amount", "发生额", True),
        ],
        value_labels={
            "fund_nature": {"BUSINESS": "本方经营", "EXTERNAL": "外部/受托"},
            "direction": {"IN": "收入", "OUT": "支出"},
            "status": {"COMPLETED": "已完成", "ACTIVE": "进行中"},
        },
    ).lstrip("\ufeff").splitlines()
    assert lines[0] == "row_type,资金性质,现金方向,状态,发生额"
    assert lines[1] == "ITEM,本方经营,收入,已完成,100.00"
    assert lines[2] == "ITEM,外部/受托,支出,进行中,40.00"


def _seed_custom_field(seeded_db) -> None:
    """造一个启用中的自定义字段，供「新增自定义列」导出用例使用。"""
    from app.domain.trade import OrderFormField

    seeded_db.add(
        OrderFormField(
            order_type_code="CUSTOMER",
            field_key="vip_tag",
            label="VIP 标签",
            field_type="SELECT",
            options=[{"value": "A", "label": "甲"}],
            flow_direction=None,
            required=False,
            required_when=None,
            is_active=True,
            sort_order=0,
            locked=False,
            is_custom=True,
            section="EXTRA",
            created_by="pytest",
            updated_by="pytest",
        )
    )
    seeded_db.flush()


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


def test_export_endpoint_includes_custom_column_and_hides_it(seeded_db, seeded_client, headers):
    """自定义列出现在导出表头（值注入后成为已登记键），隐藏后消失且不回填英文键。"""
    _finance_rows(seeded_db)
    _seed_custom_field(seeded_db)
    added = seeded_client.post(
        "/api/v1/list-columns/RPT_FINANCE_DIM/custom",
        json={"field_key": "vip_tag", "label": "会员等级"},
        headers=headers,
    )
    assert added.status_code == 200, added.text

    exported = seeded_client.get(
        "/api/v1/reports/finance-dimensions/export.csv", headers=headers
    )
    assert exported.status_code == 200, exported.text
    header = _header(exported.content.decode("utf-8-sig"))
    assert "会员等级" in header
    assert "extra:vip_tag" not in header

    _set_visibility(seeded_client, headers, "RPT_FINANCE_DIM", {"extra:vip_tag"})
    again = seeded_client.get(
        "/api/v1/reports/finance-dimensions/export.csv", headers=headers
    )
    trimmed = _header(again.content.decode("utf-8-sig"))
    assert "会员等级" not in trimmed
    assert "extra:vip_tag" not in trimmed


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


def test_get_value_labels_reads_option_sets_table(seeded_db):
    """映射来自 option_sets 表；未声明 value_set 的列 / scope 返回空。"""
    _seed_option_sets(seeded_db)
    labels = lists_service.get_value_labels(seeded_db, "RPT_FINANCE_DIM")
    assert set(labels) == {"fund_nature", "accounting_attribute", "direction"}
    assert labels["fund_nature"]["BUSINESS"] == "本方经营"
    assert labels["direction"]["IN"] == "收入"
    assert "amount" not in labels
    # 未标注枚举列的 scope 与未知 scope 都不报错
    assert lists_service.get_value_labels(seeded_db, "RPT_MONTHLY_PNL") == {}
    assert lists_service.get_value_labels(seeded_db, "NOPE") == {}


def test_export_endpoint_translates_enum_values(seeded_db, seeded_client, headers):
    """接口闭环：资金属性分析导出的枚举值不再是 BUSINESS / IN / SELF_REVENUE。"""
    _finance_rows(seeded_db)
    _seed_option_sets(seeded_db)
    exported = seeded_client.get(
        "/api/v1/reports/finance-dimensions/export.csv", headers=headers
    )
    assert exported.status_code == 200, exported.text
    rows = list(csv.reader(io.StringIO(exported.content.decode("utf-8-sig"))))
    header = rows[0]
    idx = {name: i for i, name in enumerate(header)}
    items = [row for row in rows[1:] if row[0] == "ITEM"]
    assert items, "应至少有明细行"

    natures = {row[idx["资金性质"]] for row in items}
    directions = {row[idx["现金方向"]] for row in items}
    attributes = {row[idx["核算属性"]] for row in items}
    assert "本方经营" in natures
    assert "BUSINESS" not in natures
    assert directions <= {"收入", "支出"}
    assert "IN" not in directions
    assert "自营收入" in attributes or "自营直接成本" in attributes
    assert "SELF_REVENUE" not in attributes
    # 金额列不受翻译影响，仍是可解析数字
    assert all(row[idx["发生额"]].replace(".", "", 1).isdigit() for row in items)
