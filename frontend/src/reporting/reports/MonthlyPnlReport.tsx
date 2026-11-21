import { useState } from "react";
import { TimeOrderControl } from "../../shared/ui/TimeOrderControl";
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
  const [sortDesc, setSortDesc] = useState(true);
  const { data, loading, error, reload } = useReport<MonthlyPnlReport>(
    () => reportsApi.monthlyPnl(params),
    [params.from, params.to],
  );
  const sortedRows = [...(data?.items ?? [])].sort((a, b) => (sortDesc ? -1 : 1) * (a.month.localeCompare(b.month)));
  const { arrange: arrangeMonthlyPnl } = useListViewColumns("RPT_MONTHLY_PNL");
  const columns: ColumnsType<MonthlyPnlRow> = [
    { title: "月份", dataIndex: "month", width: 110 },
    { title: "销售收入", dataIndex: "sales_income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "成本", dataIndex: "cost", align: "right", render: (v: string) => <MoneyText value={v} />},
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
      <Space wrap className="ui-filter-bar ui-filter-bar--spaced">{showPicker && picker}<TimeOrderControl descending={sortDesc} onChange={setSortDesc} /><ReportExportButton name="monthly-pnl" params={params} /></Space>
      <StatRow
        items={[
          { label: "销售收入", amount: data?.total.sales_income ?? "-" },
          { label: "经营利润", amount: data?.total.operating_profit ?? "-", tone: "auto" },
        ]}
      />
             <DataTable<MonthlyPnlRow>
         columns={arrangeMonthlyPnl(columns)}
         rows={sortedRows}
         loading={loading}
         resetKey={JSON.stringify([params.from, params.to, sortDesc])}
         page={1}
         pageSize={10}
         total={data?.items.length ?? 0}
         emptyText={error ? "报表数据不可用，请点击重新加载" : "所选区间无数据"}
         onPageChange={() => undefined}
      />
    </Card>
  );
}
