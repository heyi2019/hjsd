/** 资金中心各 Tab 视图层：overview / cashflows / reconciliations / studio expenses。
 *  每个 Tab 通过 controller 消费 useFundsPageController 暴露的状态与处理器，自身只负责列定义与渲染。 */
import { Card, DatePicker, Input, Space, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import type { ColumnsType } from "antd/es/table";
import { ConfirmButton, DataTable, MoneyText, PermissionButton, Select, StatRow, StatusTag } from "../shared/ui";
import { useListViewColumns } from "../shared/lib/listColumns";
import { formatDateTimeMinute, today } from "../shared/lib/format";
import { configurableLabel, useOptionSet } from "../shared/lib/optionSets";
import {
  ACCOUNTING_ATTRIBUTE_LABEL,
  CASHFLOW_CATEGORY_LABEL,
  FUND_FLOW_SOURCE_LABEL,
  POOL_OWNERSHIP_LABEL,
  RECONCILIATION_STATUS_LABEL,
  STUDIO_EXPENSE_ITEM_SET,
  STUDIO_INCOME_ITEMS,
} from "../shared/lib/labels";
import type { FundsPageController } from "./useFundsPageController";
import type { Cashflow, Deposit, Pool, Reconciliation } from "../shared/api/types/finance";

const LEDGER_TYPE_LABEL: Record<string, string> = {
  BUSINESS: "业务资金",
  STUDIO: "工作室运营",
};

export function OverviewTab({ ctrl }: { ctrl: FundsPageController }) {
  const { pools, balances, totalCash, totalAvailable, totalDeposit, totalOwned, transferForm, setTransferOpen, loading, fundsReady, error } = ctrl;
  const { arrange: arrangeFundPoolColumns } = useListViewColumns("FUND_POOLS");
  const poolColumns: ColumnsType<Pool> = [
    {
      title: "资金账户",
      key: "pool_code",
      dataIndex: "name",
      render: (_v, row) => row.name,
      className: "ui-col-wrap",
      onCell: () => ({ className: "ui-col-wrap" }),
    },
    { title: "归属", dataIndex: "ownership", render: (v: string) => configurableLabel("POOL_OWNERSHIP", v, POOL_OWNERSHIP_LABEL) },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} optionSet="POOL_STATUS" /> },
    { title: "收入", key: "income", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.income} /> },
    { title: "支出", key: "expense", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.expense} /> },
    { title: "押金", key: "deposit_held", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.deposit_held} /> },
    { title: "可用余额", key: "available", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.available} strong /> },
  ];
  return (
    <Card
      className="glass"
      title="资金账户卡片"
      extra={
        <PermissionButton permission="finance.transfer" type="primary" disabled={!fundsReady || loading || Boolean(error)} onClick={() => { transferForm.setFieldsValue({ occurred_on: today() }); setTransferOpen(true); }}>
          资金账户划转
        </PermissionButton>
      }
    >
      <StatRow
        items={[
          { label: "现金头寸合计", amount: totalCash },
          { label: "可用余额合计", amount: totalAvailable },
          { label: "押金占用", amount: totalDeposit },
          { label: "自有权益合计", amount: totalOwned },
        ]}
      />
      <DataTable<Pool>
        columns={arrangeFundPoolColumns(poolColumns)}
        rows={pools}
        page={1}
        pageSize={10}
        total={pools.length}
        emptyText={error ? "资金数据不可用，请点击重新加载" : "尚未配置资金账户"}
        loading={loading}
        onPageChange={() => undefined}
      />
    </Card>
  );
}
export function CashflowTab({ ctrl }: { ctrl: FundsPageController }) {
  const {
    cashflows, cashflowKeyword, setCashflowKeyword, pools, cashflowPoolId, setCashflowPoolId,
    cashflowDirection, setCashflowDirection,
    cashflowLedgerType, setCashflowLedgerType,
    cashflowAttribute, setCashflowAttribute, cashflowCategory, setCashflowCategory, cashflowFrom, setCashflowFrom,
    cashflowTo, setCashflowTo, flowDirectionOptions, flowAttributeOptions,
    fetchCashflows, exportCashflows, cashflowExporting, cashflowTotal, totalFlowIncome, totalFlowExpense,
    cashflowForm, setCashflowOpen, reverseForm, setReverseTarget, loading, cashflowsReady, error,
  } = ctrl;
  const cashflowUnavailable = !cashflowsReady || Boolean(error);
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
        <DatePicker.RangePicker
          aria-label="流水日期区间"
          placeholder={["开始日期", "结束日期"]}
          format="YYYY-MM-DD"
          size="small"
          placement="bottomLeft"
          classNames={{ popup: { root: "compact-date-range-picker" } }}
          value={cashflowFrom && cashflowTo ? [dayjs(cashflowFrom), dayjs(cashflowTo)] : null}
          onChange={(value) => {
            setCashflowFrom(value?.[0] ? value[0].format("YYYY-MM-DD") : "");
            setCashflowTo(value?.[1] ? value[1].format("YYYY-MM-DD") : "");
          }}
        />
        <PermissionButton permission="finance.read" onClick={() => void fetchCashflows()}>查询</PermissionButton>
        <PermissionButton permission="finance.read" size="small" loading={cashflowExporting} onClick={() => void exportCashflows()}>
          导出
        </PermissionButton>
      </div>
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
        rows={cashflows}
        page={1}
        pageSize={10}
        total={cashflows.length}
        emptyText={cashflowUnavailable ? "资金流水数据不可用，请点击重新加载" : "暂无资金流水"}
        loading={loading}
        onPageChange={() => undefined}
      />
    </Card>
  );
}
export function DepositSection({ ctrl }: { ctrl: FundsPageController }) {
  const { deposits, employees, openDepositCreate, openDepositEdit, deleteDeposit, returnForm, setReturnTarget, lossForm, setLossTarget, cancelForm, setCancelTarget, loading } = ctrl;
  const { arrange: arrangeDepositColumns } = useListViewColumns("DEPOSITS");
  const depositColumns: ColumnsType<Deposit> = [
    { title: "占用金额", dataIndex: "paid_amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "对手方", key: "counterparty", render: (_v, row) => row.counterparty_id == null ? "—" : `#${row.counterparty_id}` },
    { title: "来源订单", key: "source_order", render: (_v, row) => row.source_order_id == null ? "—" : `#${row.source_order_id}` },
    { title: "预计释放", dataIndex: "expected_release_on", render: (v: string | null | undefined) => v || "—" },
    { title: "已释放", dataIndex: "returned_amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "已损失", dataIndex: "lost_amount", align: "right", render: (v: string | null | undefined) => <MoneyText value={v ?? "0.00"} /> },
    { title: "剩余", key: "remaining", align: "right", render: (_v, row) => (<MoneyText value={row.remaining_amount} />) },
    { title: "状态", dataIndex: "status", width: 110, render: (v: string) => <StatusTag status={v} optionSet="DEPOSIT_STATUS" /> },
    { title: "操作人", dataIndex: "operator", render: (v: string | null | undefined) => v || "—" },
    {
      title: "动作操作人",
      key: "operation_operators",
      render: (_v, row) => (row.operation_operators ?? []).map((operation) => {
        const names = operation.operator_user_ids.map((id) => employees.find((employee) => employee.id === id)?.display_name ?? `#${id}`);
        return `${operation.operation_key}: ${names.join("、")}`;
      }).join("；") || "—",
    },
    {
      title: "操作",
      width: 360,
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={row.status !== "PAID"}
            onClick={() => openDepositEdit(row)}
          >
            编辑
          </PermissionButton>
          <ConfirmButton
            permission="deposit.post"
            size="small"
            danger
            disabled={row.status !== "PAID"}
            title="删除押金占用"
            description="仅未发生释放或损失的押金可以删除，删除后会同步移除对应的占用流水且不可恢复。"
            okText="确认删除"
            onConfirm={() => deleteDeposit(row.id)}
          >
            删除
          </ConfirmButton>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={row.status === "RETURNED" || row.status === "LOST" || row.status === "CANCELLED"}
            onClick={() => { setReturnTarget(row); returnForm.setFieldsValue({ released_on: today() }); }}
          >
            释放
          </PermissionButton>
          <PermissionButton
            permission="deposit.post"
            size="small"
            disabled={row.status === "RETURNED" || row.status === "LOST" || row.status === "CANCELLED"}
            onClick={() => { setLossTarget(row); lossForm.setFieldsValue({ lost_on: today() }); }}
          >
            登记损失
          </PermissionButton>
          <PermissionButton
            permission="deposit.post"
            size="small"
            danger
            disabled={row.status !== "PAID"}
            onClick={() => { setCancelTarget(row); cancelForm.setFieldsValue({ cancelled_on: today() }); }}
          >
            取消
          </PermissionButton>
        </Space>
      ),
    },
  ];
  return (
    <Card
      className="glass"
      title="押金占用"
      extra={
        <PermissionButton permission="deposit.post" type="primary" onClick={openDepositCreate}>
          新增占用
        </PermissionButton>
      }
    >
      <DataTable<Deposit>
        columns={arrangeDepositColumns(depositColumns)}
        rows={deposits}
        page={1}
        pageSize={10}
        total={deposits.length}
        emptyText="暂无押金占用"
        loading={loading}
        onPageChange={() => undefined}
      />
    </Card>
  );
}
export function ReconciliationTab({ ctrl }: { ctrl: FundsPageController }) {
  const { reconciliations, pools, employees, reconciliationForm, setReconciliationOpen, loading, reconciliationsReady, error } = ctrl;
  const reconciliationUnavailable = !reconciliationsReady || Boolean(error);
  const { arrange: arrangeReconciliationColumns } = useListViewColumns("RECONCILIATIONS");
  const reconciliationColumns: ColumnsType<Reconciliation> = [
    { title: "资金账户", key: "pool", render: (_v, row) => pools.find((pool) => pool.id === row.pool_id)?.name ?? row.pool_id },
    { title: "对账日期", dataIndex: "reconciled_on" },
    { title: "账户", dataIndex: "account_label" },
    { title: <Tooltip title="期初余额（账户级对账）+ 截至对账日已入账流水">系统余额</Tooltip>, key: "system_balance", align: "right", render: (_v, row) => <MoneyText value={row.system_balance} /> },
    { title: "账面余额", key: "statement_balance", align: "right", render: (_v, row) => <MoneyText value={row.statement_balance} /> },
    { title: "差异", key: "difference", align: "right", render: (_v, row) => <MoneyText value={row.difference} /> },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={configurableLabel("RECONCILIATION_STATUS", v, RECONCILIATION_STATUS_LABEL)} /> },
    { title: "操作人", dataIndex: "operator", render: (v: string | null | undefined) => v || "—" },
    {
      title: "动作操作人",
      key: "operation_operators",
      render: (_v, row) => (row.operation_operators ?? []).map((operation) => {
        const names = operation.operator_user_ids.map((id) => employees.find((employee) => employee.id === id)?.display_name ?? `#${id}`);
        return `${operation.operation_key}: ${names.join("、")}`;
      }).join("；") || "—",
    },
    {
      title: "操作",
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          {row.status === "OPEN" ? (
            <PermissionButton permission="deposit.post" size="small" onClick={() => ctrl.setResolveTarget(row)}>核销</PermissionButton>
          ) : null}
        </Space>
      ),
    },
  ];
  return (
    <Card className="glass" title="资金对账" extra={<PermissionButton permission="deposit.post" type="primary" disabled={reconciliationUnavailable || loading} onClick={() => { reconciliationForm.setFieldsValue({ reconciled_on: today() }); setReconciliationOpen(true); }}>新增对账</PermissionButton>}>
      <Typography.Text type="secondary">系统余额口径：截至对账日期「已入账」流水的累计 = 期初余额 + 截至对账日已入账流水</Typography.Text>
      <DataTable<Reconciliation>
        columns={arrangeReconciliationColumns(reconciliationColumns)}
        rows={reconciliations}
        page={1}
        pageSize={10}
        total={reconciliations.length}
        emptyText={reconciliationUnavailable ? "资金对账数据不可用，请点击重新加载" : "暂无对账记录"}
        loading={loading}
        pagination={error ? false : undefined}
        onPageChange={() => undefined}
      />
    </Card>
  );
}
