/** BusinessPnl：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { reportsApi, type BusinessPnlReport, type BusinessPnlRow } from "../../shared/api/catalog";
import { BUSINESS_MODE_LABEL, BUSINESS_TYPE_LABEL, ORDER_TYPE_LABEL } from "../../shared/lib/labels";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow } from "../../shared/ui";
import { type ReportRange, useReport } from "./shared";
import { ReportExportButton } from "./ReportExportButton";

export function BusinessPnl({ range }: { range: ReportRange }) {
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
    { title: "主营收入", dataIndex: "main_income", align: "right", render: (v: string) => <MoneyText value={v} currency="CNY" /> },
    { title: "主营成本", dataIndex: "main_cost", align: "right", render: (v: string) => <MoneyText value={v} currency="CNY" />},
    {
      title: "业务利润（汇总）",
      dataIndex: "main_profit",
      align: "right",
      render: (v: string) => <MoneyText value={v} currency="CNY" tone="auto" strong />,
    },
  ];
  return (
    <Card className="glass" title="业务利润汇总 R5">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar">{picker}</Space>
      <StatRow
        items={[
          { label: "主营收入", amount: data?.total.main_income ?? "-", currency: "CNY" },
          { label: "主营成本", amount: data?.total.main_cost ?? "-", currency: "CNY" },
          { label: "业务利润（汇总）", amount: data?.total.main_profit ?? "-", currency: "CNY", tone: "auto" },
        ]}
      />
             <DataTable<BusinessPnlRow>
         ariaLabel="业务损益表格"
         columns={arrangeBusinessPnl(columns)}
         rows={data?.items ?? []}
         loading={loading}
         page={1}
         pageSize={10}
         total={data?.items.length ?? 0}
         emptyText="所选区间无业务数据"
         onPageChange={() => undefined}
      />
      <ReportExportButton name="business-pnl" params={params} />
    </Card>
  );
}
