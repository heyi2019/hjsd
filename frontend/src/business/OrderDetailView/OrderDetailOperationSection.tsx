import { Input, InputNumber, Space, Typography } from "antd";
import dayjs from "dayjs";
import type { ColumnsType } from "antd/es/table";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { DataTable, DateField, PermissionButton, Select } from "../../shared/ui";
import type { AccountExecutionEvent, AccountExecutionOrder } from "../../shared/api/types/account-execution";
import type { EmployeeOption } from "../../shared/api/types/org";
import type { Account } from "../../shared/api/types/accounts";
import type { OrderEventDraft, OrderOperationDraft, OrderOperationKey, OrderOperationRow } from "./OrderDetail.shared";
import { OrderDetailImageGallery } from "./OrderDetailImageGallery";
import { useOptionSet } from "../../shared/lib/optionSets";
import { OrderSectionHeading, OPERATION_KEY_BY_TYPE, OPERATION_TYPE_BY_KEY, type OrderDetailMeta } from "./OrderDetail.shared";
import { defaultOperatorUserIds } from "./editing/use-order-detail-editor";
import { currentDevUser } from "../../shared/api/client";
import { activeConsignmentListings } from "../operations/consignment-logic";

const OPERATION_COLUMNS: ColumnsType<OrderOperationRow> = [
  { title: "动作", dataIndex: "action", key: "action", width: 88 },
  { title: "内容", dataIndex: "content", key: "content", onCell: () => ({ className: "order-operation-content" }), render: (value: OrderOperationRow["content"]) => value || "-" },
  { title: "时间", dataIndex: "occurredAt", key: "occurredAt", width: 142 },
  { title: "操作人", dataIndex: "operator", key: "operator", width: 82 },
];

