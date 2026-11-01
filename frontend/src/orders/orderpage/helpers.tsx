import type { Order } from "../../shared/api/catalog";
import { ACCOUNT_STATUS_LABEL, executionActionLabel, formatDateTimeMinute, formatElapsedTime, money } from "../../shared/lib/format";
import { orderMobileFields as arrangeMobileFields } from "../../shared/lib/listColumns";
import { PermissionButton, StatusTag } from "../../shared/ui";

export type BusinessFilterKey = "all" | "HS" | "TH" | "DG";
export type BusinessModeFilterKey = "all" | "SELF" | "DISTRIBUTION";

export const BUSINESS_CREATE_ITEMS = [
  { key: "HS", label: "新建回收订单" },
  { key: "TH", label: "新建提号订单" },
  { key: "DG", label: "新建代挂订单" },
];

export type AllocationFormRow = {
  employee?: number | "COMPANY";
  role?: string;
  allocation_rate?: string;
  allocation_amount?: string;
};

export type AllocationItem = {
  user_id: number | null;
  role: string;
  allocation_rate: string;
  allocation_amount: string;
};

export type AllocationValidation =
  | { ok: true; items: AllocationItem[] }
  | { ok: false; error: string };

export function validateAllocations(rows: AllocationFormRow[], orderProfit: string): AllocationValidation {
  const items: AllocationItem[] = [];
  let rateTotal = 0;
  let amountTotal = 0;
  for (const row of rows) {
    const rate = String(row.allocation_rate ?? "").trim();
    const amount = String(row.allocation_amount ?? "").trim();
    const hasRate = Number(rate) > 0;
    const hasAmount = Number(amount) > 0;
    if (!hasRate && !hasAmount) return { ok: false, error: "每行至少填比例或金额之一" };
    if (hasRate && hasAmount) return { ok: false, error: "同一行不能同时填比例和金额" };
    if (hasRate) rateTotal += Number(rate);
    if (hasAmount) amountTotal += Number(amount);
    items.push({
      user_id: row.employee === "COMPANY" ? null : Number(row.employee),
      role: row.role || "OWNER",
      allocation_rate: hasRate ? rate : "0",
      allocation_amount: hasAmount ? amount : "0",
    });
  }
  if (amountTotal === 0 && Math.abs(rateTotal - 100) > 0.001) {
    return { ok: false, error: "按比例分润时合计必须为 100%（也可改用金额）" };
  }
  if (amountTotal > 0) {
    const profit = Number(orderProfit);
    if (profit <= 0) return { ok: false, error: "该单当前为亏损或无利润，不能按金额分润，请改用比例" };
    if (amountTotal > profit) return { ok: false, error: `分润金额合计不能超过订单总利润 ${money(orderProfit)}` };
  }
  return { ok: true, items };
}

export type CancelFormScope = "ORDERCANC" | "INVREFUND";

export function formatOrderAmount(order: Order): string {
  if (order.installment_principal) {
    return `¥${order.installment_paid ?? "0.00"}/${order.installment_principal} · ${order.installment_periods ?? 0}期`;
  }
  return order.event_total ? `¥${money(order.event_total)}` : "-";
}

export function orderSearchText(order: Order): string {
  return [
    order.order_no,
    order.account_game_type,
    order.account_game_account,
    order.account_channel_region,
    order.party_name,
    order.party_source,
    order.note,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function orderMatchesBusinessMode(order: Order, mode: BusinessModeFilterKey): boolean {
  return mode === "all" || order.business_mode === mode || order.account_business_mode === mode;
}

export function filterBusinessOrders(
  orders: Order[],
  type: BusinessFilterKey,
  mode: BusinessModeFilterKey,
  keyword: string,
  gameType: string,
  inventoryStatus: string,
): Order[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  return orders.filter((order) => (
    (type === "all" || order.order_type === type)
    && orderMatchesBusinessMode(order, mode)
    && (gameType === "all" || order.account_game_type === gameType)
    && (inventoryStatus === "all" || order.account_status === inventoryStatus)
    && (!normalizedKeyword || orderSearchText(order).includes(normalizedKeyword))
  ));
}

export function countBusinessOrders(orders: Order[], type: BusinessFilterKey, mode: BusinessModeFilterKey): number {
  return orders.filter((order) => (
    (type === "all" || order.order_type === type)
    && orderMatchesBusinessMode(order, mode)
  )).length;
}

export function MobileOrderList(props: {
  orders: Order[];
  emptyText: string;
  onSelect: (order: Order) => void;
  fieldOrder?: string[];
}) {
  if (!props.orders.length) return <div className="orders-mobile-empty muted">{props.emptyText}</div>;
  return (
    <div className="orders-mobile-list" aria-label="订单列表">
      {props.orders.map((order) => (
        <article className="orders-mobile-card" key={order.id}>
          <div className="orders-mobile-card__topline">
            <strong>{order.order_no}</strong>
            <StatusTag status={order.status} optionSet="ORDER_STATUS" />
          </div>
          <dl className="orders-mobile-card__meta">
            {arrangeMobileFields([
              { key: "party", label: "对方 / 来源", value: [order.party_name, order.party_source].filter(Boolean).join(" · ") || "-" },
              { key: "account_game_type", label: "游戏/产品类型", value: order.account_game_type || "-" },
              { key: "account_game_account", label: "游戏账号/产品", value: order.account_game_account || "-" },
              { key: "account_platform", label: "平台", value: order.account_platform || "-" },
              { key: "inventory_operator", label: "入库负责人", value: order.inventory_operator || "-" },
              { key: "inventory_entry_at", label: "入库时间", value: formatDateTimeMinute(order.inventory_entry_at) },
              { key: "sale_operator", label: "售卖负责人", value: order.sale_operator || "-" },
              { key: "sale_at", label: "售卖时间", value: formatDateTimeMinute(order.sale_at) },
              { key: "in_hand_time", label: "在手时间", value: formatElapsedTime(order.inventory_entry_at, order.sale_at) },
              { key: "event_total", label: "金额", value: formatOrderAmount(order) },
              { key: "account_status", label: "账号周期", value: order.account_status ? ACCOUNT_STATUS_LABEL[order.account_status] ?? order.account_status : "-" },
              { key: "last_event_type", label: "最新动作", value: order.last_event_type ? executionActionLabel(order.last_event_type, order.order_type) : "-" },
              { key: "trade_date", label: "日期", value: order.trade_date || "-" },
            ], props.fieldOrder).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
          </dl>
          <PermissionButton permission="order.update" type="link" onClick={() => props.onSelect(order)}>编辑订单</PermissionButton>
        </article>
      ))}
    </div>
  );
}

export const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  PENDING: "待收",
  PARTIAL: "部分收取",
  PAID: "已付清",
  OVERDUE: "逾期",
  WAIVED: "已减免",
};

export const EVENT_PORTION_LABEL: Record<string, string> = { PRINCIPAL: "本金", PROFIT: "利润", GROSS: "总额" };
export const DELIVERY_MODE_LABEL: Record<string, string> = { PLATFORM_OPERATOR: "平台/本方操作换绑", CUSTOMER_SELF: "客户自行换绑" };
export const REFUND_RESPONSIBILITY_LABEL: Record<string, string> = { COMPANY: "公司", CUSTOMER: "客户", CONSIGNOR: "寄售方", PLATFORM: "平台", OTHER: "其他" };
