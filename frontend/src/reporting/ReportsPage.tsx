/** 经营中心：库存 R1 / 月度损益 R2 / 提成对账 R3 / 资金日报 R4 / 业务损益 R5 / 数据中心（RPT-01）。 */
import { Card, Input, Select, Space, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { DataCenterPanel } from "./DataCenterPanel";
import { QualityPanel } from "../quality/QualityPanel";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import { SearchPanel } from "../search/SearchPanel";
import { AuditPanel } from "../audit/AuditPanel";
import { AttachmentPanel } from "../attachments/AttachmentPanel";
import {
  reportsApi,
  type BusinessPnlReport,
  type BusinessPnlRow,
  type CommissionReport,
  type CommissionRow,
  type DailyFundsReport,
  type DailyFundsRow,
  type FinanceDimensionReport,
  type FinanceDimensionRow,
  type InventoryHealthReport,
  type InventoryHealthRow,
  type MonthlyPnlReport,
  type MonthlyPnlRow,
  type OrderProfitReport,
  type OrderProfitRow,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { ACCOUNTING_ATTRIBUTE_LABEL, BUSINESS_MODE_LABEL, BUSINESS_TYPE_LABEL, FUND_NATURE_LABEL, ORDER_TYPE_LABEL } from "../shared/lib/labels";
import { useOptionSet } from "../shared/lib/optionSets";
import {
  DataTable,
  ErrorBanner,
  MoneyText,
  StatRow,
  StatusTag,
  PermissionButton,
  useCompactLayout,
} from "../shared/ui";
import { useReloadOnActive } from "../shared/state/reloadOnActive";

const REPORT_NAMES = [
  "inventory-health",
  "monthly-pnl",
  "commission",
  "daily-funds",
  "business-pnl",
  "finance-dimensions",
  "order-profit",
];

const REPORT_LABEL: Record<string, string> = {
  "inventory-health": "库存健康",
  "monthly-pnl": "月度损益",
  commission: "提成对账",
  "daily-funds": "资金日报",
  "business-pnl": "业务损益",
  "finance-dimensions": "资金属性",
  "order-profit": "订单利润",
};

/** 词典未加载时的回落值：顺序与 REPORT_NAMES 一致，保证与改造前零行为变化。 */
const REPORT_FALLBACK = REPORT_NAMES.map((name) => ({ value: name, label: REPORT_LABEL[name] }));

/** 报表视图共用的统计周期筛选：提升到父级，使各带区间筛选的报表在 Tab 切换（非挂载）后仍保留筛选条件。 */
type ReportRange = { params: { from?: string; to?: string }; picker: ReactNode };

/** 通用移动端报表卡片列表：复用各报表已有 columns（title→标签、render/dataIndex→值）。
 * 仅 ≤640px（useCompactLayout）挂载；桌面与 jsdom 测试仅渲染表格，卡片不进 DOM，单测零破坏。 */
type ReportCardColumn<T> = {
  title?: ReactNode;
  dataIndex?: string | string[];
  render?: (value: any, row: T, index: number) => ReactNode;
};

export function MobileReportCards<T>({
  rows,
  columns,
}: {
  rows: readonly T[];
  columns: readonly ReportCardColumn<T>[];
}) {
  return (
    <div className="data-mobile-list">
      {rows.map((row, index) => (
        <article className="data-mobile-card" key={index}>
          <dl className="data-mobile-meta">
            {columns.map((col, i) => {
              const value: ReactNode = col.render
                ? col.render((row as Record<string, unknown>)[col.dataIndex as string], row, index)
                : col.dataIndex
                ? ((row as Record<string, unknown>)[col.dataIndex as string] as ReactNode)
                : null;
              const label = typeof col.title === "string" ? col.title : "";
              return (
                <div key={i}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              );
            })}
          </dl>
        </article>
      ))}
    </div>
  );
}

export function ReportsPage({ onNavigate, active = true }: { onNavigate?: (key: string) => void; active?: boolean }) {
  const reportOptions = useOptionSet("REPORT_NAME") ?? REPORT_FALLBACK;
  const [activeTab, setActiveTab] = useState("r1");
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [selectedReports, setSelectedReports] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  // 报表视图统计周期：提升到父级，避免切换 Tab（非挂载）后筛选条件丢失。
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const reportRange: ReportRange = {
    params: { from: reportFrom || undefined, to: reportTo || undefined },
    picker: (
      <Space size="small">
        <Input type="date" value={reportFrom} onChange={(event) => setReportFrom(event.target.value)} className="ui-control-width-date" />
        <span className="muted">至</span>
        <Input type="date" value={reportTo} onChange={(event) => setReportTo(event.target.value)} className="ui-control-width-date" />
      </Space>
    ),
  };
  const exportSelected = async () => {
    if (selectedReports.length === 0) {
      setExportError("请至少勾选一项报表");
      return;
    }
    setExporting(true);
    let lastError: string | null = null;
    try {
      for (const name of selectedReports) {
        try {
          const blob = await reportsApi.exportCsv(name, { from: exportFrom || undefined, to: exportTo || undefined });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = `${name}.csv`;
          anchor.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          lastError = normalizeError(err).message;
        }
      }
    } finally {
      setExporting(false);
    }
    setExportError(lastError);
  };
  const tabItems = [
    { key: "r1", label: "库存 R1", render: () => <InventoryReport /> },
    { key: "r2", label: "月度损益 R2", render: () => <MonthlyPnl range={reportRange} /> },
    { key: "r3", label: "提成对账 R3", render: () => <Commission range={reportRange} /> },
    { key: "r4", label: "资金日报 R4", render: () => <DailyFunds /> },
    { key: "r5", label: "业务损益 R5", render: () => <BusinessPnl range={reportRange} /> },
    { key: "finance-dimensions", label: "资金属性分析", render: () => <FinanceDimensions range={reportRange} /> },
    { key: "profit", label: "订单利润", render: () => <OrderProfit range={reportRange} /> },
    { key: "data-center", label: "数据中心", render: () => <DataCenterPanel onNavigate={onNavigate} /> },
    { key: "quality", label: "质量中心", render: () => <QualityPanel /> },
    { key: "notifications", label: "系统提醒", render: () => <NotificationsPanel /> },
    { key: "search", label: "全局搜索", render: () => <SearchPanel /> },
    { key: "audit", label: "审计记录", render: () => <AuditPanel /> },
    { key: "attachments", label: "附件中心", render: () => <AttachmentPanel /> },
  ];

  return (
    <ReportsActiveContext.Provider value={active}>
    <section className="ui-stack">
      <Card className="glass" title="报表导出">
        <div className="ui-filter-bar">
          <Space size="small" className="ui-filter-bar__range">
            <Input type="date" value={exportFrom} onChange={(event) => setExportFrom(event.target.value)} aria-label="导出开始日期" className="ui-control-width-date" />
            <span className="muted">至</span>
            <Input type="date" value={exportTo} onChange={(event) => setExportTo(event.target.value)} aria-label="导出结束日期" className="ui-control-width-date" />
          </Space>
          <Select
            mode="multiple"
            allowClear
            virtual={false}
            placeholder="选择导出报表"
            value={selectedReports}
            onChange={setSelectedReports}
            options={reportOptions}
            className="ui-control-width-import"
            maxTagCount="responsive"
          />
          <PermissionButton permission="report.export" loading={exporting} onClick={() => void exportSelected()}>
            导出
          </PermissionButton>
        </div>
        {exportError ? <Typography.Text type="danger">{exportError}</Typography.Text> : null}
      </Card>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems.map(({ render, ...item }) => ({
          ...item,
          // 隐藏 Tab 不挂载：避免首屏同时发起 13 组请求，也避免切换无关页面时产生状态更新。
          children: activeTab === item.key ? render() : null,
        }))}
      />
    </section>
    </ReportsActiveContext.Provider>
  );
}

/** 经营中心是否处于激活态：透传给 useReport，使 keep-alive 隐藏期间写入的数据在切回时自动重拉。 */
const ReportsActiveContext = createContext(true);

/** 所有报表共用的取数/错误态壳：避免每个报表各写一遍 try/catch。 */
function useReport<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const pageActive = useContext(ReportsActiveContext);
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
  // 首次挂载由上一 effect 覆盖，这里只负责「重新激活」的重拉，避免重复请求。
  useReloadOnActive(pageActive, reload, { skipFirstMount: true });

  return { data, loading, error, reload };
}

