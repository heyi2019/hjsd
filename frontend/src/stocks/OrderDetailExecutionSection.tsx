import { Input, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { AccountExecutionEvent } from "../shared/api/catalog";
import { DataTable, MoneyInput, MoneyText, Select } from "../shared/ui";
import {
  InventorySectionHeading,
  OPERATION_CATEGORY_LABEL,
  isEditableCashflowEvent,
  type InventoryEmployeeOption,
  type InventoryEventDraft,
  type InventoryExecutionCategory,
  type InventoryExecutionRow,
} from "./OrderDetail.shared";

const CATEGORY_ORDER: InventoryExecutionCategory[] = ["BUY_IN", "OPERATING", "SELL_OUT"];

/** 板块5：操作明细（买号入库 / 账号运营 / 卖号出库），按事件类型归类，含操作人列。 */
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
  const sortedRows = [...rows].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  const columns: ColumnsType<InventoryExecutionRow> = [
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
      render: (value: string, item) => editing ? (
        <MultipleOperatorSelect
          value={eventDrafts?.[item.event.id]?.operator_user_ids ?? item.event.operator_user_ids ?? []}
          employees={employees}
          placeholder={value}
          onChange={(ids) => onEventEdit?.(item.event, { operator_user_ids: ids })}
        />
      ) : value,
    },
    {
      title: "金额",
      dataIndex: "amount",
      key: "amount",
      align: "right",
      render: (value: string, item) => editing && isEditableCashflowEvent(item.event) ? (
        <MoneyInput
          aria-label={`编辑执行金额 ${item.action}`}
          value={eventDrafts?.[item.event.id]?.amount ?? value}
          status={/^\d*(\.\d{0,2})?$/.test(eventDrafts?.[item.event.id]?.amount ?? "") ? undefined : "error"}
          onChange={(event) => {
            const nextValue = event.target.value;
            if (nextValue === "" || /^\d*(\.\d{0,2})?$/.test(nextValue)) onEventEdit?.(item.event, { amount: nextValue });
          }}
        />
      ) : <MoneyText value={value} />,
    },
    {
      title: "备注",
      dataIndex: "note",
      key: "note",
      render: (value: string, item) => editing && isEditableCashflowEvent(item.event) ? (
        <Input aria-label={`编辑执行备注 ${item.action}`} value={eventDrafts?.[item.event.id]?.note ?? item.event.note ?? ""} onChange={(event) => onEventEdit?.(item.event, { note: event.target.value })} />
      ) : value,
    },
  ];

  return (
    <div className="inventory-detail__section inventory-detail__section--execution inventory-execution-list">
      <InventorySectionHeading title="操作明细" />
      <div className="inventory-detail__meta">
        {sortedRows.length ? <DataTable className="inventory-execution-table" columns={columns} rows={sortedRows} page={1} pageSize={10} total={sortedRows.length} onPageChange={() => undefined} pagination={false} rowKey="key" scroll={{ x: "max-content" }} size="small" /> : <Typography.Text type="secondary">暂无已执行事件</Typography.Text>}
      </div>
    </div>
  );
}

function MultipleOperatorSelect({
  value,
  employees,
  placeholder,
  onChange,
}: {
  value: number[];
  employees: InventoryEmployeeOption[];
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
      options={employees.map((employee) => ({ value: employee.id, label: employee.display_name, disabled: !employee.is_active }))}
      onChange={onChange}
    />
  );
}
