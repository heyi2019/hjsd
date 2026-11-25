import { SearchInput } from "../../shared/ui/SearchInput";
import { TimeOrderControl } from "../../shared/ui/TimeOrderControl";
import { ToolbarSelect } from "../../shared/ui/ToolbarSelect";
/** 资金明细 Tab：从 FinancePage.tabs.tsx 拆出，函数体与拆前逐字等价。 */
import { Card, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DataTable, ErrorBanner, ExportButton, MoneyText, StatRow } from "../../shared/ui";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { formatDateTimeMinute } from "../../shared/lib/format";
import { configurableLabel, useOptionSet } from "../../shared/lib/optionSets";
import {
  ACCOUNTING_ATTRIBUTE_LABEL,
  CASHFLOW_CATEGORY_LABEL,
  FUND_FLOW_SOURCE_LABEL,
  STUDIO_EXPENSE_ITEM_SET,
  STUDIO_INCOME_ITEMS,
} from "../../shared/lib/labels";
import type { FinancePageController } from "../useFinancePageController";
import type { Cashflow } from "../../shared/api/types/finance";
import { BusinessPeriodPicker } from "../../shared/ui/BusinessPeriodPicker";
import type { PeriodState } from "../../shared/state/businessPeriod";

const LEDGER_TYPE_LABEL: Record<string, string> = {
  BUSINESS: "业务资金",
  STUDIO: "工作室运营",
};

