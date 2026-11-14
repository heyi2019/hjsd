import type { AccountExecutionDetail } from "../shared/api/types/account-execution";
import type { Account } from "../shared/api/types/accounts";
import { formatDateTimeMinute } from "../shared/lib/format";
import {
  BUSINESS_MODE_LABEL,
  INVENTORY_TYPE_LABEL,
  inventoryStatusLabel,
} from "./inventory-logic";

const INVENTORY_EXPORT_HEADERS = [
  "订单号", "业务", "类型", "游戏/产品类型", "营地账号", "库存编号", "平台", "成本", "库存状态", "未售时长",
  "建档操作人", "登记时间", "出售时间", "下架时间", "寄售时间", "寄售平台",
  "渠道 / 区服", "绑定手机号", "有无二次", "账号描述", "账号图片", "备注", "执行明细", "资金明细",
  "支出笔数", "收入笔数", "总支出", "总收入",
];
function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function exportDetailText(detail: AccountExecutionDetail | undefined, sourceOrderId?: number | null): {
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
  const detailView = detail?.detail_view;
  const financeRows = detailView?.finance_rows ?? [];
  const expenseRows = financeRows.filter((row) => row.direction === "支出");
  const incomeRows = financeRows.filter((row) => row.direction === "收入");
  const eventById = new Map(orders.flatMap((order) => order.events.map((event) => [event.id, { event, order }] as const)));
  const sourceOrder = sourceOrderId == null
    ? undefined
    : orders.find((order) => order.order_id === sourceOrderId);

  return {
    registrationAt: formatDateTimeMinute(sourceOrder?.created_at ?? sourceOrder?.trade_date),
    soldAt: formatDateTimeMinute(detailView?.lifecycle.sold_at),
    removedAt: formatDateTimeMinute(detailView?.lifecycle.removed_at),
    consignmentAt: formatDateTimeMinute(detailView?.operation_rows.find((row) => row.key === "consignment")?.occurred_at),
    consignmentPlatforms: detailView?.operation_rows.find((row) => row.key === "consignment")?.content ?? "-",
    execution: (detailView?.execution_rows ?? []).map((row) => {
      const linked = row.event_id == null ? undefined : eventById.get(row.event_id);
      const event = linked?.event;
      return [
        event ? `${event.event_no} · ${row.action}` : row.action,
        formatDateTimeMinute(row.occurred_at),
        row.amount ?? "-",
        row.note,
        row.operator,
      ].join(" / ");
    }).join("；"),
    finance: financeRows.map((row) => {
      const linked = row.event_id == null ? undefined : eventById.get(row.event_id);
      return [
        row.type,
        linked?.order.order_no ?? "",
        linked?.event.event_no ?? row.key,
        row.direction,
        row.amount,
        formatDateTimeMinute(row.occurred_at),
        row.pool_name,
      ].join(" / ");
    }).join("；"),
    expenseCount: expenseRows.length,
    incomeCount: incomeRows.length,
    // 合计取后端 finance_summary；条数仍按明细计数（条数是行数，不是金额）。
    totalExpense: detail?.finance_summary?.total_expense ?? "0.00",
    totalIncome: detail?.finance_summary?.total_income ?? "0.00",
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
      const detailText = exportDetailText(detail, row.source_order_id);
      return [
        row.source_order_no || "",
        row.business_mode ? BUSINESS_MODE_LABEL[row.business_mode] ?? row.business_mode : "",
        row.inventory_type ? INVENTORY_TYPE_LABEL[row.inventory_type] ?? row.inventory_type : "",
        row.game_type,
        row.camp_account,
        row.stock_no,
        row.platform,
        row.cost_amount,
        inventoryStatusLabel(row.inventory_status ?? "IN_STOCK"),
        row.inventory_age_days == null ? "" : `${row.inventory_age_days}天`,
        row.created_by,
        detailText.registrationAt,
        detailText.soldAt,
        detailText.removedAt,
        detailText.consignmentAt,
        detailText.consignmentPlatforms,
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
