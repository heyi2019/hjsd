/** InventoryReport：从 ReportsPage.tsx 拆出的单个报表视图。 */

import { Card } from "antd";
import type { ColumnsType } from "antd/es/table";
import { reportsApi, type InventoryHealthReport, type InventoryHealthRow } from "../../shared/api/catalog";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, ErrorBanner, MoneyText, StatRow, StatusTag } from "../../shared/ui";
import { Note, useReport } from "./shared";

export function InventoryReport() {
  const { data, loading, error, reload } = useReport<InventoryHealthReport>(
    () => reportsApi.inventoryHealth(),
    [],
  );
  const { arrange: arrangeInventoryHealth } = useListViewColumns("RPT_INVENTORY_HEALTH");
  const columns: ColumnsType<InventoryHealthRow> = [
    { title: "游戏账号/产品", dataIndex: "game_account" },
    { title: "平台", dataIndex: "platform", width: 110 },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <StatusTag status={v} /> },
    { title: "买入", dataIndex: "buy_amount", align: "right", render: (v: string) => <MoneyText value={v} /> },
    { title: "附加成本", dataIndex: "extra_cost", align: "right", render: (v: string) => <MoneyText value={v} />},
    {
      title: "占用成本",

      dataIndex: "total_cost",
      align: "right",
      render: (v: string) => <MoneyText value={v} strong />,
    },
    {
      title: "持有天数",

      dataIndex: "holding_days",
      align: "right",
      width: 100,
      render: (days: number | null | undefined, row) => {
        if (days == null) return "-";
        const color = days <= 7 ? "green" : days <= 30 ? "orange" : "red";
        return <StatusTag status={row.status} color={color} label={`${days}天`} />;
      },
    },
  ];
  return (
    <Card className="glass" title="库存健康表 R1">
      <ErrorBanner error={error} onRetry={reload} retrying={loading} />
      <Note>只统计已采购并进入在库或分期状态的真实占用（RPT-01-01）。</Note>
      <StatRow
        items={[
          { label: "在库账号", kind: "count", amount: error ? "不可用" : String(data?.items.length ?? 0) },
          { label: "占用成本合计", amount: error ? "不可用" : data?.total_cost ?? "-" },
        ]}
      />
             <DataTable<InventoryHealthRow>
         columns={arrangeInventoryHealth(columns)}
         rows={data?.items ?? []}
         loading={loading}
         page={1}
         pageSize={10}
         total={data?.items.length ?? 0}
         emptyText={error ? "库存健康数据不可用，请点击重新加载" : "暂无在库账号"}
         onPageChange={() => undefined}
      />
    </Card>
  );
}
