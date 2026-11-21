import { Descriptions, Input } from "antd";
import { type ReactNode } from "react";
import { useMemo } from "react";
import type { AccountExecutionDetail, AccountExecutionEvent, AccountExecutionOrder } from "../../../shared/api/types/account-execution";
import type { Account } from "../../../shared/api/types/accounts";
import type { EmployeeOption } from "../../../shared/api/types/org";
import type { OrderDraft } from "./editing/editor-types";
import { defaultOperatorUserIds } from "./editing/editor-utils";
import { currentDevUser } from "../../../shared/api/client";
import { Select } from "../../../shared/ui";
import {
  buildFormExtraDisplay,
  fieldLabel,
  formatExtraDisplayValue,
  isFieldActive,
  useOrderFormConfig,
  FieldConfigStatus,
} from "../../../shared/forms/ConfigurableField";
import { useOptionSet } from "../../../shared/lib/optionSets";
import {
  OrderSectionHeading,
  type OrderEventDraft,
  type OrderDetailMeta,
} from "./OrderDetail.shared";

/** 交付主字段与建单表单对齐，买号和卖号分别保存。 */
const DELIVERY_FIELDS = [
  { key: "bound_phone", fallback: "换绑手机号" },
  { key: "bound_phone_owner", fallback: "手机号绑定人" },
  { key: "intermediary_platform", fallback: "交易平台" },
  { key: "intermediary_platform_other", fallback: "其他平台" },
  { key: "intermediary_type", fallback: "中介类型" },
  { key: "compensation_type", fallback: "包赔类型" },
  { key: "delivery_responsible_ids", fallback: "交付操作人" },
] as const;
const SALE_SCOPES: Record<string, string> = { HS: "SALEREC", TH: "SALETH", DG: "SALEDG" };

function textValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "-";
}

function selectOptions(options: Array<{ value: string; label: string }>, value: unknown) {
  const current = typeof value === "string" ? value : "";
  return current && !options.some((option) => option.value === current)
    ? [{ value: current, label: current }, ...options]
    : options;
}

/** 单个交付子块（买号交付 / 卖号交付）：按对应订单类型配置驱动渲染主交付字段 + DELIVER 自定义字段。
 * 两个交付方向都保留字段表格，便于详情查看、编辑和补录。 */
