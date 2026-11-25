import { Input, InputNumber, Space, Typography } from "antd";
import dayjs from "dayjs";
import type { ColumnsType } from "antd/es/table";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { DataTable, DateField, PermissionButton, Select } from "../../../shared/ui";
import type { AccountExecutionEvent } from "../../../shared/api/types/account-execution";
import type { EmployeeOption } from "../../../shared/api/types/org";
import type { Account } from "../../../shared/api/types/accounts";
import type { OrderEventDraft, OrderOperationDraft, OrderOperationKey, OrderOperationRow } from "./OrderDetail.shared";
import { OrderDetailImageGallery } from "./OrderDetailImageGallery";
import { useOptionSet } from "../../../shared/lib/optionSets";
import { money } from "../../../shared/lib/format";
import { OrderSectionHeading, OPERATION_KEY_BY_TYPE, OPERATION_TYPE_BY_KEY, type OrderDetailMeta } from "./OrderDetail.shared";
import { defaultOperatorUserIds } from "./editing/editor-utils";
import { currentDevUser } from "../../../shared/api/client";
import type { ConsignmentListing } from "../operations/consignment-logic";
import "../../../shared/ui/AdaptiveFormGrid/MoneyInput.css";

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

export function buildUnlistingOptions<T extends { eventId?: number; platform: string; platformLabel?: string; listedAt: string }>(listings: T[]) {
  const choices: Array<{ value: string; label: string }> = [];
  const byKey = new Map<string, T>();
  for (const listing of listings) {
    const key = JSON.stringify([listing.eventId, listing.platform]);
    if (!byKey.has(key)) byKey.set(key, listing);
    if (listing.eventId != null) choices.push({ value: key, label: `${listing.platformLabel ?? listing.platform}（上架于 ${listing.listedAt}，事件 ${listing.eventId}）` });
  }
  return { choices, byKey };
}

export function createOperationPlatformOptions(platformOptions: Array<{ value: string; label: string }>) {
  const known = new Set(platformOptions.map((option) => option.value));
  return (current: string[], includeSystem = false) => {
    const addSystem = includeSystem && !known.has("__SYSTEM__");
    const added = new Set(addSystem ? ["__SYSTEM__"] : []);
    const prefix: Array<{ value: string; label: string }> = [];
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const value = current[index];
      if (!value || known.has(value) || added.has(value)) continue;
      added.add(value);
      prefix.push({ value, label: value });
    }
    return [...prefix.reverse(), ...platformOptions, ...(addSystem ? [{ value: "__SYSTEM__", label: "本系统" }] : [])];
  };
}

export function buildOperationPlatformUsage(
  listings: Array<{ platform: string; eventId?: number }>,
  drafts: Partial<Record<string, Pick<OrderOperationDraft, "operation_type" | "form_extra">>>,
) {
  const listingIds = new Map<string, Set<number | undefined>>();
  for (const listing of listings) {
    const ids = listingIds.get(listing.platform) ?? new Set<number | undefined>();
    ids.add(listing.eventId);
    listingIds.set(listing.platform, ids);
  }
  const draftKeys = new Map<string, Set<string>>();
  for (const [key, draft] of Object.entries(drafts)) {
    if (draft?.operation_type !== "CONSIGNMENT") continue;
    for (const platform of operationPlatforms(draft.form_extra ?? {})) {
      const keys = draftKeys.get(platform) ?? new Set<string>();
      keys.add(key);
      draftKeys.set(platform, keys);
    }
  }
  return (platform: string, eventId: number | undefined, currentKey: string) => {
    const ids = listingIds.get(platform);
    const keys = draftKeys.get(platform);
    return Boolean((ids && (ids.size > 1 || !ids.has(eventId) || Number.isNaN(eventId)))
      || (keys && (keys.size > 1 || !keys.has(currentKey))));
  };
}

