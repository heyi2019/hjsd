/** OrderProfit：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { reportsApi, type OrderProfitReport, type OrderProfitRow } from "../../shared/api/catalog";
import { ORDER_TYPE_LABEL } from "../../shared/lib/labels";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow, StatusTag } from "../../shared/ui";
import { type ReportRange, useReport } from "./shared";
import { ReportExportButton } from "./ReportExportButton";

export function OrderProfit({ range }: { range: ReportRange }) {
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
    { title: "收入", dataIndex: "income", align: "right", render: (v: string) => <MoneyText value={v} currency="CNY" /> },
    { title: "账号采购成本", dataIndex: "buy_amount", align: "right", render: (v: string) => <MoneyText value={v} currency="CNY" /> },
    { title: "直接成本", dataIndex: "direct_cost", align: "right", render: (v: string) => <MoneyText value={v} currency="CNY" />},
    { title: "返点（收入子项）", dataIndex: "rebate", align: "right", render: (v: string) => <MoneyText value={v} currency="CNY" />},
    {
      title: "订单利润（净利）",
      dataIndex: "net_profit",
      align: "right",
      render: (v: string) => <MoneyText value={v} currency="CNY" tone="auto" strong />,
    },
  ];
  return (
    <Card className="glass" title="订单利润明细（分润口径）">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Space className="ui-filter-bar">{picker}</Space>
      <Typography.Text type="secondary">订单利润 = 所有收入 − 所有支出；返点已包含在收入中，分期按实际收付款确认。</Typography.Text>
      <StatRow
        items={[
          { label: "收入合计", amount: data?.total.income ?? "-", currency: "CNY" },
          { label: "账号采购成本合计", amount: data?.total.buy_amount ?? "-", currency: "CNY" },
          { label: "直接成本合计", amount: data?.total.direct_cost ?? "-", currency: "CNY" },
          { label: "返点（收入子项）合计", amount: data?.total.rebate ?? "-", currency: "CNY" },
          { label: "订单利润合计", amount: data?.total.net_profit ?? "-", currency: "CNY", tone: "auto" },
        ]}
      />
             <DataTable<OrderProfitRow>
         ariaLabel="订单利润表格"
         columns={arrangeOrderProfit(columns)}
         rows={data?.items ?? []}
         loading={loading}
         page={1}
         pageSize={10}
         total={data?.items.length ?? 0}
         emptyText="所选区间无订单"
         onPageChange={() => undefined}
      />
      <ReportExportButton name="order-profit" params={params} />
    </Card>
  );
}
