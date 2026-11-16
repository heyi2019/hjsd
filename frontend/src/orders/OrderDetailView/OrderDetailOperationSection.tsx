import { Input, InputNumber, Space, Typography } from "antd";
import dayjs from "dayjs";
import type { ColumnsType } from "antd/es/table";
import { useMemo } from "react";
import { DataTable, DateField, PermissionButton, Select } from "../../shared/ui";
import type { AccountExecutionEvent } from "../../shared/api/types/account-execution";
import type { EmployeeOption } from "../../shared/api/types/org";
import type { Account } from "../../shared/api/types/accounts";
import type { OrderEventDraft, OrderOperationDraft, OrderOperationKey, OrderOperationRow } from "./OrderDetail.shared";
import { OrderDetailImageGallery } from "./OrderDetailImageGallery";
import { useOptionSet } from "../../shared/lib/optionSets";
import { OrderSectionHeading, type OrderDetailMeta } from "./OrderDetail.shared";

const OPERATION_COLUMNS: ColumnsType<OrderOperationRow> = [
  { title: "动作", dataIndex: "action", key: "action", width: 88 },
  { title: "内容", dataIndex: "content", key: "content", onCell: () => ({ className: "order-operation-content" }), render: (value: OrderOperationRow["content"]) => value || "-" },
  { title: "时间", dataIndex: "occurredAt", key: "occurredAt", width: 142 },
  { title: "操作人", dataIndex: "operator", key: "operator", width: 82 },
];

const OPERATION_TYPE_BY_KEY: Record<OrderOperationKey, NonNullable<OrderOperationDraft["operation_type"]>> = {
  consignment: "CONSIGNMENT", unlist: "UNLIST", description: "DESCRIPTION", images: "IMAGE",
};
const OPERATION_KEY_BY_TYPE: Record<NonNullable<OrderOperationDraft["operation_type"]>, OrderOperationKey> = {
  CONSIGNMENT: "consignment", UNLIST: "unlist", DESCRIPTION: "description", IMAGE: "images",
};