/** 运营明细每一行按自己的事件数据展示，不能复用最新一条记录的内容。 */
export function resolveOperationEventContent(
  operationKey: OrderOperationKey,
  fallback: ReactNode,
  event: Pick<AccountExecutionEvent, "event_type" | "operation_type" | "form_extra" | "reason">,
): ReactNode {
  const extra = event.form_extra ?? {};
  const snapshots = extra.consignment_platform_labels;
  const labels = snapshots && typeof snapshots === "object" && !Array.isArray(snapshots) ? snapshots as Record<string, string> : {};
  const platforms = operationPlatforms(extra).map((value) => labels[value] ?? value);
  if (operationKey === "consignment" && event.operation_type === "CONSIGNMENT") {
    const platform = platforms.join("、");
    const price = extra.consignment_price;
    if (price !== undefined && price !== null && price !== "") {
      const numericPrice = Number(price);
      const priceText = Number.isFinite(numericPrice)
        ? money(typeof price === "string" ? price : numericPrice)
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
  meta, editing, account, orderType, eventDrafts, operationDrafts, onEventEdit, onOperationEdit, onAddOperationRow, onRemoveOperationRow, onProfileChange, employees = [], operationEvents, activeListings = [], operatorUsername = currentDevUser(),
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
  activeListings?: ConsignmentListing[];
  operatorUsername?: string;
}) {
  const platformOptions = useOptionSet("INTERMEDIARY_PLATFORM") ?? [];
  const defaultOperatorIds = defaultOperatorUserIds(employees, operatorUsername) ?? [];
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
      ...makeRows("images", "作图", <OrderDetailImageGallery images={account?.account_images ?? []} field="account_images" ownerKey={account?.id} altPrefix="作图" limit={9} />, meta.imagesAt, meta.imagesOperator), ...createdRows("images"),
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
  activeListings: ConsignmentListing[],
): ColumnsType<OrderOperationRow> {
  const isPlatformTaken = buildOperationPlatformUsage(activeListings, operationDrafts ?? {});
  const unlistingOptions = buildUnlistingOptions(activeListings);
  const platformOptionValues = createOperationPlatformOptions(platformOptions);
  const employeeOptions = employees.map((employee) => ({ value: employee.id, label: employee.display_name, disabled: !employee.is_active }));
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
          const currentPrice = typeof extra.consignment_price === "string" || typeof extra.consignment_price === "number" ? String(extra.consignment_price) : undefined;
          const choices = platformOptionValues(selectedPlatforms).filter((option) => {
            return !isPlatformTaken(option.value, row.event?.id, row.key);
          });
          return <div className="order-operation-edit-fields"><Select aria-label={`编辑上架平台${row.ariaLabelSuffix ?? ""}`} allowClear value={selectedPlatforms[0]} options={choices} placeholder="选择上架平台" onChange={(next) => { const nextExtra = { ...extra }; if (next) nextExtra.consignment_platforms = [next]; else { delete nextExtra.consignment_platforms; delete nextExtra.consignment_price; } updateExtra(row, nextExtra); }} /><InputNumber<string> stringMode className="money-input" aria-label={`编辑寄售价格${row.ariaLabelSuffix ?? ""}`} min="0" precision={2} suffix="元" value={currentPrice || null} placeholder="寄售价" onChange={(next) => { const nextExtra = { ...extra }; if (next == null) delete nextExtra.consignment_price; else nextExtra.consignment_price = next; updateExtra(row, nextExtra); }} /></div>;
        }
        const currentPlatforms = platformValues(extra.consignment_platforms);
        if (!row.event) {
          const current = extra.platform_unlist_scope === "SYSTEM" ? "__SYSTEM__" : extra.consignment_event_id != null && currentPlatforms[0] ? JSON.stringify([extra.consignment_event_id, currentPlatforms[0]]) : undefined;
          return <Select aria-label={`编辑下架平台${row.ariaLabelSuffix ?? ""}`} allowClear value={current} options={unlistingOptions.choices} placeholder="选择已上架记录" notFoundContent="暂无已上架记录" onChange={(next) => {
            const nextExtra = { ...extra };
            delete nextExtra.consignment_event_id;
            delete nextExtra.consignment_platforms;
            if (typeof next === "string") {
              const listing = unlistingOptions.byKey.get(next);
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
        return <Select mode="multiple" showSearch optionFilterProp="label" aria-label={`编辑${row.action}操作人${row.ariaLabelSuffix ?? ""}`} value={operatorIds} options={employeeOptions} onChange={(ids) => updateOperation(row, { operator_user_ids: ids.length ? ids : operatorIds })} />;
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
