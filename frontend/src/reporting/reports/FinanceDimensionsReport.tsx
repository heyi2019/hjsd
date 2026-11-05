/** FinanceDimensions：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { reportsApi, type FinanceDimensionReport, type FinanceDimensionRow } from "../../shared/api/catalog";
import { ACCOUNTING_ATTRIBUTE_LABEL, FUND_NATURE_LABEL } from "../../shared/lib/labels";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow } from "../../shared/ui";
import { Note, type ReportRange, useReport } from "./shared";

export function FinanceDimensions({ range }: { range: ReportRange }) {
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
    </Card>
  );
}