function operationPlatforms(extra: Record<string, unknown>): string[] {
  return Array.isArray(extra.consignment_platforms)
    ? extra.consignment_platforms.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

/** 运营明细每一行按自己的事件数据展示，不能复用最新一条记录的内容。 */
export function resolveOperationEventContent(
  operationKey: OrderOperationKey,
  fallback: ReactNode,
  event: Pick<AccountExecutionEvent, "event_type" | "operation_type" | "form_extra" | "reason">,
): ReactNode {
  const extra = event.form_extra ?? {};
  const platforms = operationPlatforms(extra);
  if (operationKey === "consignment" && event.operation_type === "CONSIGNMENT") {
    const platform = platforms.join("、");
    const price = extra.consignment_price;
    if (price !== undefined && price !== null && price !== "") {
      const numericPrice = Number(price);
      const priceText = Number.isFinite(numericPrice)
        ? numericPrice.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : String(price);
      return platform ? `${platform} / 寄售价 ¥${priceText}` : `寄售价 ¥${priceText}`;
    }
    return platform || fallback;
  }
  if (operationKey === "unlist" && event.operation_type === "UNLIST") {
    const target = extra.platform_unlist_scope === "SYSTEM" ? "本系统" : platforms.join("、") || fallback;
    if (!event.reason?.trim()) return target;
    return typeof target === "string" ? `${target} / 下架原因：${event.reason.trim()}` : <>{target} / 下架原因：{event.reason.trim()}</>;
  }
  return fallback;
}

/** 运营信息展示四类动作；上架/下架允许同一账号拥有多条平台记录。 */
export function OrderDetailOperationSection({
  meta, editing, account, orderType, eventDrafts, operationDrafts, onEventEdit, onOperationEdit, onAddOperationRow, onRemoveOperationRow, onProfileChange, employees = [], operationEvents, operatorUsername = currentDevUser(),
}: {
  meta: OrderDetailMeta;
  editing?: boolean;
  account?: Account | null;
  orderType?: string | null;
  eventDrafts?: Record<number, OrderEventDraft>;
  operationDrafts?: Partial<Record<string, OrderOperationDraft>>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) => void;
  onOperationEdit?: (key: string, changes: Partial<OrderOperationDraft>) => void;
  onAddOperationRow?: (operationType: NonNullable<OrderOperationDraft["operation_type"]>) => void;
  onRemoveOperationRow?: (key: string) => void;
  onProfileChange?: (changes: Partial<Account>) => void;
  employees?: EmployeeOption[];
  operationEvents?: Record<string, AccountExecutionEvent[]>;
  operatorUsername?: string;
}) {
  const platformOptions = useOptionSet("INTERMEDIARY_PLATFORM") ?? [];
  const defaultOperatorIds = defaultOperatorUserIds(employees, operatorUsername) ?? [];
  const activeListings = activeConsignmentListings({
    order_id: meta.orderId ?? 0, order_no: "", status: "ACTIVE",
    events: [...(operationEvents?.consignment ?? []), ...(operationEvents?.unlist ?? [])],
  } as AccountExecutionOrder);
  const rows = useMemo<OrderOperationRow[]>(() => {
    const makeRows = (operationKey: OrderOperationKey, action: string, content: OrderOperationRow["content"], occurredAt: string, operator: string) => {
      const events = operationEvents?.[operationKey] ?? [];
      const editableEvents = operationKey === "consignment" || operationKey === "unlist" ? events : events.slice(0, 1);
      if (!editableEvents.length) return [{ key: operationKey, operationKey, action, content, occurredAt, operator }];
      return editableEvents.map((event, index) => ({
        key: `${operationKey}-${event.id}`, operationKey, action, content: resolveOperationEventContent(operationKey, content, event),
        occurredAt: event.occurred_at ?? occurredAt,
        operator: event.operator_names?.join("、") || event.operator || operator,
        event, events: [event], ariaLabelSuffix: index ? ` ${index + 1}` : "",
      }));
    };
    const createdRowsByOperation = Object.entries(operationDrafts ?? {}).filter(([key]) => key.startsWith("new:")).reduce<Record<OrderOperationKey, OrderOperationRow[]>>((groups, [key, draft]) => {
      if (!draft) return groups;
      const operationKey = draft.operation_type ? OPERATION_KEY_BY_TYPE[draft.operation_type] : "consignment";
      const action = operationKey === "consignment" ? "上架平台" : operationKey === "unlist" ? "下架平台" : operationKey === "description" ? "描述" : "作图";
      groups[operationKey].push({ key, operationKey, action, content: "-", occurredAt: "", operator: "-", ariaLabelSuffix: ` ${key.split(":").pop() ?? "新增"}` });
      return groups;
    }, { consignment: [], unlist: [], description: [], images: [] });
    const createdRows = (operationKey: OrderOperationKey) => createdRowsByOperation[operationKey];
    return [
      ...makeRows("consignment", "上架平台", meta.listedPlatform, meta.listedAt, meta.listedOperator), ...createdRows("consignment"),
      ...makeRows("unlist", "下架平台", meta.unlistedPlatform, meta.unlistedAt, meta.unlistedOperator), ...createdRows("unlist"),
      ...makeRows("description", "描述", meta.accountDescription, meta.descriptionAt, meta.descriptionOperator), ...createdRows("description"),
      ...makeRows("images", "作图", <OrderDetailImageGallery images={account?.account_images ?? []} altPrefix="作图" limit={9} />, meta.imagesAt, meta.imagesOperator), ...createdRows("images"),
    ];
  }, [account, meta, operationDrafts, operationEvents]);

  if (editing) {
    return <div className="order-detail__section order-detail__section--operation">
      <Space className="order-detail__section-heading" align="center">
        <OrderSectionHeading title="运营信息" />
        <PermissionButton permission="order.update" type="link" size="small" onClick={() => onAddOperationRow?.("CONSIGNMENT")}>+ 添加上架行</PermissionButton>
        <PermissionButton permission="order.update" type="link" size="small" onClick={() => onAddOperationRow?.("UNLIST")}>+ 添加下架行</PermissionButton>
      </Space>
      {orderType === "DG" && <Typography.Text type="secondary">本系统下架请通过「下架」操作办理</Typography.Text>}
      <DataTable className="order-detail__data-table order-operation-table" columns={editableOperationColumns(account, eventDrafts, operationDrafts, onEventEdit, onOperationEdit, onRemoveOperationRow, onProfileChange, employees, platformOptions, defaultOperatorIds, activeListings)} rows={rows} page={1} pageSize={20} total={rows.length} onPageChange={() => undefined} pagination={false} rowKey="key" size="small" />
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
  onRemoveOperationRow: ((key: string) => void) | undefined,
  onProfileChange: ((changes: Partial<Account>) => void) | undefined,
  employees: EmployeeOption[],
  platformOptions: Array<{ value: string; label: string }>,
  defaultOperatorIds: number[],
  activeListings: ReturnType<typeof activeConsignmentListings>,
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
        if (row.operationKey === "images") return <OrderDetailImageGallery images={account?.account_images ?? []} altPrefix="作图" ownerKey={account?.id} limit={9} editing onChange={(images) => onProfileChange?.({ account_images: images })} />;
        const draft = row.event ? drafts?.[row.event.id] : operationDrafts?.[row.key];
        const extra = row.event ? eventExtra(row, draft as OrderEventDraft | undefined) : (draft?.form_extra ?? {});
        if (row.operationKey === "consignment") {
          const selectedPlatforms = platformValues(extra.consignment_platforms);
          const currentPrice = extra.consignment_price == null || extra.consignment_price === "" ? undefined : Number(extra.consignment_price);
          const choices = platformOptionValues(selectedPlatforms).filter((option) => {
            const takenByListing = activeListings.some((listing) => listing.platform === option.value && listing.eventId !== row.event?.id);
            const takenByDraft = Object.entries(operationDrafts ?? {}).some(([key, candidate]) => key !== row.key && candidate?.operation_type === "CONSIGNMENT" && platformValues(candidate.form_extra?.consignment_platforms).includes(String(option.value)));
            return !takenByListing && !takenByDraft;
          });
          return <div className="order-operation-edit-fields"><Select aria-label={`编辑上架平台${row.ariaLabelSuffix ?? ""}`} allowClear value={selectedPlatforms[0]} options={choices} placeholder="选择上架平台" onChange={(next) => { const nextExtra = { ...extra }; if (next) nextExtra.consignment_platforms = [next]; else { delete nextExtra.consignment_platforms; delete nextExtra.consignment_price; } updateExtra(row, nextExtra); }} /><InputNumber aria-label={`编辑寄售价格${row.ariaLabelSuffix ?? ""}`} min={0} precision={2} value={Number.isFinite(currentPrice) ? currentPrice : null} placeholder="寄售价" onChange={(next) => { const nextExtra = { ...extra }; if (next == null) delete nextExtra.consignment_price; else nextExtra.consignment_price = next; updateExtra(row, nextExtra); }} /></div>;
        }
        const currentPlatforms = platformValues(extra.consignment_platforms);
        if (!row.event) {
          const choices = activeListings.filter((listing) => listing.eventId != null).map((listing) => ({ value: JSON.stringify([listing.eventId, listing.platform]), label: `${listing.platform}（上架于 ${listing.listedAt}，事件 ${listing.eventId}）` }));
          const current = extra.platform_unlist_scope === "SYSTEM" ? "__SYSTEM__" : extra.consignment_event_id != null && currentPlatforms[0] ? JSON.stringify([extra.consignment_event_id, currentPlatforms[0]]) : undefined;
          return <Select aria-label={`编辑下架平台${row.ariaLabelSuffix ?? ""}`} allowClear value={current} options={choices} placeholder="选择已上架记录" notFoundContent="暂无已上架记录" onChange={(next) => {
            const nextExtra = { ...extra };
            delete nextExtra.consignment_event_id;
            delete nextExtra.consignment_platforms;
            if (typeof next === "string") {
              const listing = activeListings.find((item) => JSON.stringify([item.eventId, item.platform]) === next);
              if (listing) { nextExtra.platform_unlist_scope = "PLATFORM"; nextExtra.consignment_event_id = listing.eventId; nextExtra.consignment_platforms = [listing.platform]; }
            } else delete nextExtra.platform_unlist_scope;
            updateExtra(row, nextExtra);
          }} />;
        }
        const currentScope = extra.platform_unlist_scope === "SYSTEM" ? ["__SYSTEM__"] : currentPlatforms;
        return <Select aria-label={`编辑下架平台${row.ariaLabelSuffix ?? ""}`} disabled={row.event?.form_extra?.consignment_event_id != null || row.event?.form_extra?.platform_unlist_scope === "SYSTEM"} allowClear value={currentScope[0]} options={platformOptionValues(currentScope.filter((value) => value !== "__SYSTEM__"), extra.platform_unlist_scope === "SYSTEM")} placeholder="选择下架平台" onChange={(next) => { const nextExtra = { ...extra }; if (next) { nextExtra.platform_unlist_scope = "PLATFORM"; nextExtra.consignment_platforms = [next]; } else { delete nextExtra.platform_unlist_scope; delete nextExtra.consignment_platforms; } updateExtra(row, nextExtra); }} />;
      },
    },
    {
      title: "时间", dataIndex: "occurredAt", key: "occurredAt", width: 142,
      render: (_value: string, row: OrderOperationRow) => { const draft = row.event ? drafts?.[row.event.id] : operationDrafts?.[row.key]; const current = draft?.occurred_at ?? row.event?.occurred_at ?? ""; return <DateField showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" minuteStep={1} aria-label={`编辑${row.action}时间${row.ariaLabelSuffix ?? ""}`} value={current ? dayjs(current) : null} onChange={(next) => updateOperation(row, { occurred_at: next?.format("YYYY-MM-DDTHH:mm:ss") ?? "" })} />; },
    },
    {
      title: "操作人", dataIndex: "operator", key: "operator", width: 120,
      render: (_value: string, row: OrderOperationRow) => {
        const draft = row.event ? drafts?.[row.event.id] : operationDrafts?.[row.key];
        const storedIds = draft?.operator_user_ids ?? row.event?.operator_user_ids ?? [];
        const operatorIds = storedIds.length ? storedIds : defaultOperatorIds;
        return <Select mode="multiple" showSearch optionFilterProp="label" aria-label={`编辑${row.action}操作人${row.ariaLabelSuffix ?? ""}`} value={operatorIds} options={employees.map((employee) => ({ value: employee.id, label: employee.display_name, disabled: !employee.is_active }))} onChange={(ids) => updateOperation(row, { operator_user_ids: ids.length ? ids : operatorIds })} />;
      },
    },
    {
      title: "操作", key: "operation", width: 64,
      render: (_value: unknown, row: OrderOperationRow) => row.key.startsWith("new:")
        ? <PermissionButton permission="order.update" type="link" danger size="small" aria-label={`删除新增${row.action}`} onClick={() => onRemoveOperationRow?.(row.key)}>删除</PermissionButton>
        : null,
    },
  ];
}
