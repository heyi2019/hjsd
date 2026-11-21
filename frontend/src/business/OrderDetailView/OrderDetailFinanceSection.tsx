import { Descriptions, Input, Typography } from "antd";
import dayjs from "dayjs";
import type { ColumnsType } from "antd/es/table";
import { useMemo } from "react";
import { DataTable, DateField, MoneyText, Select } from "../../shared/ui";
import { OrderDetailMoneyInput } from "./OrderDetailMoneyInput";
import type { EmployeeOption } from "../../shared/api/types/org";
import type { Pool } from "../../shared/api/types/finance";
import type { OrderFinanceRow, OrderDetailMeta } from "./OrderDetail.shared";
import type { FinanceDraft, OrderDraft } from "./editing/use-order-detail-editor";
import { defaultOperatorUserIds } from "./editing/use-order-detail-editor";
import { currentDevUser } from "../../shared/api/client";
import { buildFinanceSelectOptions } from "./finance-options";

const FINANCE_SECTION_TITLE = "费用与资金补充信息";

const FINANCE_COLUMNS: ColumnsType<OrderFinanceRow> = [
  { title: "类型", dataIndex: "type", key: "type", width: "15%" },
  {
    title: "方向",
    dataIndex: "direction",
    key: "direction",
    width: "8%",
    render: (value: OrderFinanceRow["direction"]) => (
      <Typography.Text type={value === "收入" ? "success" : "danger"}>{value}</Typography.Text>
    ),
  },
  {
    title: "金额",
    dataIndex: "amount",
    key: "amount",
    width: "12%",
    align: "right",
    render: (value: string) => <div className="order-detail__cell-amount"><MoneyText value={value} /></div>,
  },
  { title: "时间", dataIndex: "occurredAt", key: "occurredAt", width: "22%" },
  { title: "操作人", dataIndex: "operator", key: "operator", width: "16%" },
  { title: "资金账户", dataIndex: "poolName", key: "poolName", width: "15%" },
  { title: "备注", dataIndex: "note", key: "note", width: "12%" },
];

function editableFinanceColumns(
  drafts: Record<string, FinanceDraft> | undefined,
  onEdit: ((flowNo: string, changes: Partial<Omit<FinanceDraft, "flow_no">>) => void) | undefined,
  employees: EmployeeOption[],
  pools: Pool[],
  defaultOperatorIds: number[],
): ColumnsType<OrderFinanceRow> {
  const options = buildFinanceSelectOptions(employees, pools);
  return FINANCE_COLUMNS.map((column) => {
    if (column.key === "occurredAt") {
      return {
        ...column,
        render: (_value: string, row: OrderFinanceRow) => {
          const draft = drafts?.[row.flowNo];
          const value = draft?.occurred_at ?? row.occurredAt;
          return <DateField className="order-finance-time-input" showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" minuteStep={1} aria-label={`编辑资金明细时间 ${row.flowNo}`} value={value === "-" ? null : dayjs(value)} onChange={(next) => onEdit?.(row.flowNo, { occurred_at: next?.format("YYYY-MM-DDTHH:mm:ss") ?? "" })} />;
        },
      };
    }
    if (column.key === "amount") {
      return {
        ...column,
        render: (_value: string, row: OrderFinanceRow) => {
          if (row.poolId == null) return <MoneyText value={row.amount} />;
          const value = drafts?.[row.flowNo]?.amount ?? row.amount;
          return (
            <OrderDetailMoneyInput
              className="order-finance-amount-input"
              label={`编辑资金明细金额 ${row.flowNo}`}
              value={value}
              onChange={(next) => onEdit?.(row.flowNo, { amount: next })}
            />
          );
        },
      };
    }
    if (column.key === "operator") {
      return {
        ...column,
        render: (_value: string, row: OrderFinanceRow) => (
          <Select
            mode="multiple"
            showSearch
            optionFilterProp="label"
            aria-label={`编辑资金明细操作人 ${row.flowNo}`}
            value={(drafts?.[row.flowNo]?.operator_user_ids ?? row.operatorUserIds ?? []).length ? (drafts?.[row.flowNo]?.operator_user_ids ?? row.operatorUserIds ?? []) : defaultOperatorIds}
            options={options.employees}
            placeholder="默认当前员工，可多选"
            onChange={(ids) => {
              const currentIds = (drafts?.[row.flowNo]?.operator_user_ids ?? row.operatorUserIds ?? []).length ? (drafts?.[row.flowNo]?.operator_user_ids ?? row.operatorUserIds ?? []) : defaultOperatorIds;
              onEdit?.(row.flowNo, { operator_user_ids: (ids as number[]).length ? ids as number[] : currentIds });
            }}
          />
        ),
      };
    }
    if (column.key === "note") {
      return {
        ...column,
        render: (_value: string, row: OrderFinanceRow) => <Input aria-label={`编辑资金明细备注 ${row.flowNo}`} value={drafts?.[row.flowNo]?.note ?? row.note} onChange={(event) => onEdit?.(row.flowNo, { note: event.target.value })} />,
      };
    }
    if (column.key === "poolName") {
      return {
        ...column,
        render: (_value: string, row: OrderFinanceRow) => {
          if (row.poolId == null) return row.poolName;
          const currentPoolId = drafts?.[row.flowNo]?.pool_id ?? row.poolId;
          return (
            <Select
              className="order-finance-pool-select"
              aria-label={`编辑资金明细资金账户 ${row.flowNo}`}
              value={currentPoolId}
              options={options.poolsFor(currentPoolId)}
              onChange={(poolId) => onEdit?.(row.flowNo, { pool_id: poolId as number })}
            />
          );
        },
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
  employees = [],
  pools = [],
  operatorUsername = currentDevUser(),
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
  employees?: EmployeeOption[];
  pools?: Pool[];
  operatorUsername?: string;
}) {
  const defaultOperatorIds = defaultOperatorUserIds(employees, operatorUsername) ?? [];
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
        <DataTable className="order-detail__data-table order-finance-table" columns={editing ? editableFinanceColumns(financeDrafts, onFinanceEdit, employees, pools, defaultOperatorIds) : FINANCE_COLUMNS} rows={rows} page={1} pageSize={10} total={rows.length} onPageChange={() => undefined} pagination={false} rowKey="key" size="small" />
      </div>
    </div>
  );
}
