/** 资金中心各 Tab 视图层：overview / cashflows / reconciliations / controls。
 *  每个 Tab 通过 controller 消费 useFundsPageController 暴露的状态与处理器，自身只负责列定义与渲染。 */
import { Card, Input, Space, Tabs, Tooltip, Typography } from "antd";
import { useMemo, useState } from "react";
import type { ColumnsType } from "antd/es/table";
import { DataTable, MoneyText, PermissionButton, Select, StatRow, StatusTag } from "../shared/ui";
import { useListViewColumns } from "../shared/lib/listColumns";
import { formatDateTimeMinute, today } from "../shared/lib/format";
import { configurableLabel } from "../shared/lib/optionSets";
import {
  POOL_OWNERSHIP_LABEL,
  RECONCILIATION_STATUS_LABEL,
} from "../shared/lib/labels";
import type { FundsPageController } from "./useFundsPageController";
import type { Cashflow, Deposit, Pool, Reconciliation } from "../shared/api/catalog";

export function OverviewTab({ ctrl }: { ctrl: FundsPageController }) {
  const { pools, balances, totalCash, totalAvailable, totalDeposit, totalOwned, transferForm, setTransferOpen, loading, fundsReady, error } = ctrl;
  const { arrange: arrangeFundPoolColumns } = useListViewColumns("FUND_POOLS");
  const hasNegativeAvailable = pools.some((pool) => Number(balances[pool.id]?.available ?? 0) < 0);
  const poolColumns: ColumnsType<Pool> = [
    {
      title: "资金池",
      key: "pool_code",
      dataIndex: "name",
      render: (_v, row) => `${row.name}（${row.code}）`,
      className: "ui-col-wrap",
      onCell: () => ({ className: "ui-col-wrap" }),
    },
    { title: "归属", dataIndex: "ownership", render: (v: string) => POOL_OWNERSHIP_LABEL[v] ?? v },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} optionSet="POOL_STATUS" /> },
    { title: "收入", key: "income", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.income} /> },
    { title: "支出", key: "expense", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.expense} /> },
    { title: "押金", key: "deposit_held", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.deposit_held} /> },
    { title: "可用余额", key: "available", align: "right", render: (_v, row) => <MoneyText value={balances[row.id]?.available} strong /> },
  ];
  return (
    <Card
      className="glass"
      title="资金池卡片"
      extra={
        <PermissionButton permission="finance.transfer" type="primary" disabled={!fundsReady || loading || Boolean(error)} onClick={() => { transferForm.setFieldsValue({ occurred_on: today() }); setTransferOpen(true); }}>
          资金池划转
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
      <Typography.Text type="secondary">自有权益仅计归属为「自有」的池；托管/第三方池只计现金头寸。</Typography.Text>
      {hasNegativeAvailable ? (
        <Typography.Text type="danger" role="alert" className="funds-negative-balance-warning">
          ⚠ 存在负余额资金池，请先处理资金异常。
        </Typography.Text>
      ) : null}
      <DataTable<Pool>
        columns={arrangeFundPoolColumns(poolColumns)}
        rows={pools}
        page={1}
        pageSize={10}
        total={pools.length}
        emptyText={error ? "资金数据不可用，请点击重新加载" : "尚未配置资金池"}
        loading={loading}
        onPageChange={() => undefined}
      />
    </Card>
  );
}

