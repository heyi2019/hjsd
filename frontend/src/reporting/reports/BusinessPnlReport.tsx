/** BusinessPnl：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { reportsApi, type BusinessPnlReport, type BusinessPnlRow } from "../../shared/api/catalog";
import { BUSINESS_MODE_LABEL, BUSINESS_TYPE_LABEL, ORDER_TYPE_LABEL } from "../../shared/lib/labels";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow } from "../../shared/ui";
import { Note, type ReportRange, useReport } from "./shared";

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
    { title: "主营收入", dataIndex: "main_income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "主营成本", dataIndex: "main_cost", align: "right", render: (v: string) => <MoneyText value={v} />},
    {
      title: "主营毛利",
      dataIndex: "main_profit",
      align: "right",
      render: (v: string) => <MoneyText value={v} tone="auto" strong />,
    },
  ];
  return (
    <Card className="glass" title="业务级损益 R5">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar">{picker}</Space>
      <Note>
        主营毛利 = 所有收入 − 所有支出；返点收入与分期坏账已分别计入收入 / 成本。返点金额统一按返点记录金额，历史「已结算返点 / 未归集返点 / 完整收益」列已下线。
      </Note>
      <StatRow
        items={[
          { label: "主营收入", amount: data?.total.main_income ?? "-" },
          { label: "主营成本", amount: data?.total.main_cost ?? "-" },
          { label: "主营毛利", amount: data?.total.main_profit ?? "-", tone: "auto" },
        ]}
      />
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
    </Card>
  );
}
