/** 经营中心：库存 R1 / 月度损益 R2 / 提成对账 R3 / 资金日报 R4 / 业务损益 R5 / 数据中心（RPT-01）。 */
import { Card, Input, Space, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { DataCenterPanel } from "./DataCenterPanel";
import {
  reportsApi,
  type BusinessPnlReport,
  type BusinessPnlRow,
  type CommissionReport,
  type CommissionRow,
  type DailyFundsReport,
  type DailyFundsRow,
  type InventoryHealthReport,
  type InventoryHealthRow,
  type MonthlyPnlReport,
  type MonthlyPnlRow,
  type OrderProfitReport,
  type OrderProfitRow,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import { ORDER_TYPE_LABEL } from "../shared/lib/labels";
import {
  DataTable,
  ErrorBanner,
  MoneyText,
  StatRow,
  StatusTag,
} from "../shared/ui";

export function ReportsPage({ onNavigate }: { onNavigate?: (key: string) => void }) {
  return (
    <section className="ui-stack">
      <Tabs
        defaultActiveKey="r1"
        items={[
          { key: "r1", label: "库存 R1", children: <InventoryReport /> },
          { key: "r2", label: "月度损益 R2", children: <MonthlyPnl /> },
          { key: "r3", label: "提成对账 R3", children: <Commission /> },
          { key: "r4", label: "资金日报 R4", children: <DailyFunds /> },
          { key: "r5", label: "业务损益 R5", children: <BusinessPnl /> },
          { key: "profit", label: "订单利润", children: <OrderProfit /> },
          { key: "data-center", label: "数据中心", children: <DataCenterPanel onNavigate={onNavigate} /> },
        ]}
      />
    </section>
  );
}

/** 所有报表共用的取数/错误态壳：避免每个报表各写一遍 try/catch。 */
function useReport<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    load()
      .then(setData)
      .catch((err) => setError(normalizeError(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}

/** 区间选择用原生日期输入：避免为了一个筛选器把 dayjs 拉成显式依赖。 */
function useRange() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const params: { from?: string; to?: string } = {};
  if (from) params.from = from;
  if (to) params.to = to;
  const picker = (
    <Space size="small">
      <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ui-control-width-date" />
      <span className="muted">至</span>
      <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="ui-control-width-date" />
    </Space>
  );
  return { params, picker };
}


function InventoryReport() {
  const { data, loading, error, reload } = useReport<InventoryHealthReport>(
    () => reportsApi.inventoryHealth(),
    [],
  );
  const columns: ColumnsType<InventoryHealthRow> = [
    { title: "库存编号", dataIndex: "inventory_no", width: 140 },
    { title: "游戏账号", dataIndex: "game_account" },
    { title: "平台", dataIndex: "platform", width: 110 },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} /> },
    { title: "买入", dataIndex: "buy_amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "附加成本", dataIndex: "extra_cost", align: "right", render: (v: string) => <MoneyText value={v} /> },
    {
      title: "占用成本",
      dataIndex: "total_cost",
      align: "right",
      render: (v: string) => <MoneyText value={v} strong />,
    },
    {
      title: "持有天数",
      dataIndex: "holding_days",
      align: "right",
      width: 100,
      render: (days: number | null | undefined, row) => {
        if (days == null) return "-";
        const color = days <= 7 ? "green" : days <= 30 ? "orange" : "red";
        return <StatusTag status={row.status} color={color} label={`${days}天`} />;
      },
    },
  ];
  return (
    <Card className="glass" title="库存健康表 R1">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Note>只统计已采购并进入在库、待售或分期状态的真实占用（RPT-01-01）。</Note>
      <StatRow
        items={[
          { label: "在库账号", kind: "count", amount: String(data?.items.length ?? 0) },
          { label: "占用成本合计", amount: data?.total_cost ?? "-" },
        ]}
      />
      <DataTable<InventoryHealthRow>
        columns={columns}
        rows={data?.items ?? []}
        loading={loading}
        page={1}
        pageSize={10}
        total={data?.items.length ?? 0}
        emptyText="暂无在库账号"
        onPageChange={() => undefined}
      />
    </Card>
  );
}

function MonthlyPnl() {
  const { params, picker } = useRange();
  const { data, loading, error, reload } = useReport<MonthlyPnlReport>(
    () => reportsApi.monthlyPnl(params),
    [params.from, params.to],
  );
  const columns: ColumnsType<MonthlyPnlRow> = [
    { title: "月份", dataIndex: "month", width: 110 },
    { title: "销售收入", dataIndex: "sales_income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "账号直接成本", dataIndex: "account_direct_cost", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "运营费用", dataIndex: "operating_expense", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "净返点", dataIndex: "rebate_net", align: "right", render: (v: string) => <MoneyText value={v} /> },
    {
      title: "经营利润",
      dataIndex: "operating_profit",
      align: "right",
      render: (v: string) => <MoneyText value={v} tone="auto" strong />,
    },
  ];
  return (
    <Card className="glass" title="月度经营损益 R2">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar">{picker}</Space>
      <Note>账号采购成本属直接成本，不计入运营费用，避免双重扣减（RPT-01-02）。</Note>
      <StatRow
        items={[
          { label: "销售收入", amount: data?.total.sales_income ?? "-" },
          { label: "经营利润", amount: data?.total.operating_profit ?? "-", tone: "auto" },
        ]}
      />
      <DataTable<MonthlyPnlRow>
        columns={columns}
        rows={data?.items ?? []}
        loading={loading}
        page={1}
        pageSize={10}
        total={data?.items.length ?? 0}
        emptyText="所选区间无数据"
        onPageChange={() => undefined}
      />
    </Card>
  );
}

function Commission() {
  const { params, picker } = useRange();
  const { data, loading, error, reload } = useReport<CommissionReport>(
    () => reportsApi.commission(params),
    [params.from, params.to],
  );
  const columns: ColumnsType<CommissionRow> = [
    { title: "人员 ID", dataIndex: "user_id", width: 100 },
    { title: "订单号", dataIndex: "order_no", width: 160 },
    { title: "利润基数", dataIndex: "profit_base", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "费率", dataIndex: "rate", align: "right", width: 90 },
    { title: "应付", dataIndex: "payable", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "已付", dataIndex: "paid", align: "right", render: (v: string) => <MoneyText value={v} /> },
    {
      title: "差异",
      dataIndex: "difference",
      align: "right",
      render: (v: string) => <MoneyText value={v} tone="auto" strong />,
    },
  ];
  return (
    <Card className="glass" title="提成对账 R3">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar">{picker}</Space>
      <Note>人员维度可钻取到每一单；应付与已付差异即为待追补金额（RPT-01-03）。</Note>
      <StatRow
        items={[
          { label: "订单数", kind: "count", amount: String(data?.total.order_count ?? 0) },
          { label: "应付合计", amount: data?.total.payable ?? "-" },
          { label: "已付合计", amount: data?.total.paid ?? "-" },
          { label: "差异", amount: data?.total.difference ?? "-", tone: "auto" },
        ]}
      />
      <DataTable<CommissionRow>
        columns={columns}
        rows={data?.items ?? []}
        loading={loading}
        page={1}
        pageSize={10}
        total={data?.items.length ?? 0}
        emptyText="所选区间无提成记录"
        onPageChange={() => undefined}
      />
    </Card>
  );
}

function DailyFunds() {
  const { data, loading, error, reload } = useReport<DailyFundsReport>(
    () => reportsApi.dailyFunds(),
    [],
  );
  const columns: ColumnsType<DailyFundsRow> = [
    { title: "资金池", dataIndex: "pool_name", width: 150 },
    { title: "名称", dataIndex: "pool_name" },
    { title: "期初", dataIndex: "opening", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "收入", dataIndex: "income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "支出", dataIndex: "expense", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "押金占用", dataIndex: "deposit_held", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "现金余额", dataIndex: "cash_balance", align: "right", render: (v: string) => <MoneyText value={v} /> },
    {
      title: "可用余额",
      dataIndex: "available",
      align: "right",
      render: (v: string) => <MoneyText value={v} strong />,
    },
  ];
  return (
    <Card className="glass" title={`资金日报 R4 · ${data?.date ?? ""}`}>
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Note>与 FIN-01 同日口径一致：押金单列，不并入经营收支。</Note>
      <StatRow
        items={[
          { label: "现金余额", amount: data?.total.cash_balance ?? "-" },
          { label: "押金占用", amount: data?.total.deposit_held ?? "-" },
          { label: "可用余额", amount: data?.total.available ?? "-", tone: "auto" },
        ]}
      />
      <DataTable<DailyFundsRow>
        columns={columns}
        rows={data?.items ?? []}
        loading={loading}
        page={1}
        pageSize={10}
        total={data?.items.length ?? 0}
        emptyText="当日无资金流水"
        onPageChange={() => undefined}
      />
    </Card>
  );
}

function BusinessPnl() {
  const { params, picker } = useRange();
  const { data, loading, error, reload } = useReport<BusinessPnlReport>(
    () => reportsApi.businessPnl(params),
    [params.from, params.to],
  );
  const columns: ColumnsType<BusinessPnlRow> = [
    { title: "业务", dataIndex: "order_type", width: 100, render: (v: string) => `${ORDER_TYPE_LABEL[v] ?? v}（${v}）` },
    { title: "主营收入", dataIndex: "main_income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "主营成本", dataIndex: "main_cost", align: "right", render: (v: string) => <MoneyText value={v} /> },
    {
      title: "主营毛利",
      dataIndex: "main_profit",
      align: "right",
      render: (v: string) => <MoneyText value={v} tone="auto" strong />,
    },
    { title: "已结算返点", dataIndex: "settled_rebate", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "未归集返点", dataIndex: "uncollected_rebate", align: "right", render: (v: string) => <MoneyText value={v} /> },
    {
      title: "完整收益",
      dataIndex: "full_income",
      align: "right",
      render: (v: string) => <MoneyText value={v} tone="auto" strong />,
    },
  ];
  return (
    <Card className="glass" title="业务级损益 R5">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar">{picker}</Space>
      <Note>
        完整收益 = 主营毛利 + 已结算净返点；未归集返点独立列示，不摊给业务（REB-01-06）。
      </Note>
      <StatRow
        items={[
          { label: "主营毛利", amount: data?.total.main_profit ?? "-", tone: "auto" },
          { label: "已结算返点", amount: data?.total.settled_rebate ?? "-" },
          { label: "未归集返点", amount: data?.total.uncollected_rebate ?? "-" },
          { label: "完整收益", amount: data?.total.full_income ?? "-", tone: "auto" },
        ]}
      />
      <DataTable<BusinessPnlRow>
        columns={columns}
        rows={data?.items ?? []}
        loading={loading}
        page={1}
        pageSize={10}
        total={data?.items.length ?? 0}
        emptyText="所选区间无业务数据"
        onPageChange={() => undefined}
      />
    </Card>
  );
}

function OrderProfit() {
  const { params, picker } = useRange();
  const { data, loading, error, reload } = useReport<OrderProfitReport>(
    () => reportsApi.orderProfit(params),
    [params.from, params.to],
  );
  const columns: ColumnsType<OrderProfitRow> = [
    { title: "订单号", dataIndex: "order_no", width: 160 },
    { title: "业务", dataIndex: "order_type", width: 90, render: (v: string) => `${ORDER_TYPE_LABEL[v] ?? v}（${v}）` },
    { title: "成交日", dataIndex: "trade_date", width: 110 },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} /> },
    { title: "收入", dataIndex: "income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "直接成本", dataIndex: "direct_cost", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "返点", dataIndex: "rebate", align: "right", render: (v: string) => <MoneyText value={v} /> },
    {
      title: "净利",
      dataIndex: "net_profit",
      align: "right",
      render: (v: string) => <MoneyText value={v} tone="auto" strong />,
    },
  ];
  return (
    <Card className="glass" title="订单利润明细">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar">{picker}</Space>
      <StatRow
        items={[
          { label: "收入合计", amount: data?.total.income ?? "-" },
          { label: "直接成本合计", amount: data?.total.direct_cost ?? "-" },
          { label: "返点合计", amount: data?.total.rebate ?? "-" },
          { label: "净利合计", amount: data?.total.net_profit ?? "-", tone: "auto" },
        ]}
      />
      <DataTable<OrderProfitRow>
        columns={columns}
        rows={data?.items ?? []}
        loading={loading}
        page={1}
        pageSize={10}
        total={data?.items.length ?? 0}
        emptyText="所选区间无订单"
        onPageChange={() => undefined}
      />
    </Card>
  );
}

function Note(props: { children: string }) {
  return (
    <Typography.Paragraph type="secondary" className="muted">
      {props.children}
    </Typography.Paragraph>
  );
}
