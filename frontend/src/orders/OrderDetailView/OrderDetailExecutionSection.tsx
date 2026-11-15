import { Input } from "antd";
import dayjs from "dayjs";
import { useMemo } from "react";
import type { ColumnsType } from "antd/es/table";
import type { AccountExecutionEvent } from "../../shared/api/types/account-execution";
import type { OrderDraft } from "./editing/use-order-detail-editor";
import { DataTable, DateField, MoneyInput, MoneyText, Select } from "../../shared/ui";
import {
  OrderSectionHeading,
  OPERATION_CATEGORY_LABEL,
  isEditableCashflowEvent,
  resolveExecutionPlatform,
  type OrderEmployeeOption,
  type OrderEventDraft,
  type OrderExecutionCategory,
  type OrderExecutionRow,
} from "./OrderDetail.shared";

const CATEGORY_RANK: Record<OrderExecutionCategory, number> = {
  INBOUND: 0,
  OPERATING: 1,
  OUTBOUND: 2,
};

/** 操作明细（账号入库 / 账号运营 / 账号出库），含操作人列。 */
export function OrderDetailExecutionSection({
  rows,
  editing,
  eventDrafts,
  onEventEdit,
  orderDrafts,
  onOrderEdit,
  employees,
}: {
  rows: OrderExecutionRow[];
  editing?: boolean;
  eventDrafts?: Record<number, OrderEventDraft>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) => void;
  orderDrafts?: Record<number, OrderDraft>;
  onOrderEdit?: (orderId: number, changes: Partial<Omit<OrderDraft, "order_id">>) => void;
  employees: OrderEmployeeOption[];
}) {
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]),
    [rows],
  );
  const employeeOptions = useMemo(
    () => employees.map((employee) => ({ value: employee.id, label: employee.display_name, disabled: !employee.is_active })),
    [employees],
  );
  const columns = useMemo<ColumnsType<OrderExecutionRow>>(() => [
    {
      title: "操作分类",
      dataIndex: "category",
      key: "category",
      render: (value: OrderExecutionCategory) => OPERATION_CATEGORY_LABEL[value],
    },
    { title: "动作", dataIndex: "action", key: "action" },
    {
      title: "平台",
      dataIndex: "platform",
      key: "platform",
      render: (value: string, item) => resolveExecutionPlatform(value, item.event, item.event ? eventDrafts?.[item.event.id] : undefined),
    },
    {
      title: "动作时间",
      dataIndex: "occurredAt",
      key: "occurredAt",
      render: (value: string, item) => {
        const event = item.event;
        if (!editing) return value;
        const draftValue = event
          ? eventDrafts?.[event.id]?.occurred_at ?? event.occurred_at ?? ""
          : orderDrafts?.[item.orderId]?.occurred_at || value;
        return (
          <DateField
            showTime={{ format: "HH:mm" }}
            format="YYYY-MM-DD HH:mm"
            minuteStep={1}
            aria-label={`编辑执行时间 ${item.action}`}
            value={draftValue ? dayjs(draftValue) : null}
            onChange={(next) => event
              ? onEventEdit?.(event, { occurred_at: next?.format("YYYY-MM-DDTHH:mm:ss") ?? "" })
              : onOrderEdit?.(item.orderId, { occurred_at: next?.format("YYYY-MM-DDTHH:mm:ss") ?? "" })}
          />
        );
      },
    },
    {
      title: "操作人",
      dataIndex: "operator",
      key: "operator",
      render: (value: string, item) => {
        const event = item.event;
        if (!editing) return value;
        if (!event) {
          return (
            <Select
              aria-label={`编辑执行操作人 ${item.action}`}
              value={orderDrafts?.[item.orderId]?.operator || (item.operator === "-" ? undefined : item.operator)}
              options={employees.map((employee) => ({ value: employee.username, label: employee.display_name, disabled: !employee.is_active }))}
              onChange={(username) => onOrderEdit?.(item.orderId, { operator: String(username) })}
            />
          );
        }
        return (
          <MultipleOperatorSelect
            value={eventDrafts?.[event.id]?.operator_user_ids ?? event.operator_user_ids ?? []}
            options={employeeOptions}
            placeholder={value}
            onChange={(ids) => onEventEdit?.(event, { operator_user_ids: ids })}
          />
        );
      },
    },
    {
      title: "金额",
      dataIndex: "amount",
      key: "amount",
      align: "right",
      render: (value: string, item) => {
        const event = item.event;
        if (!editing || !event || !isEditableCashflowEvent(event)) return <MoneyText value={value} />;
        return (
          <MoneyInput
            aria-label={`编辑执行金额 ${item.action}`}
            value={eventDrafts?.[event.id]?.amount ?? value}
            status={/^\d*(\.\d{0,2})?$/.test(eventDrafts?.[event.id]?.amount ?? "") ? undefined : "error"}
            onChange={(inputEvent) => {
              const nextValue = inputEvent.target.value;
              if (nextValue === "" || /^\d*(\.\d{0,2})?$/.test(nextValue)) onEventEdit?.(event, { amount: nextValue });
            }}
          />
        );
      },
    },
    {
      title: "备注",
      dataIndex: "note",
      key: "note",
      render: (value: string, item) => {
        const event = item.event;
        if (!editing) return value;
        if (!event) {
          return (
            <Input
              aria-label={`编辑执行备注 ${item.action}`}
              value={orderDrafts?.[item.orderId]?.note ?? (value === "-" ? "" : value)}
              onChange={(inputEvent) => onOrderEdit?.(item.orderId, { note: inputEvent.target.value })}
            />
          );
        }
        return <Input aria-label={`编辑执行备注 ${item.action}`} value={eventDrafts?.[event.id]?.note ?? event.note ?? ""} onChange={(inputEvent) => onEventEdit?.(event, { note: inputEvent.target.value })} />;
      },
    },
  ], [editing, eventDrafts, employeeOptions, employees, onEventEdit, onOrderEdit, orderDrafts]);

  return (
    <div className="order-detail__section order-detail__section--execution inventory-execution-list">
      <OrderSectionHeading title="操作明细" />
      <DataTable className="order-detail__data-table inventory-execution-table" columns={columns} rows={sortedRows} page={1} pageSize={10} total={sortedRows.length} onPageChange={() => undefined} pagination={false} rowKey="key" size="small" />
    </div>
  );
}

function MultipleOperatorSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: number[];
  options: Array<{ value: number; label: string; disabled: boolean }>;
  placeholder: string;
  onChange: (ids: number[]) => void;
}) {
  return (
    <Select
      className="inventory-edit-operator"
      mode="multiple"
      aria-label="编辑执行操作人"
      placeholder={placeholder}
      value={value}
      options={options}
      onChange={onChange}
    />
  );
}