export function CashflowTab({ ctrl, periodState }: { ctrl: FinancePageController; periodState: PeriodState }) {
  const {
    cashflowSortDesc, setCashflowSortDesc,
    cashflows, cashflowKeyword, setCashflowKeyword, pools, cashflowPoolId, setCashflowPoolId,
    cashflowDirection, setCashflowDirection,
    cashflowLedgerType, setCashflowLedgerType,
    cashflowAttribute, setCashflowAttribute, cashflowCategory, setCashflowCategory, flowDirectionOptions, flowAttributeOptions,
    fetchCashflows, exportCashflows, cashflowExporting, cashflowTotal, cashflowPage, cashflowPageSize, setCashflowPage, totalFlowIncome, totalFlowExpense,
    fundsReady, cashflowsReady, cashflowLoading, cashflowError,
  } = ctrl;
  const viewLoading = cashflowLoading || (!cashflowsReady && !cashflowError && !periodState.error);
  const cashflowUnavailable = !cashflowsReady || Boolean(cashflowError);
  const filtersDisabled = Boolean(cashflowError) || (!cashflowsReady && !cashflowLoading);
  const { arrange: arrangeCashflowColumns } = useListViewColumns("CASHFLOW");
  // 类别筛选下拉：业务类别=系统固定枚举；工作室类别=支出科目词典（可配置）+ 固定收入科目。
  // value 用 category 原文，与后端精确匹配（Cashflow.category == category）对齐。
  const studioExpenseItems = useOptionSet(STUDIO_EXPENSE_ITEM_SET);
  const cashflowCategoryOptions = [
    {
      label: "业务类别",
      options: Object.entries(CASHFLOW_CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
    },
    {
      label: "工作室类别",
      options: [
        ...(studioExpenseItems ?? []).map((item) => ({ value: item.value, label: item.label })),
        ...STUDIO_INCOME_ITEMS.map((item) => ({ value: item.value, label: item.label })),
      ],
    },
  ];
  const cashflowColumns: ColumnsType<Cashflow> = [
    { title: "账簿", dataIndex: "ledger_type", render: (v: string) => LEDGER_TYPE_LABEL[v] ?? v },
    { title: "资金账户", key: "pool_name", render: (_v, row) => (fundsReady ? pools.find((pool) => pool.id === row.pool_id)?.name : undefined) ?? `账户 ${row.pool_id}` },
    { title: "订单号", dataIndex: "order_no", render: (v: string | null) => v || "—" },
    { title: "流水号", dataIndex: "flow_no" },
    { title: "日期", dataIndex: "occurred_on" },
    { title: "建立时间", dataIndex: "occurred_at", render: (v: string | null | undefined) => formatDateTimeMinute(v) },
    { title: "类别", dataIndex: "category", render: (v: string) => CASHFLOW_CATEGORY_LABEL[v] ?? studioExpenseItems?.find((item) => item.value === v)?.label ?? STUDIO_INCOME_ITEMS.find((item) => item.value === v)?.label ?? v },
    {
      title: "核算属性",
      dataIndex: "accounting_attribute",
      render: (v: string | null | undefined) => ACCOUNTING_ATTRIBUTE_LABEL[v ?? ""] ?? v ?? "—",
    },
    {
      title: "收支",
      dataIndex: "direction",
      render: (v: string) => (v === "IN" ? "收入" : "支出"),
    },
    { title: "金额", dataIndex: "amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "来源", dataIndex: "source", render: (v: string | null | undefined) => configurableLabel("FUND_FLOW_SOURCE", v, FUND_FLOW_SOURCE_LABEL) },
    { title: "操作人", dataIndex: "operator", render: (v: string | null | undefined) => v || "—" },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v || "—" },

  ];
  return (
    <Card className="glass" title="资金明细">
      <div className="ui-filter-bar finance-cashflow-filters">
        <SearchInput className="ui-filter-search" aria-label="流水搜索" searchButtonLabel="搜索流水" onSearch={(_value, _event, info) => { if (info?.source !== "clear") ctrl.submitCashflowSearch(); }} allowClear value={cashflowKeyword} placeholder="搜索订单号 / 流水号 / 类别 / 备注 / 金额" onChange={(event) => setCashflowKeyword(event.target.value)} />
        <BusinessPeriodPicker label="流水日期区间" state={periodState} showAll />
        <ToolbarSelect aria-label="流水资金账户" allowClear disabled={filtersDisabled || !fundsReady} value={cashflowPoolId} placeholder="全部资金账户" options={pools.map((pool) => ({ value: pool.id, label: pool.name }))} onChange={setCashflowPoolId} />
        <ToolbarSelect aria-label="流水方向" allowClear disabled={filtersDisabled} value={cashflowDirection} placeholder="全部收支" options={flowDirectionOptions ?? []} onChange={setCashflowDirection} />
        <ToolbarSelect aria-label="流水账簿" allowClear disabled={filtersDisabled} value={cashflowLedgerType || undefined} placeholder="全部账簿" options={Object.entries(LEDGER_TYPE_LABEL).map(([value, label]) => ({ value, label }))} onChange={(value) => setCashflowLedgerType(value ?? "")} />
        <ToolbarSelect aria-label="流水核算属性" allowClear disabled={filtersDisabled} value={cashflowAttribute || undefined} placeholder="全部核算属性" options={flowAttributeOptions ?? []} onChange={(value) => setCashflowAttribute(value ?? "")} />
        <ToolbarSelect
          aria-label="流水中类别筛选"
          showSearch
          optionFilterProp="label"
          allowClear
          disabled={filtersDisabled}
          value={cashflowCategory || undefined}
          placeholder="全部类别"
          options={cashflowCategoryOptions}
          onChange={(value) => setCashflowCategory(value ?? "")}
        />
        <TimeOrderControl descending={cashflowSortDesc} onChange={setCashflowSortDesc} />
        <ExportButton permission="finance.read" disabled={cashflowUnavailable || cashflowLoading} loading={cashflowExporting} onClick={() => void exportCashflows()} />
      </div>
      <ErrorBanner error={cashflowError} onRetry={() => void fetchCashflows()} retrying={cashflowLoading} />
      {viewLoading ? (
        <Typography.Text type="secondary">正在加载资金流水…</Typography.Text>
      ) : cashflowUnavailable ? (
        <Typography.Text type="warning">资金流水数据不可用，请点击“重新加载”。</Typography.Text>
      ) : null}
      <StatRow
        items={[
          { label: "总收入", amount: viewLoading ? null : cashflowUnavailable ? "不可用" : totalFlowIncome },
          { label: "总支出", amount: viewLoading ? null : cashflowUnavailable ? "不可用" : totalFlowExpense, hint: "流水毛额，包含冲销和押金损失重分类，与实际现金支出可能不同" },
          { label: "当前结果", kind: "count", amount: viewLoading ? null : cashflowUnavailable ? "不可用" : cashflowTotal },
        ]}
      />
      <DataTable<Cashflow>
        columns={arrangeCashflowColumns(cashflowColumns)}
        rows={cashflowUnavailable ? [] : cashflows}
        page={cashflowPage}
        pageSize={cashflowPageSize}
        total={cashflowUnavailable ? 0 : cashflowTotal}
        controlledPaging
        emptyText={cashflowUnavailable ? "资金流水数据不可用，请点击重新加载" : "暂无资金流水"}
        loading={viewLoading}
        onPageChange={setCashflowPage}
      />
    </Card>
  );
}
