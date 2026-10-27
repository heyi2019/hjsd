import type { Account, AccountExecutionDetail } from "../shared/api/catalog";
import { executionActionLabel } from "../shared/lib/format";
import {
  BUSINESS_MODE_LABEL,
  INVENTORY_TYPE_LABEL,
  accountFinancialFlows,
  financeTypeLabel,
  inventoryAge,
  inventoryStatusLabel,
  rebateTypeLabel,
} from "./inventory-logic";

const INVENTORY_EXPORT_HEADERS = [
  "订单号", "业务", "类型", "产品", "库存编号", "平台", "成本", "库存状态", "未售时长",
  "建档操作人", "登记时间", "出售时间", "下架时间", "寄售时间", "寄售平台",
  "账号密码", "渠道 / 区服", "绑定手机号", "有无二次", "账号描述", "账号图片", "备注", "执行明细", "资金明细",
  "支出笔数", "收入笔数", "总支出", "总收入",
];
function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function exportDetailText(detail: AccountExecutionDetail | undefined): {
  registrationAt: string;
  soldAt: string;
  removedAt: string;
  consignmentAt: string;
  consignmentPlatforms: string;
  execution: string;
  finance: string;
  expenseCount: number;
  incomeCount: number;
  totalExpense: string;
  totalIncome: string;
} {
  const orders = detail?.orders ?? [];
  const financialFlows = accountFinancialFlows(detail);
  const rebateItems = orders.flatMap((order) => (
    (order.rebates ?? []).map((rebate) => ({ order, rebate }))
  ));
  const expenseFlows = financialFlows.filter(({ cashflow }) => cashflow.direction === "OUT");
  const incomeFlows = financialFlows.filter(({ cashflow }) => cashflow.direction === "IN");
  const sourceOrder = orders[0];

  return {
    registrationAt: dateTimeMinute(sourceOrder?.created_at ?? sourceOrder?.trade_date),
    soldAt: eventDate(detail, "SELL"),
    removedAt: eventDate(detail, "CANCEL"),
    consignmentAt: platformListingDate(detail),
    consignmentPlatforms: consignmentPlatforms(detail),
    execution: orders.flatMap((order) => order.events.map((event) => [
      `${event.event_no} · ${executionActionLabel(event.event_type, order.order_type)}`,
      dateTimeMinute(event.occurred_at ?? event.occurred_on),
      event.amount,
      event.note || "-",
      event.operator || "-",
    ].join(" / "))).join("；"),
    finance: [
      ...financialFlows.map(({ order, event, cashflow }) => [
        financeTypeLabel(event?.event_type ?? "", cashflow.direction),
        order.order_no,
        cashflow.flow_no,
        cashflow.direction === "OUT" ? "支出" : "收入",
        cashflow.amount,
        dateTimeMinute(cashflow.occurred_at ?? cashflow.occurred_on),
        cashflow.pool_name || "未分配资金池",
      ].join(" / ")),
      ...rebateItems.map(({ order, rebate }) => [
        rebateTypeLabel(rebate.rebate_type, rebate.channel),
        order.order_no,
        rebate.rebate_no,
        rebate.status,
        rebate.base_amount,
        `${rebate.rate}%`,
        dateTimeMinute(rebate.collected_at ?? rebate.collected_on),
      ].join(" / ")),
    ].join("；"),
    expenseCount: expenseFlows.length,
    incomeCount: incomeFlows.length,
    totalExpense: expenseFlows.reduce((sum, { cashflow }) => sum + Number(cashflow.amount), 0).toFixed(2),
    totalIncome: incomeFlows.reduce((sum, { cashflow }) => sum + Number(cashflow.amount), 0).toFixed(2),
  };
}

export function buildInventoryCsv(
  rows: Account[],
  details: Partial<Record<number, AccountExecutionDetail>> = {},
): string {
  const lines = [
    INVENTORY_EXPORT_HEADERS,
    ...rows.map((row) => {
      const detail = details[row.id];
      const detailText = exportDetailText(detail);
      const age = inventoryAge(row);
      return [
        row.source_order_no,
        row.business_mode ? BUSINESS_MODE_LABEL[row.business_mode] ?? row.business_mode : "",
        row.inventory_type ? INVENTORY_TYPE_LABEL[row.inventory_type] ?? row.inventory_type : "",
        row.game_type,
        row.game_account,
        row.platform,
        row.cost_amount,
        inventoryStatusLabel(row.status),
        age ? `${age.days}天` : "",
        row.created_by,
        detailText.registrationAt,
        detailText.soldAt,
        detailText.removedAt,
        detailText.consignmentAt,
        detailText.consignmentPlatforms,
        row.game_password,
        row.channel_region,
        row.bound_phone,
        row.has_secondary == null ? "" : row.has_secondary ? "有" : "无",
        row.account_description,
        (row.account_images ?? []).length ? `${(row.account_images ?? []).length}张` : "",
        row.note,
        detailText.execution,
        detailText.finance,
        detailText.expenseCount,
        detailText.incomeCount,
        detailText.totalExpense,
        detailText.totalIncome,
      ];
    }),
  ];
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function downloadInventoryCsv(rows: Account[], details: Partial<Record<number, AccountExecutionDetail>>): void {
  const blob = new Blob([buildInventoryCsv(rows, details)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `库存中心_${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function dateTimeMinute(value: string | null | undefined): string {
  if (!value) return "-";
  const normalized = value.replace("T", " ");
  return normalized.length >= 16 ? normalized.slice(0, 16) : `${normalized.slice(0, 10)} 00:00`;
}

function eventDate(detail: AccountExecutionDetail | undefined, eventType: string): string {
  const event = detail?.orders.flatMap((order) => order.events)
    .find((item) => item.event_type === eventType);
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

function estimatedRebateAmount(baseAmount: string, rate: string): string {
  const amount = Number(baseAmount) * Number(rate) / 100;
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}


