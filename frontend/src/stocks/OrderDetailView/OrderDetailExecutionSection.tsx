import { Input } from "antd";
import { useMemo } from "react";
import type { ColumnsType } from "antd/es/table";
import type { AccountExecutionEvent } from "../../shared/api/types/account-execution";
import { DataTable, MoneyInput, MoneyText, Select } from "../../shared/ui";
import {
  InventorySectionHeading,
  OPERATION_CATEGORY_LABEL,
  isEditableCashflowEvent,
  type InventoryEmployeeOption,
  type InventoryEventDraft,
  type InventoryExecutionCategory,
  type InventoryExecutionRow,
} from "./OrderDetail.shared";

const CATEGORY_RANK: Record<InventoryExecutionCategory, number> = {
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
  employees,
}: {
  rows: InventoryExecutionRow[];
  editing?: boolean;
  eventDrafts?: Record<number, InventoryEventDraft>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) => void;
  employees: InventoryEmployeeOption[];
}) {
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]),
    [rows],
  );
  const employeeOptions = useMemo(
    () => employees.map((employee) => ({ value: employee.id, label: employee.display_name, disabled: !employee.is_active })),
    [employees],
  );
  const columns = useMemo<ColumnsType<InventoryExecutionRow>>(() => [
    {
      title: "操作分类",
      dataIndex: "category",
      key: "category",
      render: (value: InventoryExecutionCategory) => OPERATION_CATEGORY_LABEL[value],
    },
    { title: "动作", dataIndex: "action", key: "action" },
    { title: "平台", dataIndex: "platform", key: "platform", render: (value: string) => value || "-" },
    { title: "动作时间", dataIndex: "occurredAt", key: "occurredAt" },
    {
      title: "操作人",
      dataIndex: "operator",
      key: "operator",
      render: (value: string, item) => {
        const event = item.event;
        if (!editing || !event) return value;
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
        if (!editing || !event || !isEditableCashflowEvent(event)) return value;
        return <Input aria-label={`编辑执行备注 ${item.action}`} value={eventDrafts?.[event.id]?.note ?? event.note ?? ""} onChange={(inputEvent) => onEventEdit?.(event, { note: inputEvent.target.value })} />;
      },
    },
  ], [editing, eventDrafts, employeeOptions, onEventEdit]);

  return (
    <div className="inventory-detail__section inventory-detail__section--execution inventory-execution-list">
      <InventorySectionHeading title="操作明细" />
      <DataTable className="inventory-detail__data-table inventory-execution-table" columns={columns} rows={sortedRows} page={1} pageSize={10} total={sortedRows.length} onPageChange={() => undefined} pagination={false} rowKey="key" size="small" />
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
