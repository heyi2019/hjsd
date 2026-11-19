"""LIST-01 列表列「界面 ↔ 注册表」一致性守卫：每个列表面板渲染的列必须与 `lists.scopes` 逐列同名同序。

为什么需要这条守卫：注册表是导出与设置页的唯一事实源，但界面列是各面板自己写的
`ColumnsType` 字面量。两边一旦漂移，测试全绿也发现不了，实际会出两种事故：**

- 界面有、注册表没有 → 该列在设置页配不了、`/xxx/export.csv` 少一列；
- 注册表有、界面没有 → 导出多出一列界面上根本没有的「幽灵列」。

历史事故（2026-11-03 人工审计，21 个作用域查出 4 处）：客户「建立时间」、流水「建立时间」、
订单利润「账号采购成本」漏登记；返点「状态」是幽灵列。

做法：静态解析前端面板源码 —— 定位 `useListViewColumns("<SCOPE>")` 锚点（可能与列数组
分居两个文件，如列定义拆到工厂时），再找之后的第一处 `= [` 数组字面量，按顶层逗号切成列定义，
取 `key:`（优先，派生列的 key 与 dataIndex 不同）否则 `dataIndex:`，取 `title:` 作中文名；
然后与注册表**逐列比对 key 与中文名**。

刻意不覆盖的部分：**自定义列**（`list_custom_columns`）是运行时数据，源码里没有，
按设计只存在于库与接口返回中，不参与本守卫。

解析不到就报错，不静默跳过 —— 假绿比没有守卫更糟。新增面板要在此处登记 `PANEL_SOURCES`。
"""
from __future__ import annotations

import re

import pytest

from app.settings.lists.scopes import LIST_SCOPES, get_scope
import _repo  # 仓库根解析：向上找 pytest.ini，避免写死 parents[N]

_FRONTEND_SRC = _repo.FRONTEND_DIR / "src"

# 作用域 → 渲染该列表的面板源文件（相对 frontend/src），或 (锚点文件, 列数组文件) 二元组。
# 同一文件承载多个列表时（报表 7 个），靠 useListViewColumns 标记定位各自的列数组；
# 列数组被拆到独立工厂且锚点仍留在调用方时（INSTALLMENT），用二元组分别指定两处。
PANEL_SOURCES: dict[str, str | tuple[str, str]] = {
    # 前四轮拆分把列定义下沉到专用 hook 文件；面板壳只剩编排，标记必须跟随列数组。
    "LEDGER": "business/orderpage/useLedgerColumns.tsx",
    "INVENTORY": "business/stocks/InventoryPanel/useInventoryColumns.tsx",
    # 列数组拆到 contractColumns 工厂，useListViewColumns 锚点仍在 controller —— 两文件分离。
    "INSTALLMENT": (
        "finance/installments/useContractTableController.tsx",
        "finance/installments/contractColumns.tsx",
    ),
    "CUSTOMER": "customer-center/useCustomerController.tsx",
    "COUNTERPARTY": "customer-center/CounterpartyPanel.tsx",
    "LEAD": "customer-center/CustomerLeadPanel.tsx",
    # 资金中心 5 个 Tab 已拆到 funds-tabs/ 子文件，锚点与列数组同处各自 Tab。
    "CASHFLOW": "pools/funds-tabs/cashflow.tsx",
    "FUND_POOLS": "pools/funds-tabs/overview.tsx",
    "DEPOSITS": "pools/funds-tabs/deposit.tsx",
    "RECONCILIATIONS": "pools/funds-tabs/reconciliation.tsx",
    "AUDIT_LOG": "audit/AuditPanel.tsx",
    # 报表视图已从 ReportsPage.tsx 拆到 ./reports/*.tsx（壳文件只剩 Tab 与批量导出），
    # 列定义在各子文件里，映射必须落到子文件，否则这条守卫对 7 张报表形同不存在。
    "RPT_MONTHLY_PNL": "reporting/reports/MonthlyPnlReport.tsx",
    "RPT_BUSINESS_PNL": "reporting/reports/BusinessPnlReport.tsx",
    "RPT_ORDER_PROFIT": "reporting/reports/OrderProfitReport.tsx",
}

# 返点仍有 CSV 导出作用域，但前端只在订单详情弹窗中展示关联明细，
# 该明细表不是独立列表，且列口径不同于导出字段；分润对账同理，页面展示订单汇总、
# 导出展示展开后的人员明细。两者都不纳入列表页一对一静态一致性守卫。
NON_UI_SCOPES = {"REBATE", "RPT_COMMISSION"}

_ARRAY_DECL = re.compile(r"=\s*\[")


def _array_body(text: str, start: int) -> str:
    """返回 `[` 起到配对 `]` 之间的正文（跳过字符串里的括号）。"""
    depth = 0
    quote: str | None = None
    escape = False
    for index in range(start, len(text)):
        char = text[index]
        if quote:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == quote:
                quote = None
            continue
        if char in "\"'`":
            quote = char
        elif char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                return text[start + 1 : index]
    raise AssertionError("列数组没有闭合的 `]`")


def _split_items(body: str) -> list[str]:
    """按顶层逗号切出数组元素（括号/花括号/字符串内部不切）。"""
    items: list[str] = []
    buffer: list[str] = []
    depth = 0
    quote: str | None = None
    escape = False
    for char in body:
        if quote:
            buffer.append(char)
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == quote:
                quote = None
            continue
        if char in "\"'`":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        if char == "," and depth == 0:
            items.append("".join(buffer))
            buffer = []
            continue
        buffer.append(char)
    tail = "".join(buffer).strip()
    if tail:
        items.append(tail)
    return [item.strip() for item in items if item.strip()]


