/** MonthlyPnl：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { reportsApi, type MonthlyPnlReport, type MonthlyPnlRow } from "../../shared/api/catalog";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow } from "../../shared/ui";
import { type ReportRange, useReport } from "./shared";
import { ReportExportButton } from "./ReportExportButton";

export function MonthlyPnl({ range }: { range: ReportRange }) {
  const { params, picker } = range;
  const { data, loading, error, reload } = useReport<MonthlyPnlReport>(
    () => reportsApi.monthlyPnl(params),
    [params.from, params.to],
  );
  const { arrange: arrangeMonthlyPnl } = useListViewColumns("RPT_MONTHLY_PNL");
  const columns: ColumnsType<MonthlyPnlRow> = [
    { title: "月份", dataIndex: "month", width: 110 },
    { title: "销售收入", dataIndex: "sales_income", align: "right", render: (v: string) => <MoneyText value={v} currency="CNY" /> },
    { title: "账号直接成本", dataIndex: "account_direct_cost", align: "right", render: (v: string) => <MoneyText value={v} currency="CNY" />},
    { title: "运营费用", dataIndex: "operating_expense", align: "right", render: (v: string) => <MoneyText value={v} currency="CNY" /> },
    { title: "返点收益", dataIndex: "rebate_income", align: "right", render: (v: string) => <MoneyText value={v} currency="CNY" />},
    {
      title: "经营利润（报表口径）",
      dataIndex: "operating_profit",
      align: "right",
      render: (v: string) => <MoneyText value={v} currency="CNY" tone="auto" strong />,
    },
  ];
  return (
    <Card className="glass" title="月度经营损益 R2">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar">{picker}</Space>
      <StatRow
        items={[
          { label: "销售收入", amount: data?.total.sales_income ?? "-", currency: "CNY" },
          { label: "经营利润（报表口径）", amount: data?.total.operating_profit ?? "-", currency: "CNY", tone: "auto" },
        ]}
      />
             <DataTable<MonthlyPnlRow>
         ariaLabel="月度损益表格"
         columns={arrangeMonthlyPnl(columns)}
         rows={data?.items ?? []}
         loading={loading}
         page={1}
         pageSize={10}
         total={data?.items.length ?? 0}
         emptyText="所选区间无数据"
         onPageChange={() => undefined}
      />
      <ReportExportButton name="monthly-pnl" params={params} />
    </Card>
  );
}
