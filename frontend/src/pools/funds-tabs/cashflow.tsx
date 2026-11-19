/** 资金明细 Tab：从 FundsPage.tabs.tsx 拆出，函数体与拆前逐字等价。 */
import { Card, Input, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ConfirmButton, DataTable, ErrorBanner, MoneyText, PermissionButton, Select, StatRow, StatusTag } from "../../shared/ui";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { formatDateTimeMinute, today } from "../../shared/lib/format";
import { configurableLabel, useOptionSet } from "../../shared/lib/optionSets";
import {
  ACCOUNTING_ATTRIBUTE_LABEL,
  CASHFLOW_CATEGORY_LABEL,
  FUND_FLOW_SOURCE_LABEL,
  STUDIO_EXPENSE_ITEM_SET,
  STUDIO_INCOME_ITEMS,
} from "../../shared/lib/labels";
import type { FundsPageController } from "../useFundsPageController";
import type { Cashflow } from "../../shared/api/types/finance";
import { BusinessPeriodPicker } from "../../shared/ui/BusinessPeriodPicker";
import type { PeriodState } from "../../shared/state/businessPeriod";

const LEDGER_TYPE_LABEL: Record<string, string> = {
  BUSINESS: "业务资金",
  STUDIO: "工作室运营",
};

export function CashflowTab({ ctrl, periodState }: { ctrl: FundsPageController; periodState: PeriodState }) {
  const {
    cashflows, cashflowKeyword, setCashflowKeyword, pools, cashflowPoolId, setCashflowPoolId,
    cashflowDirection, setCashflowDirection,
    cashflowLedgerType, setCashflowLedgerType,
    cashflowAttribute, setCashflowAttribute, cashflowCategory, setCashflowCategory, flowDirectionOptions, flowAttributeOptions,
    fetchCashflows, exportCashflows, cashflowExporting, cashflowTotal, totalFlowIncome, totalFlowExpense,
    cashflowForm, setCashflowOpen, reverseForm, setReverseTarget, loading, cashflowsReady, cashflowLoading, cashflowError, error,
  } = ctrl;
  const cashflowUnavailable = !cashflowsReady || Boolean(error) || Boolean(cashflowError);
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
    { title: "订单号", dataIndex: "order_no", render: (v: string | null) => v || "—" },
    { title: "流水号", dataIndex: "flow_no" },
    { title: "日期", dataIndex: "occurred_on" },
    { title: "建立时间", dataIndex: "occurred_at", render: (v: string | null | undefined) => formatDateTimeMinute(v) },
    { title: "类别", dataIndex: "category", render: (v: string) => CASHFLOW_CATEGORY_LABEL[v] ?? v },
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
    {
      title: "操作",
      key: "actions",
      width: 170,
      render: (_v, row) => (
        <Space size={2}>
          {row.source_type === "MANUAL" && !cashflows.some((flow) => flow.source_type === "REVERSAL" && flow.source_id === row.flow_no) && !row.order_id && (
            <PermissionButton
              permission="deposit.post"
              size="small"
              onClick={() => { reverseForm.setFieldsValue({ reversed_on: today() }); setReverseTarget(row); }}
            >
              冲销
            </PermissionButton>
          )}
        </Space>
      ),
    },
  ];
  return (
    <Card className="glass" title="资金明细" extra={<PermissionButton permission="deposit.post" type="primary" disabled={cashflowUnavailable || loading || !flowDirectionOptions} onClick={() => { cashflowForm.setFieldsValue({ occurred_on: today() }); setCashflowOpen(true); }}>新增流水</PermissionButton>}>
      <div className="ui-filter-bar funds-cashflow-filters">
        <Input aria-label="流水搜索" allowClear value={cashflowKeyword} placeholder="搜索订单号 / 流水号 / 类别 / 备注" onChange={(event) => setCashflowKeyword(event.target.value)} />
        <Select aria-label="流水资金账户" allowClear disabled={cashflowUnavailable} value={cashflowPoolId} placeholder="全部资金账户" options={pools.map((pool) => ({ value: pool.id, label: pool.name }))} onChange={setCashflowPoolId} />
        <Select aria-label="流水方向" allowClear disabled={cashflowUnavailable} value={cashflowDirection} placeholder="全部收支" options={flowDirectionOptions ?? []} onChange={setCashflowDirection} />
        <Select aria-label="流水账簿" allowClear disabled={cashflowUnavailable} value={cashflowLedgerType || undefined} placeholder="全部账簿" options={Object.entries(LEDGER_TYPE_LABEL).map(([value, label]) => ({ value, label }))} onChange={(value) => setCashflowLedgerType(value ?? "")} />
        <Select aria-label="流水核算属性" allowClear disabled={cashflowUnavailable} value={cashflowAttribute || undefined} placeholder="全部核算属性" options={flowAttributeOptions ?? []} onChange={(value) => setCashflowAttribute(value ?? "")} />
        <Select
          aria-label="流水中类别筛选"
          showSearch
          optionFilterProp="label"
          allowClear
          disabled={cashflowUnavailable}
          value={cashflowCategory || undefined}
          placeholder="全部类别"
          options={cashflowCategoryOptions}
          onChange={(value) => setCashflowCategory(value ?? "")}
        />
        <BusinessPeriodPicker label="流水日期区间" state={periodState} showAll />
        <PermissionButton permission="finance.read" loading={cashflowLoading} onClick={() => void fetchCashflows()}>查询</PermissionButton>
        <PermissionButton permission="finance.read" size="small" disabled={cashflowUnavailable || cashflowLoading} loading={cashflowExporting} onClick={() => void exportCashflows()}>
          导出
        </PermissionButton>
      </div>
      <ErrorBanner error={cashflowError} onRetry={() => void fetchCashflows()} retrying={cashflowLoading} />
      {cashflowUnavailable ? (
        <Typography.Text type="warning">资金流水数据不可用，请点击“查询”或页面顶部的“重新加载”。</Typography.Text>
      ) : cashflowTotal > cashflows.length ? (
        <Typography.Text type="warning">
          共匹配 {cashflowTotal} 笔，已加载 {cashflows.length} 笔（单次上限 2000 条，请用日期区间缩小范围）。
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary">共 {cashflowTotal} 笔资金流水。</Typography.Text>
      )}
      <StatRow
        items={[
          { label: "总收入", amount: cashflowUnavailable ? "不可用" : totalFlowIncome },
          { label: "总支出", amount: cashflowUnavailable ? "不可用" : totalFlowExpense },
          { label: "当前结果", kind: "count", amount: cashflowUnavailable ? "不可用" : cashflowTotal },
        ]}
      />
      <DataTable<Cashflow>
        columns={arrangeCashflowColumns(cashflowColumns)}
        rows={cashflowUnavailable ? [] : cashflows}
        page={1}
        pageSize={10}
        total={cashflowUnavailable ? 0 : cashflows.length}
        emptyText={cashflowUnavailable ? "资金流水数据不可用，请点击重新加载" : "暂无资金流水"}
        loading={loading || cashflowLoading}
        onPageChange={() => undefined}
      />
    </Card>
  );
}
