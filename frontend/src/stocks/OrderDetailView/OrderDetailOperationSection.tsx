import { Input, InputNumber, Typography } from "antd";
import dayjs from "dayjs";
import type { ColumnsType } from "antd/es/table";
import { useMemo } from "react";
import { DataTable, DateField, Select } from "../../shared/ui";
import type { AccountExecutionEvent } from "../../shared/api/types/account-execution";
import type { EmployeeOption } from "../../shared/api/types/org";
import type { Account } from "../../shared/api/types/accounts";
import type { InventoryEventDraft } from "./OrderDetail.shared";
import { OrderDetailImageGallery } from "./OrderDetailImageGallery";
import { useOptionSet } from "../../shared/lib/optionSets";
import {
  InventorySectionHeading,
  type OrderDetailMeta,
  type InventoryOperationRow,
} from "./OrderDetail.shared";

const OPERATION_COLUMNS: ColumnsType<InventoryOperationRow> = [
  { title: "动作", dataIndex: "action", key: "action", width: 88 },
  {
    title: "内容",
    dataIndex: "content",
    key: "content",
    onCell: () => ({ className: "inventory-operation-content" }),
    render: (value: InventoryOperationRow["content"]) => value || "-",
  },
  { title: "时间", dataIndex: "occurredAt", key: "occurredAt", width: 142 },
  { title: "操作人", dataIndex: "operator", key: "operator", width: 82 },
];

/** 板块3：运营信息只展示四个可独立登记的动作。 */
export function OrderDetailOperationSection({
  meta,
  editing,
  account,
  eventDrafts,
  onEventEdit,
  onProfileChange,
  employees = [],
  operationEvents,
}: {
  meta: OrderDetailMeta;
  editing?: boolean;
  account?: Account | null;
  eventDrafts?: Record<number, InventoryEventDraft>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) => void;
  onProfileChange?: (changes: Partial<Account>) => void;
  employees?: EmployeeOption[];
  operationEvents?: Record<string, AccountExecutionEvent | undefined>;
}) {
  const platformOptions = useOptionSet("INTERMEDIARY_PLATFORM") ?? [];
  const rows = useMemo<InventoryOperationRow[]>(() => [
    { key: "consignment", action: "上架平台", content: meta.listedPlatform, occurredAt: meta.listedAt, operator: meta.listedOperator, event: operationEvents?.consignment },
    { key: "unlist", action: "下架平台", content: meta.unlistedPlatform, occurredAt: meta.unlistedAt, operator: meta.unlistedOperator, event: operationEvents?.unlist },
    { key: "description", action: "描述", content: meta.accountDescription, occurredAt: meta.descriptionAt, operator: meta.descriptionOperator, event: operationEvents?.description },
    { key: "images", action: "作图", content: <OrderDetailImageGallery images={account?.account_images ?? []} altPrefix="作图" limit={9} />, occurredAt: meta.imagesAt, operator: meta.imagesOperator, event: operationEvents?.images },
  ], [account, meta, operationEvents]);

  if (editing) {
    return (
      <div className="inventory-detail__section inventory-detail__section--operation">
        <InventorySectionHeading title="运营信息" />
        <DataTable
          className="inventory-detail__data-table inventory-operation-table"
          columns={editableOperationColumns(account, eventDrafts, onEventEdit, onProfileChange, employees, platformOptions)}
          rows={rows}
          page={1}
          pageSize={10}
          total={rows.length}
          onPageChange={() => undefined}
          pagination={false}
          rowKey="key"
          size="small"
        />
      </div>
    );
  }

  return (
    <div className="inventory-detail__section inventory-detail__section--operation">
      <div className="inventory-detail__section-heading"><Typography.Text strong>运营信息</Typography.Text></div>
      <DataTable
        className="inventory-detail__data-table inventory-operation-table"
        columns={OPERATION_COLUMNS}
        rows={rows}
        page={1}
        pageSize={10}
        total={rows.length}
        onPageChange={() => undefined}
        pagination={false}
        rowKey="key"
        size="small"
      />
    </div>
  );
}

