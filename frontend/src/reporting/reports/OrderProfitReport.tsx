/** OrderProfit：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { reportsApi, type OrderProfitReport, type OrderProfitRow } from "../../shared/api/catalog";
import { ORDER_TYPE_LABEL } from "../../shared/lib/labels";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow, StatusTag } from "../../shared/ui";
import { Note, type ReportRange, useReport } from "./shared";

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
    </Card>
  );
}