function DeliverySubSection({
  title,
  orderType,
  order,
  account,
  employees,
  editing = false,
  draft,
  onExtraChange,
  onProfileChange,
  operatorUsername = currentDevUser(),
  direction,
  hasSale,
  saleEvent,
  saleEventDraft,
  onSaleEventExtraChange,
}: {
  title: string;
  orderType?: string | null | undefined;
  order?: AccountExecutionOrder;
  account?: Account | null;
  employees?: EmployeeOption[];
  editing?: boolean;
  draft?: OrderDraft;
  onExtraChange?: (key: string, value: unknown) => void;
  onProfileChange?: (changes: Partial<Account>) => void;
  operatorUsername?: string;
  direction: "BUY" | "SELL";
  hasSale: boolean;
  saleEvent?: AccountExecutionEvent;
  saleEventDraft?: OrderEventDraft;
  onSaleEventExtraChange?: (key: string, value: unknown) => void;
}) {
  const { config, ready, error, retry } = useOrderFormConfig(orderType ?? undefined);
  const platformOptions = useOptionSet("INTERMEDIARY_PLATFORM");
  const intermediaryTypeOptions = useOptionSet("INTERMEDIARY_TYPE");
  const compensationTypeOptions = useOptionSet("COMPENSATION_TYPE");
  const optionsByField: Record<string, Array<{ value: string; label: string }>> = {
    intermediary_platform: platformOptions ?? config.intermediary_platform?.options ?? [],
    intermediary_type: intermediaryTypeOptions ?? config.intermediary_type?.options ?? [],
    compensation_type: compensationTypeOptions ?? config.compensation_type?.options ?? [],
  };
  const extraValues = order?.extra_values;
  const allValues = { ...(extraValues ?? {}), ...(draft?.form_extra ?? {}) };
  const editableValues = direction === "SELL"
    ? Object.fromEntries(Object.entries(allValues).filter(([key]) => key.startsWith("sell_")).map(([key, value]) => [key.slice(5), value]))
    : allValues;
  const customValues = direction === "SELL"
    ? { ...(saleEvent?.form_extra ?? {}), ...(saleEventDraft?.form_extra ?? {}) }
    : editableValues;
  const defaultOperatorIds = defaultOperatorUserIds(employees ?? [], operatorUsername) ?? [];
  const employeeNames = useMemo(
    () => new Map((employees ?? []).map((employee) => [employee.id, employee.display_name])),
    [employees],
  );
  const mainFields = useMemo(() => DELIVERY_FIELDS.map(({ key, fallback }) => {
    let value: ReactNode = "-";
    const values = editableValues;
    if (key === "bound_phone") {
      const hasStoredValue = Object.prototype.hasOwnProperty.call(values, key);
      value = hasStoredValue ? textValue(values[key])
        : direction === "BUY" && !hasSale ? account?.bound_phone || "-" : "-";
    } else if (key === "bound_phone_owner") {
      const hasOrderDraftValue = Object.prototype.hasOwnProperty.call(values, key);
      value = hasOrderDraftValue
        ? (values[key] == null ? "" : String(values[key]))
        : direction === "BUY" && !hasSale ? account?.bound_phone_owner || "-" : "-";
    } else {
      const raw = values[key];
      if (raw == null || raw === "") {
        value = "-";
      } else if (key === "delivery_responsible_ids" && Array.isArray(raw) && employees?.length) {
        value = raw.map((id) => employeeNames.get(id) ?? "未知操作人").join("、") || "-";
      } else if (key === "delivery_responsible_ids" && Array.isArray(raw)) {
        value = raw.length ? "操作人信息加载中" : "-";
      } else {
        value = formatExtraDisplayValue(raw);
      }
    }
    return { key, fallback, value };
  }), [account, direction, editableValues, employees, employeeNames, hasSale]);
  const deliveryItems = useMemo(() => {
    const existing = buildFormExtraDisplay(customValues, Object.values(config)).filter(
      (item) => item.key !== "intermediary_platform_other" && config[item.key]?.is_custom && config[item.key]?.section === "DELIVER",
    );
    const existingKeys = new Set(existing.map((item) => item.key));
    const configured = Object.values(config)
      .filter((field) => field.field_key !== "intermediary_platform_other" && field.is_custom && field.is_active && field.section === "DELIVER" && !existingKeys.has(field.field_key))
      .map((field) => ({ key: field.field_key, label: field.label, value: "", status: "active" as const }));
    return [...existing, ...configured];
  }, [config, customValues]);
  return (
    <div className="order-detail__meta-group">
      <div className="order-detail__meta-group-title">{title}</div>
      <FieldConfigStatus scope={`DELIVERY_${order?.order_id ?? "none"}_${title}`} ready={ready} error={error} retry={retry} />
      <Descriptions className="order-detail__meta-table" size="small" bordered column={3}>
        {mainFields
          .filter((field) => isFieldActive(config, field.key))
          .filter((field) => field.key !== "intermediary_platform_other" || editableValues.intermediary_platform === "其他")
          .map((field) => (
            <Descriptions.Item key={field.key} label={fieldLabel(config, field.key, field.fallback)}>
              {editing && field.key === "delivery_responsible_ids" ? (
                (() => {
                  const storedIds = Array.isArray(editableValues[field.key]) ? editableValues[field.key] as number[] : [];
                  const operatorIds = storedIds.length ? storedIds : defaultOperatorIds;
                  return (
                    <Select
                      mode="multiple"
                      aria-label="编辑交付操作人"
                      className="order-detail__delivery-responsible"
                      value={operatorIds}
                      options={(employees ?? []).map((employee) => ({ value: employee.id, label: employee.display_name, disabled: !employee.is_active }))}
                      showSearch
                      optionFilterProp="label"
                      filterOption={(input, option) => String(option?.label ?? "").toLocaleLowerCase().includes(input.trim().toLocaleLowerCase())}
                      placeholder="默认当前员工，可多选"
                      onChange={(next) => onExtraChange?.(field.key, next.length ? next : operatorIds)}
                    />
                  );
                })()
              ) : editing && ["intermediary_platform", "intermediary_type", "compensation_type"].includes(field.key) ? (
                <Select
                  aria-label={`编辑${field.fallback}`}
                  allowClear
                  value={editableValues[field.key] == null || editableValues[field.key] === "" ? undefined : String(editableValues[field.key])}
                  showSearch
                  optionFilterProp="label"
                  defaultActiveFirstOption
                  placeholder="可选填"
                  options={selectOptions(optionsByField[field.key] ?? [], editableValues[field.key])}
                  onChange={(value: string | undefined) => {
                    onExtraChange?.(field.key, value ?? null);
                    if (field.key === "intermediary_platform" && value !== "其他" && editableValues.intermediary_platform_other) {
                      onExtraChange?.("intermediary_platform_other", null);
                    }
                  }}
                />
              ) : editing ? (
                <Input
                  aria-label={`编辑${field.fallback}`}
                  value={field.value === "-" ? "" : String(field.value)}
                  onChange={(event) => {
                    onExtraChange?.(field.key, event.target.value);
                    if (field.key === "bound_phone" && (direction === "SELL" || !hasSale)) {
                      onProfileChange?.({ bound_phone: event.target.value });
                    }
                  }}
                />
              ) : field.value}
            </Descriptions.Item>
          ))}
      </Descriptions>
      {deliveryItems.length ? (
        <Descriptions className="order-detail__meta-table" size="small" bordered column={3}>
          {deliveryItems.map((item) => (
            <Descriptions.Item key={item.key} label={`${item.label}${item.status === "deleted" ? "（已删除）" : item.status === "inactive" ? "（已停用）" : ""}`}>
              {editing ? (
                <Input
                  aria-label={`编辑${item.label}`}
                  value={formatExtraDisplayValue(customValues[item.key] ?? item.value)}
                  onChange={(event) => direction === "SELL"
                    ? onSaleEventExtraChange?.(item.key, event.target.value)
                    : onExtraChange?.(item.key, event.target.value)}
                />
              ) : formatExtraDisplayValue(item.value) || "-"}
            </Descriptions.Item>
          ))}
        </Descriptions>
      ) : null}
    </div>
  );
}