/** 运营信息展示四类动作；上架/下架允许同一账号拥有多条平台记录。 */
export function OrderDetailOperationSection({
  meta, editing, account, eventDrafts, operationDrafts, onEventEdit, onOperationEdit, onAddOperationRow, onProfileChange, employees = [], operationEvents,
}: {
  meta: OrderDetailMeta;
  editing?: boolean;
  account?: Account | null;
  eventDrafts?: Record<number, OrderEventDraft>;
  operationDrafts?: Partial<Record<string, OrderOperationDraft>>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) => void;
  onOperationEdit?: (key: string, changes: Partial<OrderOperationDraft>) => void;
  onAddOperationRow?: (operationType: NonNullable<OrderOperationDraft["operation_type"]>) => void;
  onProfileChange?: (changes: Partial<Account>) => void;
  employees?: EmployeeOption[];
  operationEvents?: Record<string, AccountExecutionEvent[]>;
}) {
  const platformOptions = useOptionSet("INTERMEDIARY_PLATFORM") ?? [];
  const rows = useMemo<OrderOperationRow[]>(() => {
    const makeRows = (operationKey: OrderOperationKey, action: string, content: OrderOperationRow["content"], occurredAt: string, operator: string) => {
      const events = operationEvents?.[operationKey] ?? [];
      const editableEvents = operationKey === "consignment" || operationKey === "unlist" ? events : events.slice(0, 1);
      if (!editableEvents.length) return [{ key: operationKey, operationKey, action, content, occurredAt, operator }];
      return editableEvents.map((event, index) => ({
        key: `${operationKey}-${event.id}`, operationKey, action, content,
        occurredAt: event.occurred_at ?? occurredAt,
        operator: event.operator_names?.join("、") || event.operator || operator,
        event, events: [event], ariaLabelSuffix: index ? ` ${index + 1}` : "",
      }));
    };
    const createdRows: OrderOperationRow[] = Object.entries(operationDrafts ?? {}).filter(([key]) => key.startsWith("new:")).flatMap(([key, draft]) => {
      if (!draft) return [];
      const operationKey = draft.operation_type ? OPERATION_KEY_BY_TYPE[draft.operation_type] : "consignment";
      const action = operationKey === "consignment" ? "上架平台" : operationKey === "unlist" ? "下架平台" : operationKey === "description" ? "描述" : "作图";
      return [{ key, operationKey, action, content: "-", occurredAt: "", operator: "-", ariaLabelSuffix: ` ${key.split(":").pop() ?? "新增"}` }];
    });
    return [
      ...makeRows("consignment", "上架平台", meta.listedPlatform, meta.listedAt, meta.listedOperator),
      ...makeRows("unlist", "下架平台", meta.unlistedPlatform, meta.unlistedAt, meta.unlistedOperator),
      ...makeRows("description", "描述", meta.accountDescription, meta.descriptionAt, meta.descriptionOperator),
      ...makeRows("images", "作图", <OrderDetailImageGallery images={account?.account_images ?? []} altPrefix="作图" limit={9} />, meta.imagesAt, meta.imagesOperator),
      ...createdRows,
    ];
  }, [account, meta, operationDrafts, operationEvents]);

  if (editing) {
    return <div className="order-detail__section order-detail__section--operation">
      <Space className="order-detail__section-heading" align="center">
        <OrderSectionHeading title="运营信息" />
        <PermissionButton permission="order.update" type="link" size="small" onClick={() => onAddOperationRow?.("CONSIGNMENT")}>+ 添加上架行</PermissionButton>
        <PermissionButton permission="order.update" type="link" size="small" onClick={() => onAddOperationRow?.("UNLIST")}>+ 添加下架行</PermissionButton>
      </Space>
      <DataTable className="order-detail__data-table order-operation-table" columns={editableOperationColumns(account, eventDrafts, operationDrafts, onEventEdit, onOperationEdit, onProfileChange, employees, platformOptions)} rows={rows} page={1} pageSize={20} total={rows.length} onPageChange={() => undefined} pagination={false} rowKey="key" size="small" />
    </div>;
  }
  return <div className="order-detail__section order-detail__section--operation">
    <div className="order-detail__section-heading"><Typography.Text strong>运营信息</Typography.Text></div>
    <DataTable className="order-detail__data-table order-operation-table" columns={OPERATION_COLUMNS} rows={rows} page={1} pageSize={20} total={rows.length} onPageChange={() => undefined} pagination={false} rowKey="key" size="small" />
  </div>;
}

