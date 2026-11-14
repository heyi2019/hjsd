"""lists.scopes：列表列清单注册表（全站单一事实源）。

与 `orders.form_scopes` 同构：设置页「列表字段」的作用域与列中文名只在这里定义，
经 GET /list-columns 下发；前端不再维护第二份列名清单，避免三处文案漂移。

`locked` 字段保留备用，但**当前所有列均可隐藏与调序**（含身份列/操作列）；
隐藏操作列会失去行内操作入口，可通过「恢复默认」一键找回，属用户自主配置。

`value_set` 声明「这一列的取值是 option_sets 里哪组字典的代码值」（如 ORDER_STATUS）。
列注册表只声明归属，不复制字典文案：导出时由 lists.get_value_labels() 现查 option_sets
表组装「代码值 → 中文」，因此管理员改了可编辑字典，导出口径会跟着变。
没有 value_set 的列（金额/日期/文本）不做值翻译。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ListColumn:
    key: str
    label: str
    locked: bool = False
    value_set: str | None = None


@dataclass(frozen=True)
class ListScope:
    code: str
    label: str
    columns: tuple[ListColumn, ...]


LIST_SCOPES: tuple[ListScope, ...] = (
    ListScope(
        code="LEDGER",
        label="订单台账",
        columns=(
            ListColumn("stock_no", "库存编号"),
            ListColumn("order_no", "订单号"),
            ListColumn("inventory_entry_at", "入库时间"),
            ListColumn("inventory_operator", "入库负责人"),
            ListColumn("cost_amount", "成本"),
            ListColumn("account_game_type", "游戏/产品类型"),
            ListColumn("account_game_account", "游戏账号/产品"),
            ListColumn("sale_at", "售卖时间"),
            ListColumn("sale_operator", "售卖人"),
            ListColumn("sale_amount", "售出金额"),
            ListColumn("in_hand_time", "在手时间"),
            ListColumn("status", "订单状态", value_set="ORDER_STATUS"),
            ListColumn("account_status", "库存状态"),
            ListColumn("profit_base", "利润"),
            ListColumn("trade_date", "日期"),
            ListColumn("actions", "操作"),
        ),
    ),
    ListScope(
        code="INVENTORY",
        label="库存中心",
        columns=(
            ListColumn("stock_no", "库存编号"),
            # 库存中心以订单为列表行；键名必须与 InventoryPanel 的订单级列一致，
            # 否则服务端配置加载后这三列会被当作未知列排到末尾。
            ListColumn("order_no", "订单号"),
            ListColumn("inventory_entry_at", "入库时间"),
            ListColumn("inventory_operator", "入库负责人"),
            ListColumn("cost_amount", "成本"),
            ListColumn("account_game_type", "游戏/产品类型"),
            ListColumn("account_game_account", "游戏账号/产品"),
            ListColumn("business_mode", "业务"),
            ListColumn("inventory_type", "业务类型"),
            ListColumn("inventory_age", "未售时长"),
            ListColumn("status", "状态", value_set="INVENTORY_STATUS"),
            ListColumn("actions", "操作"),
        ),
    ),
    ListScope(
        code="INSTALLMENT",
        label="分期与回款",
        columns=(
            ListColumn("inst_no", "合约号"),
            ListColumn("order", "订单"),
            ListColumn("business", "业务"),
            ListColumn("order_type", "类型"),
            ListColumn("product", "产品"),
            ListColumn("party", "对方"),
            ListColumn("receivable", "总应收"),
            ListColumn("service_fee", "服务费"),
            ListColumn("per_period_service_fee", "每期服务费"),
            ListColumn("paid_amount", "已收"),
            ListColumn("bad_debt", "坏账"),
            ListColumn("remaining", "剩余"),
            ListColumn("status", "状态"),
            ListColumn("actions", "操作"),
        ),
    ),
    ListScope(
        code="CUSTOMER",
        label="客户",
        columns=(
            ListColumn("customer_no", "客户编号"),
            ListColumn("display_name", "名字"),
            ListColumn("phone", "手机"),
            ListColumn("wechat", "微信"),
            ListColumn("qq", "QQ"),
            ListColumn("status", "状态"),
            ListColumn("created_at", "建立时间"),
            ListColumn("extra_values", "扩展字段"),
            ListColumn("actions", "操作"),
        ),
    ),
    ListScope(
        code="REBATE",
        label="返点明细",
        columns=(
            ListColumn("rebate_no", "返点单号"),
            ListColumn("source_order", "来源订单"),
            ListColumn("business", "业务"),
            ListColumn("order_type", "类型"),
            ListColumn("game", "游戏/产品类型"),
            ListColumn("party", "对方"),
            ListColumn("base_amount", "基数"),
            ListColumn("remaining", "可退余额"),
            ListColumn("rate", "费率"),
            ListColumn("created_at", "返点时间"),
            ListColumn("actions", "操作"),
        ),
    ),
    ListScope(
        code="CASHFLOW",
        label="资金流水",
        columns=(
            ListColumn("order_no", "订单号"),
            ListColumn("flow_no", "流水号"),
            ListColumn("occurred_on", "日期"),
            ListColumn("occurred_at", "建立时间"),
            ListColumn("category", "类别"),
            ListColumn("fund_nature", "资金性质"),
            ListColumn("accounting_attribute", "核算属性"),
            ListColumn("direction", "收支"),
            ListColumn("amount", "金额"),
            ListColumn("source", "来源"),
            ListColumn("status", "状态"),
            ListColumn("note", "备注"),
            ListColumn("actions", "操作"),
        ),
    ),
    ListScope(
        code="FUND_POOLS",
        label="资金中心·资金池",
        columns=(
            ListColumn("pool_code", "资金池"),
            ListColumn("ownership", "归属"),
            ListColumn("status", "状态", value_set="POOL_STATUS"),
            ListColumn("income", "收入"),
            ListColumn("expense", "支出"),
            ListColumn("deposit_held", "押金"),
            ListColumn("available", "可用余额"),
        ),
    ),
    ListScope(
        code="DEPOSITS",
        label="资金中心·押金占用",
        columns=(
            ListColumn("paid_amount", "占用金额"),
            ListColumn("counterparty", "对手方"),
            ListColumn("source_order", "来源订单"),
            ListColumn("expected_release_on", "预计释放"),
            ListColumn("returned_amount", "已释放"),
            ListColumn("lost_amount", "已损失"),
            ListColumn("remaining", "剩余"),
            ListColumn("status", "状态", value_set="DEPOSIT_STATUS"),
            ListColumn("actions", "操作"),
        ),
    ),
    ListScope(
        code="RECONCILIATIONS",
        label="资金中心·资金对账",
        columns=(
            ListColumn("pool", "资金池"),
            ListColumn("reconciled_on", "对账日期"),
            ListColumn("account_label", "账户"),
            ListColumn("system_balance", "系统余额"),
            ListColumn("statement_balance", "账面余额"),
            ListColumn("difference", "差异"),
            ListColumn("status", "状态", value_set="RECONCILIATION_STATUS"),
            ListColumn("actions", "操作"),
        ),
    ),
    ListScope(
        code="TRANSFER_ANOMALIES",
        label="资金中心·划转异常",
        columns=(
            ListColumn("transfer_id", "划转号"),
            ListColumn("flow_no", "现有流水"),
            ListColumn("pool", "资金池"),
            ListColumn("direction", "方向"),
            ListColumn("amount", "金额"),
            ListColumn("actions", "操作"),
        ),
    ),
    ListScope(
        code="RPT_MONTHLY_PNL",
        label="报表·月度损益",
        columns=(
            ListColumn("month", "月份"),
            ListColumn("sales_income", "销售收入"),
            ListColumn("account_direct_cost", "账号直接成本"),
            ListColumn("operating_expense", "运营费用"),
            ListColumn("rebate_income", "返点收益"),
            ListColumn("operating_profit", "经营利润"),
        ),
    ),
    ListScope(
        code="RPT_COMMISSION",
        label="报表·分润对账",
        columns=(
            ListColumn("user_id", "人员 ID"),
            ListColumn("order_no", "订单号"),
            ListColumn("profit_base", "利润基数"),
            ListColumn("rate", "费率"),
            ListColumn("payable", "应付"),
            ListColumn("paid", "已付"),
            ListColumn("difference", "差异"),
        ),
    ),
    ListScope(
        code="RPT_DAILY_FUNDS",
        label="报表·资金日报",
        columns=(
            ListColumn("pool_name", "资金池"),
            # 同一行 pool_name 被页面重复渲染成「名称」列，这里用独立 key 以免两列联动
            ListColumn("pool_label", "名称"),
            ListColumn("opening", "期初"),
            ListColumn("income", "收入"),
            ListColumn("expense", "支出"),
            ListColumn("deposit_held", "押金占用"),
            ListColumn("cash_balance", "现金余额"),
            ListColumn("available", "可用余额"),
        ),
    ),
    ListScope(
        code="RPT_FINANCE_DIM",
        label="报表·资金属性分析",
        columns=(
            ListColumn("pool_name", "资金池"),
            ListColumn("fund_nature", "资金性质", value_set="FUND_FLOW_FUND_NATURE"),
            ListColumn("accounting_attribute", "核算属性", value_set="FUND_FLOW_ACCOUNTING_ATTRIBUTE"),
            ListColumn("direction", "现金方向", value_set="FUND_FLOW_DIRECTION"),
            ListColumn("flow_count", "笔数"),
            ListColumn("amount", "发生额"),
            ListColumn("signed_amount", "净方向金额"),
        ),
    ),
    ListScope(
        code="RPT_BUSINESS_PNL",
        label="报表·业务损益",
        columns=(
            ListColumn("order_type", "业务", value_set="ORDER_BUSINESS"),
            ListColumn("main_income", "主营收入"),
            ListColumn("main_cost", "主营成本"),
            ListColumn("main_profit", "主营毛利"),
        ),
    ),
    ListScope(
        code="RPT_ORDER_PROFIT",
        label="报表·订单利润明细",
        columns=(
            ListColumn("order_no", "订单号"),
            ListColumn("order_type", "业务", value_set="ORDER_BUSINESS"),
            ListColumn("trade_date", "成交日"),
            ListColumn("status", "状态", value_set="ORDER_STATUS"),
            ListColumn("income", "收入"),
            ListColumn("buy_amount", "账号采购成本"),
            ListColumn("direct_cost", "直接成本"),
            ListColumn("rebate", "返点"),
            ListColumn("net_profit", "净利"),
        ),
    ),
    ListScope(
        code="POOL_BALANCE",
        label="数据中心·资金池概览",
        columns=(
            ListColumn("pool_code", "资金池"),
            ListColumn("status", "状态"),
            ListColumn("income", "收入"),
            ListColumn("expense", "支出"),
            ListColumn("deposit_held", "押金"),
            ListColumn("available", "可用余额"),
        ),
    ),
    ListScope(
        code="AUDIT_LOG",
        label="审计记录",
        columns=(
            ListColumn("occurred_at", "时间"),
            ListColumn("actor", "操作人"),
            ListColumn("action", "动作"),
            ListColumn("entity_type", "对象类型"),
            ListColumn("entity_id", "对象编号"),
            ListColumn("reason", "原因"),
        ),
    ),
    ListScope(
        code="QUALITY_METRIC",
        label="质量·月度指标",
        columns=(
            ListColumn("month", "月份"),
            ListColumn("reconciliation_completion_rate", "对账完成率"),
            ListColumn("overdue_rate", "分期逾期率"),
            ListColumn("missing_attachment_rate", "缺附件率"),
        ),
    ),
    ListScope(
        code="QUALITY_ISSUE",
        label="质量·问题工单",
        columns=(
            ListColumn("issue_no", "工单号"),
            ListColumn("severity", "级别"),
            ListColumn("title", "标题"),
            ListColumn("target", "对象"),
            ListColumn("status", "状态"),
            ListColumn("message", "问题"),
            ListColumn("actions", "操作"),
        ),
    ),
)

SCOPE_MAP: dict[str, ListScope] = {scope.code: scope for scope in LIST_SCOPES}


def get_scope(code: str) -> ListScope | None:
    return SCOPE_MAP.get(code)


# 报表导出（GET /reports/{name}/export.csv）与列配置的桥：报表名 → 列作用域。
# 导出据此只导「当前可见列」，并沿用注册表里的中文表头与顺序，
# 使「界面看到的列」与「导出的列」是同一份口径。
REPORT_COLUMN_SCOPES: dict[str, str] = {
    "monthly-pnl": "RPT_MONTHLY_PNL",
    "commission": "RPT_COMMISSION",
    "daily-funds": "RPT_DAILY_FUNDS",
    "finance-dimensions": "RPT_FINANCE_DIM",
    "business-pnl": "RPT_BUSINESS_PNL",
    "order-profit": "RPT_ORDER_PROFIT",
}


def report_scope(report_name: str) -> ListScope | None:
    """报表名对应的列作用域（大小写/空白不敏感）；未登记返回 None。"""
    return get_scope(REPORT_COLUMN_SCOPES.get(report_name.strip().lower(), ""))


__all__ = [
    "LIST_SCOPES",
    "REPORT_COLUMN_SCOPES",
    "SCOPE_MAP",
    "ListColumn",
    "ListScope",
    "get_scope",
    "report_scope",
]
