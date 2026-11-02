/** 经营中心：库存 R1 / 月度损益 R2 / 提成对账 R3 / 资金日报 R4 / 业务损益 R5 / 数据中心（RPT-01）。 */
import { Card, Input, Space, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { DataCenterPanel } from "./DataCenterPanel";
import { MobileReportCards, type ReportCardColumn } from "../h5";
import { QualityPanel } from "../quality/QualityPanel";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import { SearchPanel } from "../search/SearchPanel";
import { AuditPanel } from "../audit/AuditPanel";
import { AttachmentPanel } from "../attachments/AttachmentPanel";
import { reportsApi,
  employeesApi,
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
  type OrderProfitRow, } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { ACCOUNTING_ATTRIBUTE_LABEL, BUSINESS_MODE_LABEL, BUSINESS_TYPE_LABEL, FUND_NATURE_LABEL, ORDER_TYPE_LABEL } from "../shared/lib/labels";
import { useOptionSet } from "../shared/lib/optionSets";
import { DataTable,
  ErrorBanner,
  MoneyText,
  StatRow,
  StatusTag,
  PermissionButton,
  Select,
  useCompactLayout, } from "../shared/ui";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import { useListViewColumns } from "../shared/lib/listColumns";
import { appMessage } from "../shared/ui/appFeedback";

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

export function ReportsPage({ onNavigate, active = true, initialReportTab }: { onNavigate?: (key: string) => void; active?: boolean; initialReportTab?: "commission" | "my-earnings" }) {
  const reportOptions = useOptionSet("REPORT_NAME") ?? REPORT_FALLBACK;
  const [myEarnings, setMyEarnings] = useState(initialReportTab === "my-earnings");
  const [activeTab, setActiveTab] = useState(initialReportTab === "commission" || myEarnings ? "r3" : "r1");
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [selectedReports, setSelectedReports] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  // 报表视图统计周期：提升到父级，避免切换 Tab（非挂载）后筛选条件丢失。
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  useEffect(() => {
    // keep-alive 下离开经营中心时保留个人视图，避免隐藏页在切换期间改请求口径；
    // 重新激活后再按 URL 入口决定是「我的收益」还是完整提成对账。
    if (!active) return;
    setMyEarnings(initialReportTab === "my-earnings");
    if (initialReportTab === "commission" || initialReportTab === "my-earnings") setActiveTab("r3");
  }, [active, initialReportTab]);
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
      setExportSuccess(null);
      return;
    }
    if (exportFrom && exportTo && exportFrom > exportTo) {
      setExportError("导出开始日期不能晚于结束日期");
      setExportSuccess(null);
      return;
    }
    setExporting(true);
    setExportError(null);
    setExportSuccess(null);
    let lastError: string | null = null;
    let successCount = 0;
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
          successCount += 1;
        } catch (err) {
          lastError = normalizeError(err).message;
        }
      }
    } finally {
      setExporting(false);
    }
    if (lastError) {
      setExportError(lastError);
    } else {
      const message = `已导出 ${successCount} 份报表`;
      setExportSuccess(message);
      appMessage.success(message);
    }
  };
  const tabItems = [
    { key: "r1", label: "库存 R1", render: () => <InventoryReport /> },
    { key: "r2", label: "月度损益 R2", render: () => <MonthlyPnl range={reportRange} /> },
    { key: "r3", label: "提成对账 R3", render: () => <Commission range={reportRange} mine={myEarnings} /> },
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
        <Typography.Text type="secondary">
          导出列与「设置 → 列表字段」一致：被隐藏的列不导出，表头与枚举值均为中文（取自选项词典）；合计行独有字段仍保留在末尾。
        </Typography.Text>
        {exportError ? <Typography.Text type="danger">{exportError}</Typography.Text> : null}
        {exportSuccess ? <Typography.Text type="success">{exportSuccess}</Typography.Text> : null}
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
  const { arrange: arrangeInventoryHealth } = useListViewColumns("RPT_INVENTORY_HEALTH");
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
          { label: "在库账号", kind: "count", amount: error ? "不可用" : String(data?.items.length ?? 0) },
          { label: "占用成本合计", amount: error ? "不可用" : data?.total_cost ?? "-" },
        ]}
      />
      {compact ? (
            <MobileReportCards<InventoryHealthRow> rows={data?.items ?? []} columns={arrangeInventoryHealth(columns) as unknown as ReportCardColumn<InventoryHealthRow>[]} />
          ) : (
            <DataTable<InventoryHealthRow>
        columns={arrangeInventoryHealth(columns)}
        rows={data?.items ?? []}
        loading={loading}
        page={1}
        pageSize={10}
        total={data?.items.length ?? 0}
        emptyText={error ? "库存健康数据不可用，请点击重新加载" : "暂无在库账号"}
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
  const { arrange: arrangeMonthlyPnl } = useListViewColumns("RPT_MONTHLY_PNL");
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
            <MobileReportCards<MonthlyPnlRow> rows={data?.items ?? []} columns={arrangeMonthlyPnl(columns) as unknown as ReportCardColumn<MonthlyPnlRow>[]} />
          ) : (
            <DataTable<MonthlyPnlRow>
        columns={arrangeMonthlyPnl(columns)}
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

function Commission({ range, mine = false }: { range: ReportRange; mine?: boolean }) {
  const compact = useCompactLayout();
  const { params, picker } = range;
  const [employees, setEmployees] = useState<{ id: number; username: string; display_name: string; is_active: boolean }[]>([]);
  const [employeeError, setEmployeeError] = useState<{ message: string; code?: string } | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number>(0);
  useEffect(() => {
    if (mine) return;
    let mounted = true;
    employeesApi.list()
      .then((items) => {
        if (!mounted) return;
        setEmployees(items);
        setEmployeeError(null);
      })
      .catch((error) => {
        if (mounted) setEmployeeError(normalizeError(error));
      });
    return () => { mounted = false; };
  }, [mine]);
  const commissionParams = {
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
    ...(mine ? { mine: true } : {}),
    ...(!mine ? { all_people: true } : {}),
    ...(!mine && selectedUserId ? { user_id: selectedUserId } : {}),
  };
  const { data, loading, error, reload } = useReport<CommissionReport>(
    () => reportsApi.commission(commissionParams),
    [params.from, params.to, mine, selectedUserId],
  );
  const { arrange: arrangeCommission } = useListViewColumns("RPT_COMMISSION");
  const columns: ColumnsType<CommissionRow> = [
    ...(mine ? [] : [{ title: "人员 ID", dataIndex: "user_id", width: 100 }]),
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
    <Card className="glass" title={mine ? "我的收益" : "提成对账 R3"}>
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar">
        {!mine ? (
          <Select
            value={selectedUserId}
            onChange={(value) => setSelectedUserId((value as number) || 0)}
            options={[
              { value: 0, label: "全部" },
              ...employees.map((employee) => ({ value: employee.id, label: `${employee.display_name}（${employee.username}）` })),
            ]}
            className="ui-control-width-import"
          />
        ) : null}
        {picker}
      </Space>
      <ErrorBanner error={employeeError} />
      <Note>{mine ? "仅展示当前登录用户在分润配置中获得的收益。" : "默认展示所有人的经营总览；可按人员筛选到每一单。应付与已付差异即为待追补金额（RPT-01-03）。"}</Note>
      <StatRow
        items={[
          { label: mine ? "收益订单数" : "订单数", kind: "count", amount: String(data?.total.order_count ?? 0) },
          { label: mine ? "我的收益" : "分润基数", amount: data?.total.profit_base ?? "-" },
          { label: "应付合计", amount: data?.total.payable ?? "-" },
          { label: "已付合计", amount: data?.total.paid ?? "-" },
          { label: "差异", amount: data?.total.difference ?? "-", tone: "auto" },
        ]}
      />
      {compact ? (
            <MobileReportCards<CommissionRow> rows={data?.items ?? []} columns={arrangeCommission(columns) as unknown as ReportCardColumn<CommissionRow>[]} />
          ) : (
            <DataTable<CommissionRow>
        columns={arrangeCommission(columns)}
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
  const { arrange: arrangeDailyFunds } = useListViewColumns("RPT_DAILY_FUNDS");
  const columns: ColumnsType<DailyFundsRow> = [
    { title: "资金池", dataIndex: "pool_name", width: 150 },
    { title: "名称", key: "pool_label", dataIndex: "pool_name"},
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
            <MobileReportCards<DailyFundsRow> rows={data?.items ?? []} columns={arrangeDailyFunds(columns) as unknown as ReportCardColumn<DailyFundsRow>[]} />
          ) : (
            <DataTable<DailyFundsRow>
        columns={arrangeDailyFunds(columns)}
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
  const { arrange: arrangeFinanceDim } = useListViewColumns("RPT_FINANCE_DIM");
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
            <MobileReportCards<FinanceDimensionRow> rows={data?.items ?? []} columns={arrangeFinanceDim(columns) as unknown as ReportCardColumn<FinanceDimensionRow>[]} />
          ) : (
            <DataTable<FinanceDimensionRow>
        columns={arrangeFinanceDim(columns)}
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
  const { arrange: arrangeBusinessPnl } = useListViewColumns("RPT_BUSINESS_PNL");
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
            <MobileReportCards<BusinessPnlRow> rows={data?.items ?? []} columns={arrangeBusinessPnl(columns) as unknown as ReportCardColumn<BusinessPnlRow>[]} />
          ) : (
            <DataTable<BusinessPnlRow>
        columns={arrangeBusinessPnl(columns)}
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
  const { arrange: arrangeOrderProfit } = useListViewColumns("RPT_ORDER_PROFIT");
  const columns: ColumnsType<OrderProfitRow> = [
    { title: "订单号", dataIndex: "order_no", width: 160 },
    { title: "业务", dataIndex: "order_type", width: 90, render: (v: string) => `${ORDER_TYPE_LABEL[v] ?? v}（${v}）`},
    { title: "成交日", dataIndex: "trade_date", width: 110 },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} /> },
    { title: "收入", dataIndex: "income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "账号采购成本", dataIndex: "buy_amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
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
      <Note>
        净利 = 收入 - 账号采购成本 - 直接成本 + 返点；账号采购成本来自买入事件，直接成本为运营、平台费用及坏账等成本，避免将可见直接成本误读为全部成本。
      </Note>
      <StatRow
        items={[
          { label: "收入合计", amount: data?.total.income ?? "-" },
          { label: "账号采购成本合计", amount: data?.total.buy_amount ?? "-" },
          { label: "直接成本合计", amount: data?.total.direct_cost ?? "-" },
          { label: "返点合计", amount: data?.total.rebate ?? "-" },
          { label: "净利合计", amount: data?.total.net_profit ?? "-", tone: "auto" },
        ]}
      />
      {compact ? (
            <MobileReportCards<OrderProfitRow> rows={data?.items ?? []} columns={arrangeOrderProfit(columns) as unknown as ReportCardColumn<OrderProfitRow>[]} />
          ) : (
            <DataTable<OrderProfitRow>
        columns={arrangeOrderProfit(columns)}
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
