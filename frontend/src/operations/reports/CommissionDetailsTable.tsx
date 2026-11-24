import type { ColumnsType } from "antd/es/table";
import type { CommissionOrderGroup, CommissionRow } from "../../shared/api/types/reporting";
import { useListViewColumns } from "../../shared/lib/listColumns";
import { DataTable, MoneyText } from "../../shared/ui";
import "./CommissionReport.css";

export function CommissionDetailsTable({ row, personName }: { row: CommissionOrderGroup; personName?: (detail: CommissionRow) => string }) {
  const name = personName ?? ((detail: CommissionRow) => detail.user_id == null ? "公司" : detail.user_name || `人员${detail.user_id}`);
  const { arrange } = useListViewColumns("RPT_COMMISSION");
  const columns: ColumnsType<CommissionRow & { detail_key: string }> = [
    { title: "分润人员", key: "user_name", width: 180, render: (_value, detail) => name(detail) },
    { title: "分润基数", dataIndex: "profit_base", width: 140, align: "right", render: (value: string) => <MoneyText value={value} /> },
    { title: "费率", dataIndex: "rate", width: 120, align: "right", render: (value: string) => `${value}%` },
  ];
  return (
    <div className="ui-table-wrap commission-detail-container">
      <div className="commission-detail-table">
        <DataTable<CommissionRow & { detail_key: string }>
          ariaLabel="分润明细"
          columns={arrange(columns)}
          rows={row.orders.map((detail, index) => ({ ...detail, detail_key: `${row.order_id}-${index}` }))}
          rowKey="detail_key"
          pagination={false}
          size="small"
          scroll={{ x: "max-content" }}
          page={1}
          pageSize={10}
          total={row.orders.length}
          onPageChange={() => undefined}
        />
      </div>
    </div>
  );
}