function editableOperationColumns(
  account: Account | null | undefined,
  drafts: Record<number, InventoryEventDraft> | undefined,
  onEventEdit: ((event: AccountExecutionEvent, changes: { occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) => void) | undefined,
  onProfileChange: ((changes: Partial<Account>) => void) | undefined,
  employees: EmployeeOption[],
  platformOptions: Array<{ value: string; label: string }>,
): ColumnsType<InventoryOperationRow> {
  const platformOptionValues = (current: string[], includeSystem = false) => {
    const options = [...platformOptions];
    if (includeSystem && !options.some((option) => option.value === "__SYSTEM__")) {
      options.push({ value: "__SYSTEM__", label: "本系统" });
    }
    current.filter(Boolean).reverse().forEach((value) => {
      if (!options.some((option) => option.value === value)) options.unshift({ value, label: value });
    });
    return options;
  };
  const platformValues = (value: unknown): string[] => {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  };
  const eventExtra = (row: InventoryOperationRow, draft?: InventoryEventDraft) => (
    draft?.form_extra !== undefined ? (draft.form_extra ?? {}) : (row.event?.form_extra ?? {})
  );
  const updateExtra = (event: AccountExecutionEvent, extra: Record<string, unknown>) => {
    onEventEdit?.(event, { form_extra: extra });
  };
  return [
    { title: "动作", dataIndex: "action", key: "action", width: 88 },
    {
      title: "内容",
      dataIndex: "content",
      key: "content",
      onCell: () => ({ className: "inventory-operation-content" }),
      render: (_value: InventoryOperationRow["content"], row: InventoryOperationRow) => {
        if (row.key === "description") {
          return <Input aria-label="编辑运营描述" value={account?.account_description ?? ""} onChange={(event) => onProfileChange?.({ account_description: event.target.value })} />;
        }
        if (row.key === "images") {
          return (
            <OrderDetailImageGallery
              images={account?.account_images ?? []}
              altPrefix="作图"
              limit={9}
              editing
              onChange={(images) => onProfileChange?.({ account_images: images })}
            />
          );
        }
        if (!row.event) return row.content || "-";
        const draft = drafts?.[row.event.id];
        const extra = eventExtra(row, draft);
        if (row.key === "consignment") {
          const selectedPlatforms = platformValues(extra.consignment_platforms);
          const currentPrice = extra.consignment_price == null || extra.consignment_price === ""
            ? undefined
            : Number(extra.consignment_price);
          return (
            <div className="inventory-operation-edit-fields">
              <Select
                aria-label="编辑上架平台"
                allowClear
                mode="multiple"
                value={selectedPlatforms}
                options={platformOptionValues(selectedPlatforms)}
                placeholder="选择上架平台"
                onChange={(next) => {
                  const nextExtra = { ...extra };
                  if (next.length) {
                    nextExtra.consignment_platforms = next;
                  }
                  else {
                    delete nextExtra.consignment_platforms;
                    delete nextExtra.consignment_price;
                  }
                  updateExtra(row.event!, nextExtra);
                }}
              />
              <InputNumber
                aria-label="编辑寄售价格"
                min={0}
                precision={2}
                value={Number.isFinite(currentPrice) ? currentPrice : null}
                placeholder="寄售价"
                onChange={(next) => {
                  const nextExtra = { ...extra };
                  if (next == null) delete nextExtra.consignment_price;
                  else nextExtra.consignment_price = next;
                  updateExtra(row.event!, nextExtra);
                }}
              />
            </div>
          );
        }
        const currentPlatforms = platformValues(extra.consignment_platforms);
        const currentScope = extra.platform_unlist_scope === "SYSTEM"
          ? ["__SYSTEM__"]
          : currentPlatforms;
        return (
          <Select
            aria-label="编辑下架平台"
            allowClear
            mode="multiple"
            value={currentScope}
            options={platformOptionValues(currentScope.filter((value) => value !== "__SYSTEM__"), true)}
            placeholder="选择下架平台"
            onChange={(next) => {
              const nextExtra = { ...extra };
              if (next.includes("__SYSTEM__")) {
                nextExtra.platform_unlist_scope = "SYSTEM";
                delete nextExtra.consignment_platforms;
              } else if (next.length) {
                nextExtra.platform_unlist_scope = "PLATFORM";
                nextExtra.consignment_platforms = next;
              } else {
                delete nextExtra.platform_unlist_scope;
                delete nextExtra.consignment_platforms;
              }
              updateExtra(row.event!, nextExtra);
            }}
          />
        );
      },
    },
    {
      title: "时间",
      dataIndex: "occurredAt",
      key: "occurredAt",
      width: 142,
      render: (value: string, row: InventoryOperationRow) => {
        if (!row.event) return value;
        const draft = drafts?.[row.event.id];
        const current = draft?.occurred_at ?? row.event.occurred_at ?? "";
        return <DateField showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" minuteStep={1} aria-label={`编辑${row.action}时间`} value={current ? dayjs(current) : null} onChange={(next) => onEventEdit?.(row.event!, { occurred_at: next?.format("YYYY-MM-DDTHH:mm:ss") ?? "" })} />;
      },
    },
    {
      title: "操作人",
      dataIndex: "operator",
      key: "operator",
      width: 120,
      render: (value: string, row: InventoryOperationRow) => {
        if (!row.event) return value;
        return <Select mode="multiple" aria-label={`编辑${row.action}操作人`} value={drafts?.[row.event.id]?.operator_user_ids ?? row.event.operator_user_ids ?? []} options={employees.map((employee) => ({ value: employee.id, label: employee.display_name, disabled: !employee.is_active }))} onChange={(ids) => onEventEdit?.(row.event!, { operator_user_ids: ids })} />;
      },
    },
  ];
}
