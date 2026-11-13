import { Descriptions, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMemo } from "react";
import { CustomFieldSection } from "../../orders/ConfigurableField";
import { DataTable, MoneyText } from "../../shared/ui";
import type { InventoryFinanceRow, OrderDetailMeta } from "./OrderDetail.shared";

const FINANCE_SECTION_TITLE = "费用与资金补充信息";

const FINANCE_COLUMNS: ColumnsType<InventoryFinanceRow> = [
  { title: "类型", dataIndex: "type", key: "type" },
  {
    title: "方向",
    dataIndex: "direction",
    key: "direction",
    render: (value: InventoryFinanceRow["direction"]) => (
      <Typography.Text type={value === "收入" ? "success" : "danger"}>{value}</Typography.Text>
    ),
  },
  {
    title: "金额",
    dataIndex: "amount",
    key: "amount",
    align: "right",
    render: (value: string) => <div className="inventory-detail__cell-amount"><MoneyText value={value} /></div>,
  },
  { title: "时间", dataIndex: "occurredAt", key: "occurredAt" },
  { title: "操作人", dataIndex: "operator", key: "operator" },
  { title: "资金池", dataIndex: "poolName", key: "poolName" },
];

function FinanceExtraFields({ fields }: { fields: OrderDetailMeta["orderExtras"] }) {
  if (!fields.length) return null;
  return (
    <div className="inventory-detail__meta-group">
      <div className="inventory-detail__meta-group-title">{FINANCE_SECTION_TITLE}</div>
      <Descriptions className="inventory-detail__meta-table" size="small" bordered column={4}>
        {fields.map((field) => <Descriptions.Item key={field.key} label={field.label}>{field.value}</Descriptions.Item>)}
      </Descriptions>
    </div>
  );
}

/** 「资金明细」板块：自定义字段分组 + 收支汇总条 + 流水表。 */
export function OrderDetailFinanceSection({
  rows,
  orderExtras,
  expenseCount,
  incomeCount,
  totalExpense,
  totalIncome,
  editing,
}: {
  rows: InventoryFinanceRow[];
  orderExtras: OrderDetailMeta["orderExtras"];
  expenseCount: number;
  incomeCount: number;
  totalExpense: string;
  totalIncome: string;
  editing?: boolean;
}) {
  const financeFields = useMemo(
    () => orderExtras.filter((field) => field.section === "FINANCE"),
    [orderExtras],
  );
  return (
    <div className="inventory-detail__section inventory-detail__section--finance inventory-finance-list">
      <div className="inventory-detail__section-heading inventory-finance-heading">
        <Typography.Text strong>资金明细</Typography.Text>
      </div>
      <div className="inventory-detail__meta">
        {editing ? <CustomFieldSection section="FINANCE" testIdSuffix="inv-edit-finance" /> : null}
        <FinanceExtraFields fields={financeFields} />
        <div className="inventory-finance-summary">
          <div className="inventory-finance-summary__item inventory-finance-summary__item--expense"><span>支出</span><strong>{expenseCount} 笔</strong></div>
          <div className="inventory-finance-summary__item inventory-finance-summary__item--income"><span>收入</span><strong>{incomeCount} 笔</strong></div>
          <div className="inventory-finance-summary__item inventory-finance-summary__item--amount"><span>总支出</span><MoneyText value={totalExpense} /></div>
          <div className="inventory-finance-summary__item inventory-finance-summary__item--amount"><span>总收入</span><MoneyText value={totalIncome} /></div>
        </div>
        <DataTable className="inventory-detail__data-table inventory-finance-table" columns={FINANCE_COLUMNS} rows={rows} page={1} pageSize={10} total={rows.length} onPageChange={() => undefined} pagination={false} rowKey="key" size="small" />
      </div>
    </div>
  );
}