/** 板块2：交付信息（买号交付、卖号交付）。两侧统一呈现字段表格；编辑态沿用 DELIVER 自定义字段表单。 */
export function OrderDetailDeliverySection({
  meta,
  editing,
  detail,
  account,
  employees,
  orderDrafts,
  onOrderExtraChange,
  onOrderEdit,
  onProfileChange,
  operatorUsername = currentDevUser(),
  eventDrafts,
  onEventEdit,
}: {
  meta: OrderDetailMeta;
  editing?: boolean;
  detail?: AccountExecutionDetail | null;
  account?: Account | null;
  employees?: EmployeeOption[];
  orderDrafts?: Record<number, OrderDraft>;
  onOrderExtraChange?: (orderId: number, key: string, value: unknown) => void;
  onOrderEdit?: (orderId: number, changes: Partial<Omit<OrderDraft, "order_id">>) => void;
  onProfileChange?: (changes: Partial<Account>) => void;
  operatorUsername?: string;
  eventDrafts?: Record<number, OrderEventDraft>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { form_extra?: Record<string, unknown> }) => void;
}) {
  const creationOrder = useMemo(
    () => detail?.orders.find((order) => order.order_no === meta.sourceOrderNo),
    [detail, meta.sourceOrderNo],
  );
  const sellOrder = useMemo(
    () => detail?.orders.find(
      (order) => order.events.some((event) => event.event_type === "SELL"),
    ),
    [detail],
  );
  const sellEvent = useMemo(() => sellOrder?.events
    .filter((event) => event.event_type === "SELL")
    .reduce<AccountExecutionEvent | undefined>((latest, event) => !latest || event.id > latest.id ? event : latest, undefined),
  [sellOrder]);
  const saleScope = sellOrder ? SALE_SCOPES[sellOrder.order_type] ?? sellOrder.order_type : undefined;

  if (editing) {
    return (
      <div className="order-detail__section order-detail__section--delivery">
        <OrderSectionHeading title="交付信息" />
        <div className="order-detail__meta">
          <DeliverySubSection title="买号交付" direction="BUY" hasSale={Boolean(sellOrder)} orderType={creationOrder?.order_type} order={creationOrder} account={account} employees={employees} editing draft={creationOrder ? orderDrafts?.[creationOrder.order_id] : undefined} onProfileChange={onProfileChange} onExtraChange={(key, value) => creationOrder && onOrderExtraChange?.(creationOrder.order_id, key, value)} operatorUsername={operatorUsername} />
          {sellOrder ? <DeliverySubSection title="卖号交付" direction="SELL" hasSale orderType={saleScope} order={sellOrder} account={account} employees={employees} editing draft={orderDrafts?.[sellOrder.order_id]} saleEvent={sellEvent} saleEventDraft={sellEvent ? eventDrafts?.[sellEvent.id] : undefined} onSaleEventExtraChange={(key, value) => {
            if (!sellEvent) return;
            const extra = eventDrafts?.[sellEvent.id]?.form_extra ?? sellEvent.form_extra ?? {};
            onEventEdit?.(sellEvent, { form_extra: { ...extra, [key]: value } });
          }} onProfileChange={onProfileChange} onExtraChange={(key, value) => onOrderExtraChange?.(sellOrder.order_id, `sell_${key}`, value)} operatorUsername={operatorUsername} /> : null}
          {creationOrder ? (
            <Descriptions className="order-detail__meta-table" size="small" bordered column={1}>
              <Descriptions.Item label="订单备注">
                <Input
                  aria-label="编辑订单备注"
                  value={orderDrafts?.[creationOrder.order_id]?.note ?? creationOrder.note ?? ""}
                  onChange={(event) => onOrderEdit?.(creationOrder.order_id, { note: event.target.value })}
                />
              </Descriptions.Item>
            </Descriptions>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="order-detail__section order-detail__section--delivery">
      <OrderSectionHeading title="交付信息" />
      <div className="order-detail__meta">
        <DeliverySubSection title="买号交付" direction="BUY" hasSale={Boolean(sellOrder)} orderType={creationOrder?.order_type} order={creationOrder} account={account} employees={employees} />
        <DeliverySubSection
          title="卖号交付"
          direction="SELL"
          hasSale={Boolean(sellOrder)}
          orderType={saleScope}
          order={sellOrder}
          saleEvent={sellEvent}
          account={account}
          employees={employees}
        />
        {creationOrder ? (
          <Descriptions className="order-detail__meta-table" size="small" bordered column={1}>
            <Descriptions.Item label="订单备注">{creationOrder.note || "-"}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </div>
    </div>
  );
}
