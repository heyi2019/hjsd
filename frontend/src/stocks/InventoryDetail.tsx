import { Spin } from "antd";
import type { Account, AccountAuditEntry, AccountExecutionDetail, AccountExecutionEvent, EmployeeOption } from "../shared/api/catalog";
import { executionActionLabel } from "../shared/lib/format";
import { accountFinancialFlows, financeTypeLabel, rebateTypeLabel, PROFILE_ACCOUNT_TYPES } from "./inventory-logic";
import {
  InventoryDetailView,
  type InventoryExecutionRow,
  type InventoryFinanceRow,
} from "./InventoryDetailView";

function dateTimeMinute(value: string | null | undefined): string {
  if (!value) return "-";
  const normalized = value.replace("T", " ");
  return normalized.length >= 16 ? normalized.slice(0, 16) : `${normalized.slice(0, 10)} 00:00`;
}

function eventDate(detail: AccountExecutionDetail | undefined, eventType: string): string {
  const event = detail?.orders.flatMap((order) => order.events).find((item) => item.event_type === eventType);
  return dateTimeMinute(event?.occurred_at ?? event?.occurred_on);
}

function platformListingDate(detail: AccountExecutionDetail | undefined): string {
  const order = detail?.orders.find((item) => item.order_type === "DG");
  return dateTimeMinute(order?.created_at ?? order?.trade_date);
}

function consignmentPlatforms(detail: AccountExecutionDetail | undefined): string {
  const names = detail?.orders
    .filter((order) => order.order_type === "DG")
    .flatMap((order) => (order.counterparties ?? [])
      .filter((counterparty) => counterparty.role === "PLATFORM")
      .map((counterparty) => counterparty.display_name));
  return names?.length ? names.join("、") : "-";
}

function orderPlatformValues(order: AccountExecutionDetail["orders"][number]): string[] {
  return [
    order.account_platform,
    ...(order.counterparties ?? [])
      .filter((counterparty) => counterparty.role === "PLATFORM")
      .map((counterparty) => counterparty.display_name),
  ].filter((platform): platform is string => Boolean(platform));
}

function transactionPlatforms(detail: AccountExecutionDetail | undefined, kinds: Set<string>, includeSellEvent = false): string {
  const platforms = detail?.orders
    .filter((order) => kinds.has(order.order_type) || (includeSellEvent && order.events.some((event) => event.event_type === "SELL")))
    .flatMap(orderPlatformValues);
  return platforms?.length ? [...new Set(platforms)].join("、") : "-";
}

function orderParties(detail: AccountExecutionDetail | undefined): string {
  const parties = detail?.orders.flatMap((order) => (order.counterparties ?? []).map((party) => party.display_name));
  return parties?.length ? [...new Set(parties)].join("、") : "-";
}

function orderNotes(detail: AccountExecutionDetail | undefined): string {
  const notes = detail?.orders
    .filter((order) => order.note)
    .map((order) => `${order.order_no}：${order.note}`);
  return notes?.length ? notes.join("；") : "-";
}

function orderExtraValues(detail: AccountExecutionDetail | undefined): Array<{ key: string; label: string; value: string; section: string }> {
  const values = detail?.orders.flatMap((order) => {
    const fields = order.extra_fields?.length
      ? order.extra_fields.map((field) => ({ key: `${order.order_no}-${field.key}`, label: field.label, value: field.value, section: field.section }))
      : Object.entries(order.extra_values ?? {}).map(([key, value]) => ({ key: `${order.order_no}-${key}`, label: key, value, section: "EXTRA" }));
    return fields
      .filter((field) => field.value !== null && field.value !== undefined && String(field.value).trim() !== "")
      .map((field) => ({ ...field, value: String(field.value) }));
  }) ?? [];
  return values;
}

function estimatedRebateAmount(baseAmount: string, rate: string): string {
  const amount = Number(baseAmount) * Number(rate) / 100;
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

export function InventoryDetail({
  row,
  detail,
  loading,
  editing,
  onEdit,
  eventDrafts,
  onEventEdit,
  employees = [],
}: {
  row: Account;
  detail?: AccountExecutionDetail;
  loading: boolean;
  editing?: Account | null;
  onEdit?: (account: Account) => void;
  eventDrafts?: Record<number, { amount: string; note: string | null; operator_user_ids?: number[] }>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) => void;
  employees?: EmployeeOption[];
}) {
  if (loading && !detail) return <Spin size="small" />;

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
      event,
    })),
    ...rebateItems.map(({ rebate }) => ({
      key: `rebate-${rebate.id}`,
      type: rebateTypeLabel(rebate.rebate_type, rebate.channel),
      direction: rebate.status === "SETTLED" ? "收入" as const : "待结算" as const,
      amount: rebate.base_amount,
      rate: `${rebate.rate}%`,
      occurredAt: dateTimeMinute(rebate.collected_at ?? rebate.collected_on),
      poolName: "-",
      rebateStatus: rebate.status,
      expectedRebate: estimatedRebateAmount(rebate.base_amount, rebate.rate),
    })),
  ];

  const executionRows: InventoryExecutionRow[] = detail?.orders.flatMap((order) => (
    order.events.map((event) => ({
      key: `${order.order_id}-${event.id}`,
      action: executionActionLabel(event.event_type, order.order_type),
      occurredAt: dateTimeMinute(event.occurred_at ?? event.occurred_on),
      amount: event.amount,
      operator: event.operator_names?.length ? event.operator_names.join("、") : event.operator || "-",
      note: event.note || "-",
      event,
    }))
  )) ?? [];
  const auditRows: AccountAuditEntry[] = detail?.audit ?? [];

  return (
    <InventoryDetailView
      meta={{
        orderNo: detail?.orders[0]?.order_no ?? row.source_order_no ?? "-",
        recoveryPlatform: transactionPlatforms(detail, new Set(["HS", "TH"])),
        salePlatform: transactionPlatforms(detail, new Set(["DG", "DFQ"]), true),
        orderParties: orderParties(detail),
        orderNotes: orderNotes(detail),
        orderExtras: orderExtraValues(detail),
        createdBy: row.created_by || "-",
        registeredAt: dateTimeMinute(detail?.orders[0]?.created_at ?? detail?.orders[0]?.trade_date ?? row.created_at),
        soldAt: eventDate(detail, "SELL"),
        removedAt: eventDate(detail, "CANCEL"),
        consignmentAt: platformListingDate(detail),
        consignmentPlatform: consignmentPlatforms(detail),
        password: row.game_password || "-",
        channelRegion: [row.platform, row.channel_region].filter(Boolean).join(" / ") || "-",
        boundPhone: row.bound_phone || "-",
        secondary: row.has_secondary == null ? "-" : row.has_secondary ? "有" : "无",
        showProfileFields: PROFILE_ACCOUNT_TYPES.has(row.inventory_type ?? ""),
        accountDescription: row.account_description || "-",
        accountImages: row.account_images ?? [],
        note: row.note || "-",
      }}
      editing={editing}
      onEdit={onEdit}
      eventDrafts={eventDrafts}
      onEventEdit={onEventEdit}
      employees={employees}
      executionRows={executionRows}
      auditRows={auditRows}
      financeRows={financeRows}
      expenseCount={expenseFlows.length}
      incomeCount={incomeFlows.length}
      totalExpense={totalExpense}
      totalIncome={totalIncome}
      flowCount={financialFlows.length + rebateItems.length}
    />
  );
}