export function CashflowTab({ ctrl }: { ctrl: FundsPageController }) {
  const {
    visibleCashflows, cashflows, cashflowKeyword, setCashflowKeyword, pools, cashflowPoolId, setCashflowPoolId,
    cashflowStatus, setCashflowStatus,
    cashflowCategory, setCashflowCategory, cashflowFrom, setCashflowFrom,
    cashflowTo, setCashflowTo, flowDirectionOptions, flowStatusOptions,
    fetchCashflows, exportCashflows, cashflowExporting, cashflowTotal, totalFlowIncome, totalFlowExpense,
    cashflowForm, setCashflowOpen, reverseForm, setReverseTarget, loading, cashflowsReady, error,
  } = ctrl;
  const [detailDirection, setDetailDirection] = useState<"IN" | "OUT">("IN");
  const cashflowUnavailable = !cashflowsReady || Boolean(error);
  const { arrange: arrangeCashflowColumns } = useListViewColumns("CASHFLOW");
  const cashflowColumns: ColumnsType<Cashflow> = [
    { title: "订单号", dataIndex: "order_no", render: (v: string | null) => v || "—" },
    { title: "流水号", dataIndex: "flow_no" },
    { title: "日期", dataIndex: "occurred_on" },
    { title: "建立时间", dataIndex: "occurred_at", render: (v: string | null | undefined) => formatDateTimeMinute(v) },
    { title: "类别", dataIndex: "category" },
    {
      title: "收支方向",
      dataIndex: "direction",
      render: (v: string) => (v === "IN" ? "收入" : "支出"),
    },
    { title: "金额", dataIndex: "amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    {
      title: "归属",
      key: "scope",
      render: (_value, row) => (row.order_id ? "业务收支" : "工作室收支"),
    },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={configurableLabel("FUND_FLOW_STATUS", v, { APPROVED: "已入账" })} /> },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v || "—" },
    {
      title: "操作",
      key: "actions",
      width: 170,
      render: (_v, row) => (
        <Space size={2}>
          {row.status === "APPROVED" && !row.reversal_of_id && !cashflows.some((flow) => flow.reversal_of_id === row.id) && !row.order_id && !row.deposit_id && !row.transfer_id && !row.order_event_id && (
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
    <Card className="glass" title="全局资金流水" extra={<PermissionButton permission="deposit.post" type="primary" disabled={cashflowUnavailable || loading || !flowDirectionOptions} onClick={() => { cashflowForm.setFieldsValue({ occurred_on: today() }); setCashflowOpen(true); }}>新增流水</PermissionButton>}>
      <div className="ui-filter-bar funds-cashflow-filters">
        <Input aria-label="流水搜索" allowClear value={cashflowKeyword} placeholder="搜索订单号 / 流水号 / 类别 / 备注" onChange={(event) => setCashflowKeyword(event.target.value)} />
        <Select aria-label="流水资金池" allowClear disabled={cashflowUnavailable} value={cashflowPoolId} placeholder="全部资金池" options={pools.map((pool) => ({ value: pool.id, label: pool.name }))} onChange={setCashflowPoolId} />
        <Select aria-label="流水状态" allowClear disabled={cashflowUnavailable} value={cashflowStatus} placeholder="全部状态" options={flowStatusOptions ?? []} onChange={setCashflowStatus} />
        <Input aria-label="流水中类别筛选" allowClear value={cashflowCategory} placeholder="类别，如 REVERSAL" onChange={(event) => setCashflowCategory(event.target.value)} />
        <div className="funds-cashflow-date-range">
          <Input aria-label="流水开始日期" value={cashflowFrom} placeholder="开始日期" onChange={(event) => setCashflowFrom(event.target.value)} />
          <span className="muted">至</span>
          <Input aria-label="流水结束日期" value={cashflowTo} placeholder="结束日期" onChange={(event) => setCashflowTo(event.target.value)} />
        </div>
        <div className="funds-cashflow-actions">
          <PermissionButton permission="finance.read" onClick={() => void fetchCashflows()}>查询</PermissionButton>
          <PermissionButton permission="finance.read" size="small" loading={cashflowExporting} onClick={() => void exportCashflows()}>
            导出 CSV
          </PermissionButton>
        </div>
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
          { label: "当前结果", kind: "count", amount: cashflowUnavailable ? "不可用" : visibleCashflows.length },
        ]}
      />
      <Tabs
        activeKey={detailDirection}
        onChange={(key) => setDetailDirection(key as "IN" | "OUT")}
        items={["IN", "OUT"].map((direction) => {
          const rows = visibleCashflows.filter((row) => row.direction === direction);
          return {
            key: direction,
            label: direction === "IN" ? "收入明细" : "支出明细",
            children: (
              <DataTable<Cashflow>
                columns={arrangeCashflowColumns(cashflowColumns)}
                rows={rows}
                page={1}
                pageSize={10}
                total={rows.length}
                emptyText={cashflowUnavailable ? "资金流水数据不可用，请点击重新加载" : `暂无${direction === "IN" ? "收入" : "支出"}明细`}
                loading={loading}
                onPageChange={() => undefined}
              />
            ),
          };
        })}
      />
    </Card>
  );
}