/** 区间选择已提升到父级（reportRange），各报表通过 range 属性复用父级统计周期。 */


function InventoryReport() {
  const compact = useCompactLayout();
  const { data, loading, error, reload } = useReport<InventoryHealthReport>(
    () => reportsApi.inventoryHealth(),
    [],
  );
  const columns: ColumnsType<InventoryHealthRow> = [
    { title: "游戏账号/产品", dataIndex: "game_account" },
    { title: "平台", dataIndex: "platform", width: 110 },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} /> },
    { title: "买入", dataIndex: "buy_amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "附加成本", dataIndex: "extra_cost", align: "right", render: (v: string) => <MoneyText value={v} />},
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
      <Note>只统计已采购并进入在库或分期状态的真实占用（RPT-01-01）。</Note>
      <StatRow
        items={[
          { label: "在库账号", kind: "count", amount: String(data?.items.length ?? 0) },
          { label: "占用成本合计", amount: data?.total_cost ?? "-" },
        ]}
      />
      {compact ? (
            <MobileReportCards<InventoryHealthRow> rows={data?.items ?? []} columns={columns as unknown as ReportCardColumn<InventoryHealthRow>[]} />
          ) : (
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
          )}
    </Card>
  );
}

function MonthlyPnl({ range }: { range: ReportRange }) {
  const compact = useCompactLayout();
  const { params, picker } = range;
  const { data, loading, error, reload } = useReport<MonthlyPnlReport>(
    () => reportsApi.monthlyPnl(params),
    [params.from, params.to],
  );
  const columns: ColumnsType<MonthlyPnlRow> = [
    { title: "月份", dataIndex: "month", width: 110 },
    { title: "销售收入", dataIndex: "sales_income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "账号直接成本", dataIndex: "account_direct_cost", align: "right", render: (v: string) => <MoneyText value={v} />},
    { title: "运营费用", dataIndex: "operating_expense", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "返点收益", dataIndex: "rebate_income", align: "right", render: (v: string) => <MoneyText value={v} />},
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
      {compact ? (
            <MobileReportCards<MonthlyPnlRow> rows={data?.items ?? []} columns={columns as unknown as ReportCardColumn<MonthlyPnlRow>[]} />
          ) : (
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
          )}
    </Card>
  );
}

function Commission({ range }: { range: ReportRange }) {
  const compact = useCompactLayout();
  const { params, picker } = range;
  const { data, loading, error, reload } = useReport<CommissionReport>(
    () => reportsApi.commission(params),
    [params.from, params.to],
  );
  const columns: ColumnsType<CommissionRow> = [
    { title: "人员 ID", dataIndex: "user_id", width: 100 },
    { title: "订单号", dataIndex: "order_no", width: 160 },
    { title: "利润基数", dataIndex: "profit_base", align: "right", render: (v: string) => <MoneyText value={v} />},
    { title: "费率", dataIndex: "rate", align: "right", width: 90},
    { title: "应付", dataIndex: "payable", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "已付", dataIndex: "paid", align: "right", render: (v: string) => <MoneyText value={v} />},
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
      {compact ? (
            <MobileReportCards<CommissionRow> rows={data?.items ?? []} columns={columns as unknown as ReportCardColumn<CommissionRow>[]} />
          ) : (
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
          )}
    </Card>
  );
}

function DailyFunds() {
  const compact = useCompactLayout();
  const [reportOn, setReportOn] = useState(today());
  const { data, loading, error, reload } = useReport<DailyFundsReport>(
    () => reportsApi.dailyFunds({ on: reportOn }),
    [reportOn],
  );
  const columns: ColumnsType<DailyFundsRow> = [
    { title: "资金池", dataIndex: "pool_name", width: 150 },
    { title: "名称", dataIndex: "pool_name"},
    { title: "期初", dataIndex: "opening", align: "right", render: (v: string) => <MoneyText value={v} />},
    { title: "收入", dataIndex: "income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "支出", dataIndex: "expense", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "押金占用", dataIndex: "deposit_held", align: "right", render: (v: string) => <MoneyText value={v} />},
    { title: "现金余额", dataIndex: "cash_balance", align: "right", render: (v: string) => <MoneyText value={v} />},
    {
      title: "可用余额",
      dataIndex: "available",
      align: "right",
      render: (v: string) => <MoneyText value={v} strong />,
    },
  ];
  return (
    <Card
      className="glass"
      title={`资金日报 R4 · ${data?.date ?? ""}`}
      extra={<Input type="date" aria-label="资金日报日期" value={reportOn} onChange={(event) => setReportOn(event.target.value)} className="ui-control-width-date" />}
    >
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Note>与 FIN-01 同日口径一致：押金单列，不并入经营收支。</Note>
      <StatRow
        items={[
          { label: "现金余额", amount: data?.total.cash_balance ?? "-" },
          { label: "押金占用", amount: data?.total.deposit_held ?? "-" },
          { label: "可用余额", amount: data?.total.available ?? "-", tone: "auto" },
        ]}
      />
      {compact ? (
            <MobileReportCards<DailyFundsRow> rows={data?.items ?? []} columns={columns as unknown as ReportCardColumn<DailyFundsRow>[]} />
          ) : (
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
          )}
    </Card>
  );
}

function FinanceDimensions({ range }: { range: ReportRange }) {
  const compact = useCompactLayout();
  const { params, picker } = range;
  const { data, loading, error, reload } = useReport<FinanceDimensionReport>(
    () => reportsApi.financeDimensions(params),
    [params.from, params.to],
  );
  const columns: ColumnsType<FinanceDimensionRow> = [
    { title: "资金池", dataIndex: "pool_name", width: 130 },
    { title: "资金性质", dataIndex: "fund_nature", width: 120, render: (v: string) => FUND_NATURE_LABEL[v] ?? v },
    { title: "核算属性", dataIndex: "accounting_attribute", width: 160, render: (v: string) => ACCOUNTING_ATTRIBUTE_LABEL[v] ?? v},
    { title: "现金方向", dataIndex: "direction", width: 90, render: (v: string) => v === "IN" ? "收入" : "支出"},
    { title: "笔数", dataIndex: "flow_count", align: "right", width: 80},
    { title: "发生额", dataIndex: "amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "净方向金额", dataIndex: "signed_amount", align: "right", render: (v: string) => <MoneyText value={v} tone="auto" strong /> },
  ];
  return (
    <Card className="glass" title="资金属性分析">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar">{picker}</Space>
      <Note>按已审核流水的资金池、资金性质、核算属性和现金方向聚合；净方向金额按收入为正、支出为负计算。</Note>
      <StatRow
        items={[
          { label: "发生额合计", amount: data?.total_amount ?? "-" },
          { label: "净方向金额", amount: data?.total_signed_amount ?? "-", tone: "auto" },
        ]}
      />
      {compact ? (
            <MobileReportCards<FinanceDimensionRow> rows={data?.items ?? []} columns={columns as unknown as ReportCardColumn<FinanceDimensionRow>[]} />
          ) : (
            <DataTable<FinanceDimensionRow>
        columns={columns}
        rows={data?.items ?? []}
        loading={loading}
        page={1}
        pageSize={10}
        total={data?.items.length ?? 0}
        emptyText="所选区间无已审核流水"
        onPageChange={() => undefined}
     />
          )}
    </Card>
  );
}

function BusinessPnl({ range }: { range: ReportRange }) {
  const compact = useCompactLayout();
  const { params, picker } = range;
  const { data, loading, error, reload } = useReport<BusinessPnlReport>(
    () => reportsApi.businessPnl(params),
    [params.from, params.to],
  );
  const columns: ColumnsType<BusinessPnlRow> = [
    {
      title: "业务",
      dataIndex: "order_type",
      width: 150,
      render: (v: string, row) => `${BUSINESS_MODE_LABEL[row.business_mode ?? ""] ?? "-"}·${BUSINESS_TYPE_LABEL[row.business_type ?? ""] ?? ORDER_TYPE_LABEL[v] ?? v}（${v}）`,
    },
    { title: "主营收入", dataIndex: "main_income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "主营成本", dataIndex: "main_cost", align: "right", render: (v: string) => <MoneyText value={v} />},
    {
      title: "主营毛利",
      dataIndex: "main_profit",
      align: "right",
      render: (v: string) => <MoneyText value={v} tone="auto" strong />,
    },
    { title: "已结算返点", dataIndex: "settled_rebate", align: "right", render: (v: string) => <MoneyText value={v} />},
    { title: "未归集返点", dataIndex: "uncollected_rebate", align: "right", render: (v: string) => <MoneyText value={v} />},
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
        完整收益 = 主营毛利 + 已结算返点收益；未归集返点独立列示，不摊给业务（REB-01-06）。
      </Note>
      <StatRow
        items={[
          { label: "主营毛利", amount: data?.total.main_profit ?? "-", tone: "auto" },
          { label: "已结算返点", amount: data?.total.settled_rebate ?? "-" },
          { label: "未归集返点", amount: data?.total.uncollected_rebate ?? "-" },
          { label: "完整收益", amount: data?.total.full_income ?? "-", tone: "auto" },
        ]}
      />
      {compact ? (
            <MobileReportCards<BusinessPnlRow> rows={data?.items ?? []} columns={columns as unknown as ReportCardColumn<BusinessPnlRow>[]} />
          ) : (
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
          )}
    </Card>
  );
}

function OrderProfit({ range }: { range: ReportRange }) {
  const compact = useCompactLayout();
  const { params, picker } = range;
  const { data, loading, error, reload } = useReport<OrderProfitReport>(
    () => reportsApi.orderProfit(params),
    [params.from, params.to],
  );
  const columns: ColumnsType<OrderProfitRow> = [
    { title: "订单号", dataIndex: "order_no", width: 160 },
    { title: "业务", dataIndex: "order_type", width: 90, render: (v: string) => `${ORDER_TYPE_LABEL[v] ?? v}（${v}）`},
    { title: "成交日", dataIndex: "trade_date", width: 110 },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} /> },
    { title: "收入", dataIndex: "income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "直接成本", dataIndex: "direct_cost", align: "right", render: (v: string) => <MoneyText value={v} />},
    { title: "返点", dataIndex: "rebate", align: "right", render: (v: string) => <MoneyText value={v} />},
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
      {compact ? (
            <MobileReportCards<OrderProfitRow> rows={data?.items ?? []} columns={columns as unknown as ReportCardColumn<OrderProfitRow>[]} />
          ) : (
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
          )}
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
