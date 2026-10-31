import { Spin, Typography } from "antd";
import type { Account, AccountExecutionDetail, AccountExecutionEvent, EmployeeOption } from "../shared/api/catalog";
import { executionActionLabel } from "../shared/lib/format";
import {
  STATUS_LABEL,
  BUSINESS_MODE_LABEL,
  INVENTORY_TYPE_LABEL,
  VALUE_ADDED_SERVICE_LABEL,
  accountFinancialFlows,
  financeTypeLabel,
  rebateTypeLabel,
} from "./inventory-logic";
import {
  OrderDetailView,
  type InventoryPartyLink,
  type InventoryExecutionRow,
  type InventoryFinanceRow,
} from "./OrderDetailView";
import {
  classifyEventCategory,
  type InventoryEventDraft,
  type OrderDetailMeta,
} from "./OrderDetail.shared";

function dateTimeMinute(value: string | null | undefined): string {
  if (!value) return "-";
  const normalized = value.replace("T", " ");
  return normalized.length >= 16 ? normalized.slice(0, 16) : `${normalized.slice(0, 10)} 00:00`;
}

function eventDate(detail: AccountExecutionDetail | undefined, eventType: string): string {
  const event = detail?.orders.flatMap((order) => order.events).find((item) => item.event_type === eventType);
  return dateTimeMinute(event?.occurred_at ?? event?.occurred_on);
}

function eventPlatform(detail: AccountExecutionDetail | undefined, eventType: string): string {
  const order = detail?.orders.find((item) => item.events.some((event) => event.event_type === eventType));
  return order?.account_platform ?? "-";
}

function consignmentSummary(detail: AccountExecutionDetail | undefined, accountStatus?: string): string {
  if (accountStatus === "VOID") return "-";
  const records = detail?.orders
    .filter((order) => order.order_type === "DG" && order.status !== "CANCELLED")
    .map((order) => {
      const configuredPlatform = order.extra_values?.consignment_platform;
      const platform = configuredPlatform
        ? String(configuredPlatform)
        : (order.counterparties ?? [])
          .filter((counterparty) => counterparty.role === "PLATFORM")
          .map((counterparty) => counterparty.display_name)
          .join("、") || "-";
      const listedAt = dateTimeMinute(String(order.extra_values?.listed_at ?? order.created_at ?? order.trade_date ?? ""));
      return `${platform} / ${listedAt}`;
    }) ?? [];
  return records.length ? records.join("\n") : "-";
}

function orderPlatformValues(order: AccountExecutionDetail["orders"][number]): string[] {
  return [
    order.account_platform,
    ...(order.counterparties ?? [])
      .filter((counterparty) => counterparty.role === "PLATFORM")
      .map((counterparty) => counterparty.display_name),
  ].filter((platform): platform is string => Boolean(platform));
}

/** 下架分两类：平台下架（PLATFORM）只取消指定平台的上架记录；系统下架（SYSTEM）按 ERP 出库、账号退出库存。
 *  操作明细「平台」列据此取值：平台下架显示具体平台，系统下架显示「本系统」。 */
function consignmentPlatformOf(order: AccountExecutionDetail["orders"][number]): string {
  const configured = order.extra_values?.consignment_platform;
  if (configured) return String(configured);
  return orderPlatformValues(order).join("、") || "-";
}

function eventPlatformLabel(
  detail: AccountExecutionDetail | undefined,
  order: AccountExecutionDetail["orders"][number],
  eventType: string,
): string {
  if (eventType !== "CANCEL") return order.account_platform || "-";
  const scope = order.extra_values?.platform_unlist_scope;
  if (scope === "SYSTEM") return "本系统";
  if (scope === "PLATFORM") return consignmentPlatformOf(order);
  // 系统下架会把该账号仍在架的 DG 单统一标记为 SYSTEM；其 CANCEL 事件可能落在被冲销的源单上，
  // 此时以账号内是否存在 SYSTEM 下架记录判定，避免把源单的买入平台误当作下架平台。
  const systemUnlisted = (detail?.orders ?? []).some(
    (item) => item.order_type === "DG" && item.extra_values?.platform_unlist_scope === "SYSTEM",
  );
  return systemUnlisted ? "本系统" : consignmentPlatformOf(order);
}

function transactionPlatforms(detail: AccountExecutionDetail | undefined, kinds: Set<string>, includeSellEvent = false): string {
  const platforms = detail?.orders
    .filter((order) => kinds.has(order.order_type) || (includeSellEvent && order.events.some((event) => event.event_type === "SELL")))
    .flatMap(orderPlatformValues);
  return platforms?.length ? [...new Set(platforms)].join("、") : "-";
}

const PARTY_ROLE_LABEL: Record<string, string> = {
  SELLER: "卖家",
  BUYER: "买家",
  CONSIGNOR: "寄售方",
  PEER: "同行",
  SUPPLIER: "供货方",
  PLATFORM: "平台",
  INSTALLMENT_CUSTOMER: "分期客户",
};