export function DepositSection({ ctrl }: { ctrl: FundsPageController }) {
  const { deposits, setDepositOpen, returnForm, setReturnTarget, lossForm, setLossTarget, cancelForm, setCancelTarget, loading } = ctrl;
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
    {
      title: "操作",
      width: 270,
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
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
        <PermissionButton permission="deposit.post" type="primary" onClick={() => setDepositOpen(true)}>
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
  const { reconciliations, pools, reconciliationForm, setReconciliationOpen, loading, reconciliationsReady, error } = ctrl;
  const reconciliationUnavailable = !reconciliationsReady || Boolean(error);
  const poolById = useMemo(() => new Map(pools.map((pool) => [pool.id, pool.name])), [pools]);
  const { arrange: arrangeReconciliationColumns } = useListViewColumns("RECONCILIATIONS");
  const reconciliationColumns: ColumnsType<Reconciliation> = [
    { title: "资金池", key: "pool", render: (_v, row) => poolById.get(row.pool_id) ?? row.pool_id },
    { title: "对账日期", dataIndex: "reconciled_on" },
    { title: "账户", dataIndex: "account_label" },
    { title: <Tooltip title="期初余额（账户级对账）+ 截至对账日已入账流水">系统余额</Tooltip>, key: "system_balance", align: "right", render: (_v, row) => <MoneyText value={row.system_balance} /> },
    { title: "账面余额", key: "statement_balance", align: "right", render: (_v, row) => <MoneyText value={row.statement_balance} /> },
    { title: "差异", key: "difference", align: "right", render: (_v, row) => <MoneyText value={row.difference} /> },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={configurableLabel("RECONCILIATION_STATUS", v, RECONCILIATION_STATUS_LABEL)} /> },
    {
      title: "操作",
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          {row.status === "OPEN" ? (
            <PermissionButton permission="finance.read" size="small" onClick={() => ctrl.setUnmatchedTarget(row)}>查看未达流水</PermissionButton>
          ) : null}
          {row.status === "OPEN" ? (
            <PermissionButton permission="deposit.post" size="small" onClick={() => ctrl.setResolveTarget(row)}>核销</PermissionButton>
          ) : null}
        </Space>
      ),
    },
  ];
  return (
    <Card className="glass" title="资金对账" extra={<PermissionButton permission="deposit.post" type="primary" disabled={reconciliationUnavailable || loading} onClick={() => { reconciliationForm.setFieldsValue({ reconciled_on: today() }); setReconciliationOpen(true); }}>新增对账</PermissionButton>}>
      <Typography.Text type="secondary">系统余额口径：截至对账日期「已入账」流水的累计。</Typography.Text>
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

export function ControlsTab({ ctrl }: { ctrl: FundsPageController }) {
  const { transferAnomalies, pools, repairForm, setRepairTarget, loading } = ctrl;
  const poolById = useMemo(() => new Map(pools.map((pool) => [pool.id, pool.name])), [pools]);
  const { arrange: arrangeTransferAnomalyColumns } = useListViewColumns("TRANSFER_ANOMALIES");
  const transferAnomalyColumns: ColumnsType<{ transfer_id: string; flow: Cashflow }> = [
    { title: "划转号", dataIndex: "transfer_id" },
    { title: "现有流水", key: "flow_no", render: (_v, row) => row.flow.flow_no },
    { title: "资金池", key: "pool", render: (_v, row) => poolById.get(row.flow.pool_id) ?? row.flow.pool_id },
    { title: "方向", key: "direction", render: (_v, row) => row.flow.direction === "IN" ? "转入" : "转出" },
    { title: "金额", key: "amount", align: "right", render: (_v, row) => <MoneyText value={row.flow.amount} /> },
    {
      title: "操作",
      key: "actions",
      render: (_v, row) => (
        <PermissionButton permission="finance.transfer" size="small" onClick={() => { repairForm.resetFields(); setRepairTarget(row.flow); }}>修复划转</PermissionButton>
      ),
    },
  ];
  return (
    <div className="ui-stack">
      <Card className="glass" title="单边划转异常">
        <DataTable
          columns={arrangeTransferAnomalyColumns(transferAnomalyColumns)}
          rows={transferAnomalies}
          page={1}
          pageSize={10}
          total={transferAnomalies.length}
          emptyText="暂无单边划转异常"
          loading={loading}
          onPageChange={() => undefined}
        />
      </Card>
    </div>
  );
}
