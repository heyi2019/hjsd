/** BusinessPnl：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { reportsApi } from "../../shared/api/reports.api";
import type { BusinessPnlReport, BusinessPnlRow } from "../../shared/api/types/reporting";
import { BUSINESS_MODE_LABEL, BUSINESS_TYPE_LABEL, ORDER_TYPE_LABEL } from "../../shared/lib/labels";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow } from "../../shared/ui";
import { type ReportRange, useReport } from "./shared";
import { ReportExportButton } from "./ReportExportButton";

export function BusinessPnl({ range, showPicker = true }: { range: ReportRange; showPicker?: boolean }) {
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
    { title: "成本", dataIndex: "cost", align: "right", render: (v: string) => <MoneyText value={v} />},
    {
      title: "主营毛利",
      dataIndex: "main_profit",
      align: "right",
      render: (v: string) => <MoneyText value={v} tone="auto" strong />,
    },
  ];
  return (
    <Card className="glass" title="业务级损益">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space wrap className="ui-filter-bar ui-filter-bar--spaced">{showPicker && picker}<ReportExportButton name="business-pnl" params={params} /></Space>
      <StatRow
        items={[
          { label: "主营收入", amount: data?.total.main_income ?? "-" },
          { label: "成本合计", amount: data?.total.cost ?? "-" },
          { label: "主营利润", amount: data?.total.main_profit ?? "-", tone: "auto" },
        ]}
      />
             <DataTable<BusinessPnlRow>
         columns={arrangeBusinessPnl(columns)}
         rows={data?.items ?? []}
         loading={loading}
         resetKey={JSON.stringify([params.from, params.to])}
         page={1}
         pageSize={10}
         total={data?.items.length ?? 0}
         emptyText={error ? "报表数据不可用，请点击重新加载" : "所选区间无业务数据"}
         onPageChange={() => undefined}
      />
    </Card>
  );
}
