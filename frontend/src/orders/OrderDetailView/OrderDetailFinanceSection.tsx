import { Descriptions, Input, Typography } from "antd";
import dayjs from "dayjs";
import type { ColumnsType } from "antd/es/table";
import { useMemo } from "react";
import { DataTable, DateField, MoneyText } from "../../shared/ui";
import type { OrderFinanceRow, OrderDetailMeta } from "./OrderDetail.shared";
import type { FinanceDraft, OrderDraft } from "./editing/use-account-execution-editor";

const FINANCE_SECTION_TITLE = "费用与资金补充信息";

const FINANCE_COLUMNS: ColumnsType<OrderFinanceRow> = [
  { title: "类型", dataIndex: "type", key: "type" },
  {
    title: "方向",
    dataIndex: "direction",
    key: "direction",
    render: (value: OrderFinanceRow["direction"]) => (
      <Typography.Text type={value === "收入" ? "success" : "danger"}>{value}</Typography.Text>
    ),
  },
  {
    title: "金额",
    dataIndex: "amount",
    key: "amount",
    align: "right",
    render: (value: string) => <div className="order-detail__cell-amount"><MoneyText value={value} /></div>,
  },
  { title: "时间", dataIndex: "occurredAt", key: "occurredAt" },
  { title: "操作人", dataIndex: "operator", key: "operator" },
  { title: "资金池", dataIndex: "poolName", key: "poolName" },
  { title: "备注", dataIndex: "note", key: "note" },
];

function editableFinanceColumns(
  drafts: Record<string, FinanceDraft> | undefined,
  onEdit: ((flowNo: string, changes: Partial<Omit<FinanceDraft, "flow_no">>) => void) | undefined,
): ColumnsType<OrderFinanceRow> {
  return FINANCE_COLUMNS.map((column) => {
    if (column.key === "时间") {
      return {
        ...column,
        render: (_value: string, row: OrderFinanceRow) => {
          const draft = drafts?.[row.flowNo];
          const value = draft?.occurred_at ?? row.occurredAt;
          return <DateField showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" minuteStep={1} aria-label={`编辑资金明细时间 ${row.flowNo}`} value={value === "-" ? null : dayjs(value)} onChange={(next) => onEdit?.(row.flowNo, { occurred_at: next?.format("YYYY-MM-DDTHH:mm:ss") ?? "" })} />;
        },
      };
    }
    if (column.key === "操作人") {
      return {
        ...column,
        render: (_value: string, row: OrderFinanceRow) => <Input aria-label={`编辑资金明细操作人 ${row.flowNo}`} value={drafts?.[row.flowNo]?.operator ?? row.operator} onChange={(event) => onEdit?.(row.flowNo, { operator: event.target.value })} />,
      };
    }
    if (column.key === "备注") {
      return {
        ...column,
        render: (_value: string, row: OrderFinanceRow) => <Input aria-label={`编辑资金明细备注 ${row.flowNo}`} value={drafts?.[row.flowNo]?.note ?? row.note} onChange={(event) => onEdit?.(row.flowNo, { note: event.target.value })} />,
      };
    }
    return column;
  });
}

function FinanceExtraFields({
  fields,
  editing,
  draft,
  onChange,
}: {
  fields: OrderDetailMeta["orderExtras"];
  editing?: boolean;
  draft?: OrderDraft;
  onChange?: (key: string, value: string) => void;
}) {
  if (!fields.length) return null;
  return (
    <div className="order-detail__meta-group">
      <div className="order-detail__meta-group-title">{FINANCE_SECTION_TITLE}</div>
      <Descriptions className="order-detail__meta-table" size="small" bordered column={4}>
        {fields.map((field) => <Descriptions.Item key={field.key} label={field.label}>
          {editing ? (
            <Input
              aria-label={`编辑${field.label}`}
              value={String(draft?.form_extra?.[field.key] ?? field.value ?? "")}
              onChange={(event) => onChange?.(field.key, event.target.value)}
            />
          ) : field.value}
        </Descriptions.Item>)}
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
  financeDrafts,
  onFinanceEdit,
  orderDraft,
  onOrderExtraChange,
}: {
  rows: OrderFinanceRow[];
  orderExtras: OrderDetailMeta["orderExtras"];
  expenseCount: number;
  incomeCount: number;
  totalExpense: string;
  totalIncome: string;
  editing?: boolean;
  financeDrafts?: Record<string, FinanceDraft>;
  onFinanceEdit?: (flowNo: string, changes: Partial<Omit<FinanceDraft, "flow_no">>) => void;
  orderDraft?: OrderDraft;
  onOrderExtraChange?: (key: string, value: unknown) => void;
}) {
  const financeFields = useMemo(
    () => orderExtras.filter((field) => field.section === "FINANCE"),
    [orderExtras],
  );
  return (
    <div className="order-detail__section order-detail__section--finance order-finance-list">
      <div className="order-detail__section-heading order-finance-heading">
        <Typography.Text strong>资金明细</Typography.Text>
      </div>
      <div className="order-detail__meta">
        <FinanceExtraFields fields={financeFields} editing={editing} draft={orderDraft} onChange={onOrderExtraChange} />
        <div className="order-finance-summary">
          <div className="order-finance-summary__item order-finance-summary__item--expense"><span>支出</span><strong>{expenseCount} 笔</strong></div>
          <div className="order-finance-summary__item order-finance-summary__item--income"><span>收入</span><strong>{incomeCount} 笔</strong></div>
          <div className="order-finance-summary__item order-finance-summary__item--amount"><span>总支出</span><MoneyText value={totalExpense} /></div>
          <div className="order-finance-summary__item order-finance-summary__item--amount"><span>总收入</span><MoneyText value={totalIncome} /></div>
        </div>
        <DataTable className="order-detail__data-table order-finance-table" columns={editing ? editableFinanceColumns(financeDrafts, onFinanceEdit) : FINANCE_COLUMNS} rows={rows} page={1} pageSize={10} total={rows.length} onPageChange={() => undefined} pagination={false} rowKey="key" size="small" />
      </div>
    </div>
  );
}
