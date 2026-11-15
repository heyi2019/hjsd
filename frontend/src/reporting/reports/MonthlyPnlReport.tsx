/** MonthlyPnl：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { reportsApi } from "../../shared/api/reports.api";
import type { MonthlyPnlReport, MonthlyPnlRow } from "../../shared/api/types/reporting";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow } from "../../shared/ui";
import { type ReportRange, useReport } from "./shared";
import { ReportExportButton } from "./ReportExportButton";

export function MonthlyPnl({ range, showPicker = true }: { range: ReportRange; showPicker?: boolean }) {
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
    <Card className="glass" title="月度经营损益">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      {showPicker && <Space className="ui-filter-bar ui-filter-bar--spaced">{picker}</Space>}
      <StatRow
        items={[
          { label: "销售收入", amount: data?.total.sales_income ?? "-" },
          { label: "经营利润", amount: data?.total.operating_profit ?? "-", tone: "auto" },
        ]}
      />
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
      <ReportExportButton name="monthly-pnl" params={params} />
    </Card>
  );
}
