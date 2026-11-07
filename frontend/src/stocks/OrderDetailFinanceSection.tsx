import { Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DataTable, MoneyText } from "../shared/ui";
import {
  InventoryExtraFieldsGroup,
  type OrderDetailField,
  type InventoryFinanceRow,
} from "./OrderDetail.shared";

/** 「资金明细」板块：自定义字段分组 + 收支汇总条 + 流水表。 */
export function OrderDetailFinanceSection({
  rows,
  extraFields,
  expenseCount,
  incomeCount,
  totalExpense,
  totalIncome,
  flowCount,
  editing,
}: {
  rows: InventoryFinanceRow[];
  extraFields: OrderDetailField[];
  expenseCount: number;
  incomeCount: number;
  totalExpense: string;
  totalIncome: string;
  flowCount: number;
  editing?: boolean;
}) {
  const columns: ColumnsType<InventoryFinanceRow> = [
    { title: "类型", dataIndex: "type", key: "type" },
    {
      title: "方向",
      dataIndex: "direction",
      key: "direction",
      render: (value: InventoryFinanceRow["direction"]) => (
        <Typography.Text type={value === "收入" ? "success" : value === "支出" ? "danger" : "secondary"}>{value}</Typography.Text>
      ),
    },
    {
      title: "金额",
      dataIndex: "amount",
      key: "amount",
      align: "right",
      render: (value: string) => (
        <div className="inventory-detail__cell-amount">
          <MoneyText value={value} />
        </div>
      ),
    },
    { title: "比例", dataIndex: "rate", key: "rate", align: "right" },
    { title: "时间", dataIndex: "occurredAt", key: "occurredAt" },
    { title: "操作人", dataIndex: "operator", key: "operator" },
    {
      title: "资金池",
      key: "poolName",
      render: (_value, financeRow) => financeRow.poolName,
    },
  ];

  return (
    <div className="inventory-detail__section inventory-detail__section--finance inventory-finance-list">
      <div className="inventory-detail__section-heading inventory-finance-heading">
        <Typography.Text strong>资金明细</Typography.Text>
        <Typography.Text type="secondary">{flowCount} 笔</Typography.Text>
      </div>
      <div className="inventory-detail__meta">
        <InventoryExtraFieldsGroup section="FINANCE" fields={extraFields} />
        <div className="inventory-finance-summary">
          <div className="inventory-finance-summary__item inventory-finance-summary__item--expense"><span>资金流水支出</span><strong>{expenseCount} 笔</strong></div>
          <div className="inventory-finance-summary__item inventory-finance-summary__item--income"><span>收入</span><strong>{incomeCount} 笔</strong></div>
          <div className="inventory-finance-summary__item inventory-finance-summary__item--amount"><span>总支出（含坏账）</span><MoneyText value={totalExpense} /></div>
          <div className="inventory-finance-summary__item inventory-finance-summary__item--amount"><span>总收入</span><MoneyText value={totalIncome} /></div>
        </div>
        <Typography.Text type="secondary">总支出含分期坏账，坏账不生成资金流水行</Typography.Text>
        {rows.length ? <DataTable className="inventory-finance-table" columns={columns} rows={rows} page={1} pageSize={10} total={rows.length} onPageChange={() => undefined} pagination={false} rowKey="key" scroll={{ x: "max-content" }} size="small" /> : null}
        {!rows.length ? <Typography.Text type="secondary">暂无资金明细</Typography.Text> : null}
      </div>
    </div>
  );
}
