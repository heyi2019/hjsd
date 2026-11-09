/** DailyFunds：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Input } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";
import { reportsApi, type DailyFundsReport, type DailyFundsRow } from "../../shared/api/catalog";
import { today } from "../../shared/lib/format";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow } from "../../shared/ui";
import { useReport } from "./shared";
import { ReportExportButton } from "./ReportExportButton";

export function DailyFunds() {
  const [reportOn, setReportOn] = useState(today());
  const { data, loading, error, reload } = useReport<DailyFundsReport>(
    () => reportsApi.dailyFunds({ on: reportOn }),
    [reportOn],
  );
  const { arrange: arrangeDailyFunds } = useListViewColumns("RPT_DAILY_FUNDS");
  const columns: ColumnsType<DailyFundsRow> = [
    { title: "资金池", dataIndex: "pool_name", width: 150 },
    { title: "期初", dataIndex: "opening", align: "right", render: (v: string) => <MoneyText value={v} />},
    { title: "收入", dataIndex: "income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "支出", dataIndex: "expense", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "押金占用", dataIndex: "deposit_held", align: "right", render: (v: string) => <MoneyText value={v} />},
    { title: "现金余额", dataIndex: "cash_balance", align: "right", render: (v: string) => <MoneyText value={v} tone="auto" />},
    {
      title: "可用余额",
      dataIndex: "available",
      align: "right",
      render: (v: string) => <MoneyText value={v} tone="auto" strong />,
    },
  ];
  return (
    <Card
      className="glass"
      title={`资金日报 R4 · ${data?.date ?? ""}`}
      extra={<Input type="date" aria-label="资金日报日期" value={reportOn} onChange={(event) => setReportOn(event.target.value)} className="ui-control-width-date" />}
    >
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <StatRow
        items={[
          { label: "现金余额", amount: data?.total.cash_balance ?? "-" },
          { label: "押金占用", amount: data?.total.deposit_held ?? "-" },
          { label: "可用余额", amount: data?.total.available ?? "-", tone: "auto" },
        ]}
      />
             <DataTable<DailyFundsRow>
         ariaLabel="资金日报表格"
         columns={arrangeDailyFunds(columns)}
         rows={data?.items ?? []}
         loading={loading}
         page={1}
         pageSize={10}
         total={data?.items.length ?? 0}
         emptyText="当日无资金流水"
         onPageChange={() => undefined}
      />
      <ReportExportButton name="daily-funds" params={{ from: reportOn, to: reportOn }} />
    </Card>
  );
}