function editableOperationColumns(
  account: Account | null | undefined,
  drafts: Record<number, OrderEventDraft> | undefined,
  operationDrafts: Partial<Record<string, OrderOperationDraft>> | undefined,
  onEventEdit: ((event: AccountExecutionEvent, changes: { occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) => void) | undefined,
  onOperationEdit: ((key: string, changes: Partial<OrderOperationDraft>) => void) | undefined,
  onProfileChange: ((changes: Partial<Account>) => void) | undefined,
  employees: EmployeeOption[],
  platformOptions: Array<{ value: string; label: string }>,
): ColumnsType<OrderOperationRow> {
  const platformOptionValues = (current: string[], includeSystem = false) => {
    const options = [...platformOptions];
    if (includeSystem && !options.some((option) => option.value === "__SYSTEM__")) options.push({ value: "__SYSTEM__", label: "本系统" });
    current.filter(Boolean).reverse().forEach((value) => { if (!options.some((option) => option.value === value)) options.unshift({ value, label: value }); });
    return options;
  };
  const platformValues = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const eventExtra = (row: OrderOperationRow, draft?: OrderEventDraft) => draft?.form_extra !== undefined ? (draft.form_extra ?? {}) : (row.event?.form_extra ?? {});
  const operationType = (row: OrderOperationRow) => OPERATION_TYPE_BY_KEY[row.operationKey ?? "consignment"];
  const updateExtra = (row: OrderOperationRow, extra: Record<string, unknown>) => row.event ? onEventEdit?.(row.event, { form_extra: extra }) : onOperationEdit?.(row.key, { form_extra: extra, operation_type: operationType(row) });
  const updateOperation = (row: OrderOperationRow, changes: Partial<OrderOperationDraft>) => row.event ? onEventEdit?.(row.event, changes) : onOperationEdit?.(row.key, { ...changes, operation_type: operationType(row) });
  return [
    { title: "动作", dataIndex: "action", key: "action", width: 88 },
    {
      title: "内容", dataIndex: "content", key: "content", onCell: () => ({ className: "order-operation-content" }),
      render: (_value: OrderOperationRow["content"], row: OrderOperationRow) => {
        if (row.operationKey === "description") return <Input aria-label="编辑运营描述" value={account?.account_description ?? ""} onChange={(event) => onProfileChange?.({ account_description: event.target.value })} />;
        if (row.operationKey === "images") return <OrderDetailImageGallery images={account?.account_images ?? []} altPrefix="作图" limit={9} editing onChange={(images) => onProfileChange?.({ account_images: images })} />;
        const draft = row.event ? drafts?.[row.event.id] : operationDrafts?.[row.key];
        const extra = row.event ? eventExtra(row, draft as OrderEventDraft | undefined) : (draft?.form_extra ?? {});
        if (row.operationKey === "consignment") {
          const selectedPlatforms = platformValues(extra.consignment_platforms);
          const currentPrice = extra.consignment_price == null || extra.consignment_price === "" ? undefined : Number(extra.consignment_price);
          return <div className="order-operation-edit-fields"><Select aria-label={`编辑上架平台${row.ariaLabelSuffix ?? ""}`} allowClear value={selectedPlatforms[0]} options={platformOptionValues(selectedPlatforms)} placeholder="选择上架平台" onChange={(next) => { const nextExtra = { ...extra }; if (next) nextExtra.consignment_platforms = [next]; else { delete nextExtra.consignment_platforms; delete nextExtra.consignment_price; } updateExtra(row, nextExtra); }} /><InputNumber aria-label={`编辑寄售价格${row.ariaLabelSuffix ?? ""}`} min={0} precision={2} value={Number.isFinite(currentPrice) ? currentPrice : null} placeholder="寄售价" onChange={(next) => { const nextExtra = { ...extra }; if (next == null) delete nextExtra.consignment_price; else nextExtra.consignment_price = next; updateExtra(row, nextExtra); }} /></div>;
        }
        const currentPlatforms = platformValues(extra.consignment_platforms);
        const currentScope = extra.platform_unlist_scope === "SYSTEM" ? ["__SYSTEM__"] : currentPlatforms;
        return <Select aria-label={`编辑下架平台${row.ariaLabelSuffix ?? ""}`} allowClear value={currentScope[0]} options={platformOptionValues(currentScope.filter((value) => value !== "__SYSTEM__"), true)} placeholder="选择下架平台" onChange={(next) => { const nextExtra = { ...extra }; if (next === "__SYSTEM__") { nextExtra.platform_unlist_scope = "SYSTEM"; delete nextExtra.consignment_platforms; } else if (next) { nextExtra.platform_unlist_scope = "PLATFORM"; nextExtra.consignment_platforms = [next]; } else { delete nextExtra.platform_unlist_scope; delete nextExtra.consignment_platforms; } updateExtra(row, nextExtra); }} />;
      },
    },
    {
      title: "时间", dataIndex: "occurredAt", key: "occurredAt", width: 142,
      render: (_value: string, row: OrderOperationRow) => { const draft = row.event ? drafts?.[row.event.id] : operationDrafts?.[row.key]; const current = draft?.occurred_at ?? row.event?.occurred_at ?? ""; return <DateField showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" minuteStep={1} aria-label={`编辑${row.action}时间${row.ariaLabelSuffix ?? ""}`} value={current ? dayjs(current) : null} onChange={(next) => updateOperation(row, { occurred_at: next?.format("YYYY-MM-DDTHH:mm:ss") ?? "" })} />; },
    },
    {
      title: "操作人", dataIndex: "operator", key: "operator", width: 120,
      render: (_value: string, row: OrderOperationRow) => { const draft = row.event ? drafts?.[row.event.id] : operationDrafts?.[row.key]; return <Select mode="multiple" aria-label={`编辑${row.action}操作人${row.ariaLabelSuffix ?? ""}`} value={draft?.operator_user_ids ?? row.event?.operator_user_ids ?? []} options={employees.map((employee) => ({ value: employee.id, label: employee.display_name, disabled: !employee.is_active }))} onChange={(ids) => updateOperation(row, { operator_user_ids: ids })} />; },
    },
  ];
}
