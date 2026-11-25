import { useEffect, useState } from "react";
import { TimeOrderControl } from "../../shared/ui/TimeOrderControl";
/** OrderProfit：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { reportsApi } from "../../shared/api/reports.api";
import type { OrderProfitReport, OrderProfitRow } from "../../shared/api/types/reporting";
import { ORDER_TYPE_LABEL } from "../../shared/lib/labels";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow, StatusTag } from "../../shared/ui";
import { type ReportRange, useReport, useReportPagination } from "./shared";
import { ReportExportButton } from "./ReportExportButton";

export function OrderProfit({ range }: { range: ReportRange }) {
  const { params, picker } = range;
  const [sortDesc, setSortDesc] = useState(true);
  const { page, pageSize, onPageChange } = useReportPagination(JSON.stringify([params.from, params.to, sortDesc]));
  const { data, loading, error, reload } = useReport<OrderProfitReport>(
    () => reportsApi.orderProfit({ ...params, limit: pageSize, offset: (page - 1) * pageSize, sort_desc: sortDesc }),
    [params.from, params.to, page, pageSize, sortDesc],
  );
  const count = data?.count ?? data?.items.length ?? 0;
  useEffect(() => {
    const lastPage = Math.max(1, Math.ceil(count / pageSize));
    if (data && page > lastPage) onPageChange(lastPage, pageSize);
  }, [count, data, page, pageSize, onPageChange]);
  const { arrange: arrangeOrderProfit } = useListViewColumns("RPT_ORDER_PROFIT");
  const columns: ColumnsType<OrderProfitRow> = [
    { title: "订单号", dataIndex: "order_no", width: 160 },
    { title: "业务", dataIndex: "order_type", width: 90, render: (v: string) => ORDER_TYPE_LABEL[v] ?? "其他业务" },
    { title: "成交日", dataIndex: "trade_date", width: 110 },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} /> },
    { title: "收入", dataIndex: "income", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "成本", dataIndex: "cost", align: "right", render: (v: string) => <MoneyText value={v} /> },
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
      <Space wrap className="ui-filter-bar ui-filter-bar--spaced">{picker}<TimeOrderControl descending={sortDesc} onChange={setSortDesc} /><ReportExportButton name="order-profit" params={{ ...params, sort_desc: sortDesc }} /></Space>
      <StatRow
        items={[
          { label: "收入合计", amount: data?.total.income ?? "-" },
          { label: "成本合计", amount: data?.total.cost ?? "-" },
          { label: "返点合计", amount: data?.total.rebate ?? "-" },
          { label: "净利合计", amount: data?.total.net_profit ?? "-", tone: "auto" },
        ]}
      />
             <DataTable<OrderProfitRow>
         columns={arrangeOrderProfit(columns)}
         rows={data?.items ?? []}
         loading={loading}
         controlledPaging
         page={page}
         pageSize={pageSize}
         total={count}
         emptyText={error ? "报表数据不可用，请点击重新加载" : "所选区间无订单"}
         onPageChange={onPageChange}
      />
    </Card>
  );
}