function orderParties(detail: AccountExecutionDetail | undefined): InventoryPartyLink[] {
  const parties = detail?.orders.flatMap((order) => [
    ...(order.customers ?? []).map((party) => ({ ...party, entityType: "customer" as const })),
    ...(order.counterparties ?? []).map((party) => ({ ...party, entityType: "counterparty" as const })),
  ]) ?? [];
  const seen = new Set<string>();
  return parties.filter((party) => {
    const key = `${party.entityType}:${party.id}:${party.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderOrderParties(
  parties: InventoryPartyLink[],
  onPartyClick?: (party: InventoryPartyLink) => void,
): React.ReactNode {
  if (!parties.length) return "-";
  return <span>{parties.map((party, index) => (
    <span key={`${party.entityType}:${party.id}:${party.role}`}>
      <Typography.Link
        href="#"
        onClick={(event) => {
          event.preventDefault();
          onPartyClick?.(party);
        }}
      >
        {party.entityType === "customer" ? "客户" : "合作方"}_{PARTY_ROLE_LABEL[party.role] ?? party.role}：{party.display_name}
      </Typography.Link>
      {index < parties.length - 1 ? "、" : null}
    </span>
  ))}</span>;
}

function orderNotes(detail: AccountExecutionDetail | undefined): string {
  // 详情只展示主订单备注；关联 DG 寄售单的系统备注已单独展示在寄售信息中。
  const order = detail?.orders.find((item) => item.order_type !== "DG" && item.note)
    ?? detail?.orders.find((item) => item.note && !item.note.startsWith("寄售平台："));
  return order?.note?.trim() || "-";
}

const INTERNAL_CONSIGNMENT_EXTRA_KEYS = new Set([
  "consignment_platform",
  "listed_at",
  "platform_unlisted_at",
  "platform_unlist_scope",
]);

function orderExtraValues(detail: AccountExecutionDetail | undefined): Array<{ key: string; label: string; value: string; section: string }> {
  const values = detail?.orders.flatMap((order) => {
    const fields = order.extra_fields?.length
      ? order.extra_fields.map((field) => ({ key: `${order.order_no}-${field.key}`, label: field.label, value: field.value, section: field.section }))
      : Object.entries(order.extra_values ?? {}).map(([key, value]) => ({ key: `${order.order_no}-${key}`, label: key, value, section: "EXTRA" }));
    return fields
      .filter((field) => ![...INTERNAL_CONSIGNMENT_EXTRA_KEYS].some((key) => field.key === key || field.key.endsWith(`-${key}`)))
      .filter((field) => field.value !== null && field.value !== undefined && String(field.value).trim() !== "")
      .map((field) => ({ ...field, value: String(field.value) }));
  }) ?? [];
  return values;
}

/** 账号周期：已售 > 寄售中 > 已下架 > 待售；分期进度由分期管理展示。 */
function resolveOperationStatus(
  accountStatus: string,
  hasActiveConsignment: boolean,
  hasUnlistedConsignment: boolean,
): string {
  if (accountStatus === "SOLD") return "已售";
  if (hasActiveConsignment) return "寄售中";
  if (accountStatus === "VOID" || hasUnlistedConsignment) return "已下架";
  return "待售";
}

export function OrderDetail({
  row,
  detail,
  contextOrderNo,
  loading,
  editing,
  onEdit,
  eventDrafts,
  onEventEdit,
  onPartyClick,
  employees = [],
  extraForm,
  onSave,
  onCancel,
  saving,
}: {
  row: Account;
  detail?: AccountExecutionDetail;
  /** 业务台账从订单行展开时，优先使用当前订单作为详情上下文；库存中心不传则沿用账号来源单。 */
  contextOrderNo?: string | null;
  loading: boolean;
  editing?: Account | null;
  onEdit?: (account: Account) => void;
  eventDrafts?: Record<number, InventoryEventDraft>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) => void;
  employees?: EmployeeOption[];
  onPartyClick?: (party: InventoryPartyLink) => void;
  extraForm?: unknown;
  onSave?: () => void;
  onCancel?: () => void;
  saving?: boolean;
}) {
  if (loading && !detail) return <Spin size="small" />;

  const sourceOrderNo = contextOrderNo ?? row.source_order_no;
  const contextOrder = detail?.orders.find((order) => order.order_no === sourceOrderNo);

  const financialFlows = accountFinancialFlows(detail);
  const rebateItems = detail?.orders.flatMap((order) => (
    (order.rebates ?? []).map((rebate) => ({ rebate }))
  )) ?? [];
  const expenseFlows = financialFlows.filter(({ cashflow }) => cashflow.direction === "OUT");
  const incomeFlows = financialFlows.filter(({ cashflow }) => cashflow.direction === "IN");
  const totalExpense = expenseFlows.reduce((sum, { cashflow }) => sum + Number(cashflow.amount), 0).toFixed(2);
  const totalIncome = incomeFlows.reduce((sum, { cashflow }) => sum + Number(cashflow.amount), 0).toFixed(2);

  const financeRows: InventoryFinanceRow[] = [
    ...financialFlows.map(({ event, cashflow }) => ({
      key: `flow-${cashflow.flow_no}`,
      type: financeTypeLabel(event?.event_type ?? "", cashflow.direction),
      direction: cashflow.direction === "OUT" ? "支出" as const : "收入" as const,
      amount: cashflow.amount,
      rate: "-",
      occurredAt: dateTimeMinute(cashflow.occurred_at ?? cashflow.occurred_on),
      poolName: cashflow.pool_name || "未分配资金池",
      operator: cashflow.operator || event?.operator_names?.join("、") || event?.operator || "-",
      event,
    })),
    ...rebateItems.map(({ rebate }) => ({
      key: `rebate-${rebate.id}`,
      type: rebateTypeLabel(rebate.rebate_type, rebate.channel),
      // 返点登记即完成收入记录，不再区分待结算/已结算。
      direction: "收入" as const,
      amount: rebate.base_amount,
      rate: `${rebate.rate}%`,
      occurredAt: dateTimeMinute(rebate.collected_at ?? rebate.collected_on),
      poolName: "-",
      operator: "-",
    })),
  ];

  const executionRows: InventoryExecutionRow[] = detail?.orders.flatMap((order) => (
    order.events.map((event) => ({
      key: `${order.order_id}-${event.id}`,
      category: classifyEventCategory(event.event_type),
      action: executionActionLabel(event.event_type, order.order_type),
      occurredAt: dateTimeMinute(event.occurred_at ?? event.occurred_on),
      amount: event.amount,
      operator: event.operator_names?.length ? event.operator_names.join("、") : event.operator || "-",
      note: event.note || "-",
      platform: eventPlatformLabel(detail, order, event.event_type),
      event,
    }))
  )) ?? [];

  const consignmentOrders = (detail?.orders ?? []).filter((order) => order.order_type === "DG" && order.status !== "CANCELLED");
  const hasActiveConsignment = consignmentOrders.some((order) => {
    const unlisted = order.extra_values?.platform_unlisted_at || order.extra_values?.platform_unlist_scope;
    return !unlisted;
  });
  const hasUnlistedConsignment = consignmentOrders.some((order) => {
    const unlisted = order.extra_values?.platform_unlisted_at || order.extra_values?.platform_unlist_scope;
    return Boolean(unlisted);
  });
  const operationStatusLabel = resolveOperationStatus(row.status, hasActiveConsignment, hasUnlistedConsignment);

  const meta: OrderDetailMeta = {
    inventoryNo: row.stock_no ?? "-",
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] ?? row.status,
    gameType: row.game_type ?? null,
    gameAccount: row.game_account ?? null,
    platform: row.platform ?? null,
    cost: row.cost_amount ?? null,
    businessMode: row.business_mode ? (BUSINESS_MODE_LABEL[row.business_mode] ?? row.business_mode) : null,
    inventoryType: row.inventory_type ? (INVENTORY_TYPE_LABEL[row.inventory_type] ?? row.inventory_type) : null,
    valueAddedService: row.value_added_service ? (VALUE_ADDED_SERVICE_LABEL[row.value_added_service] ?? row.value_added_service) : null,
    orderNo: contextOrder?.order_no ?? detail?.orders[0]?.order_no ?? row.source_order_no ?? "-",
    sourceOrderNo: sourceOrderNo ?? null,
    createdBy: row.created_by || "-",
    registeredAt: dateTimeMinute(contextOrder?.created_at ?? contextOrder?.trade_date ?? detail?.orders[0]?.created_at ?? detail?.orders[0]?.trade_date ?? row.created_at),
    soldAt: eventDate(detail, "SELL"),
    removedAt: eventDate(detail, "CANCEL"),
    removedPlatform: eventPlatform(detail, "CANCEL"),
    recoveryPlatform: transactionPlatforms(detail, new Set(["HS", "TH"])),
    salePlatform: transactionPlatforms(detail, new Set(["DG", "DFQ"]), true),
    consignmentSummary: consignmentSummary(detail, row.status),
    password: row.game_password || "-",
    channelRegion: [row.platform, row.channel_region].filter(Boolean).join(" / ") || "-",
    boundPhone: row.bound_phone || "-",
    secondary: row.has_secondary == null ? "-" : row.has_secondary ? "有" : "无",
    accountDescription: row.account_description || "-",
    accountImages: row.account_images ?? [],
    note: row.note || "-",
    orderNotes: orderNotes(detail),
    orderParties: renderOrderParties(orderParties(detail), onPartyClick),
    orderExtras: orderExtraValues(detail),
    operationStatusLabel,
    hasActiveConsignment,
  };

  return (
    <OrderDetailView
      meta={meta}
      detail={detail}
      account={row}
      editing={editing}
      onEdit={onEdit}
      eventDrafts={eventDrafts}
      onEventEdit={onEventEdit}
      employees={employees}
      executionRows={executionRows}
      financeRows={financeRows}
      expenseCount={expenseFlows.length}
      incomeCount={incomeFlows.length}
      totalExpense={totalExpense}
      totalIncome={totalIncome}
      flowCount={financialFlows.length + rebateItems.length}
      extraForm={extraForm}
      onSave={onSave}
      onCancel={onCancel}
      saving={saving}
    />
  );
}