def _collect_columns(items: list[str], found: list[tuple[str, str | None]]) -> None:
    """递归收集列定义；`...(cond ? [] : [{...}])` 这类条件列展开后再取。"""
    for item in items:
        if item.startswith("..."):
            for match in re.finditer(r"\[", item):
                _collect_columns(_split_items(_array_body(item, match.start())), found)
            continue
        key = re.search(r'\bkey:\s*"([^"]+)"', item) or re.search(
            r'dataIndex:\s*"([^"]+)"', item
        )
        label = re.search(r'title:\s*"([^"]+)"', item)
        assert key, f"读不出列键（列定义写法超出解析器能力，请调整本测试）：{item[:160]}"
        found.append((key.group(1), label.group(1) if label else None))


def panel_columns(scope: str) -> list[tuple[str, str | None]]:
    """按源码顺序返回该作用域在界面上的 [(列 key, 中文名)]。

    锚点后可能有非列数组（如筛选下拉的分组选项），逐个尝试：
    跳过解析不出列键的数组，取第一个全部条目都带 key/dataIndex 的。
    """
    source = PANEL_SOURCES[scope]
    anchor_file, columns_file = source if isinstance(source, tuple) else (source, source)
    anchor_text = (_FRONTEND_SRC / anchor_file).read_text(encoding="utf-8")
    marker = f'useListViewColumns("{scope}")'
    anchor = anchor_text.find(marker)
    assert anchor >= 0, f"{anchor_file} 里没有 {marker}：作用域改名或面板换实现时要同步本测试"
    # 列数组与锚点同文件时从锚点后找；分离时列数组文件从头找。
    text = anchor_text if columns_file == anchor_file else (_FRONTEND_SRC / columns_file).read_text(encoding="utf-8")
    search_from = anchor if columns_file == anchor_file else 0
    errors: list[str] = []
    for declaration in _ARRAY_DECL.finditer(text, search_from):
        found: list[tuple[str, str | None]] = []
        try:
            _collect_columns(_split_items(_array_body(text, declaration.end() - 1)), found)
        except AssertionError as exc:
            errors.append(str(exc))
            continue
        if found:
            return found
    assert False, f"{columns_file} 里 {marker} 之后没找到可解析的列数组；最近一次解析错误：{errors[-1] if errors else '无'}"


def test_frontend_source_available() -> None:
    """守卫依赖前端源码在场；读不到就明确失败，而不是悄悄跳过。"""
    assert _FRONTEND_SRC.is_dir(), f"找不到前端源码目录：{_FRONTEND_SRC}"


def test_installment_table_exposes_operator_column() -> None:
    """分期台必须把合约创建操作人纳入可配置列表列。"""
    scope = get_scope("INSTALLMENT")
    assert scope is not None
    assert any(column.key == "operator" and column.label == "操作人" for column in scope.columns)


def test_counterparty_table_exposes_creator_column() -> None:
    """合作方列表必须把创建操作人纳入可配置列。"""
    scope = get_scope("COUNTERPARTY")
    assert scope is not None
    assert any(column.key == "created_by" and column.label == "创建操作人" for column in scope.columns)


def test_lead_table_exposes_operator_column() -> None:
    """客户需求列表必须把创建操作人纳入可配置列。"""
    scope = get_scope("LEAD")
    assert scope is not None
    assert any(column.key == "created_by" and column.label == "创建操作人" for column in scope.columns)


def test_every_registered_scope_has_a_panel() -> None:
    """可渲染列表必须登记面板；导出专用作用域显式列入例外。"""
    registered = {scope.code for scope in LIST_SCOPES} - NON_UI_SCOPES
    missing = sorted(registered - set(PANEL_SOURCES))
    stale = sorted(set(PANEL_SOURCES) - registered)
    assert not missing, f"注册表有作用域没登记面板来源：{missing}"
    assert not stale, f"面板来源登记了已不存在的作用域：{stale}"


@pytest.mark.parametrize("scope_code", [scope.code for scope in LIST_SCOPES if scope.code not in NON_UI_SCOPES])
def test_panel_columns_match_registry(scope_code: str) -> None:
    """界面列必须与注册表逐列同 key、同中文名、同顺序。

    顺序也要比：注册表顺序同时是「设置页默认顺序」与「导出列序」，
    界面顺序和它不同，用户看到的表与导出的表就对不上。
    """
    scope = get_scope(scope_code)
    assert scope is not None
    expected = [(column.key, column.label) for column in scope.columns]
    actual = panel_columns(scope_code)

    actual_keys = [key for key, _label in actual]
    expected_keys = [key for key, _label in expected]
    assert actual_keys == expected_keys, (
        f"{scope_code} 界面列与注册表不一致：\n"
        f"  界面有注册表无（导出会少列）：{sorted(set(actual_keys) - set(expected_keys))}\n"
        f"  注册表有界面无（导出会多幽灵列）：{sorted(set(expected_keys) - set(actual_keys))}\n"
        f"  仅顺序不同时请对齐两者之一，别让界面表与导出表列序漂移"
    )

    label_diff = [
        (key, ui_label, registry_label)
        for (key, ui_label), (_key, registry_label) in zip(actual, expected, strict=True)
        if ui_label is not None and ui_label != registry_label
    ]
    assert not label_diff, (
        f"{scope_code} 设置页列名与界面表头不一致（用户在设置里会找不到这一列）：{label_diff}"
    )
