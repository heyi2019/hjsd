import type { Order } from "../shared/api/catalog";
import { ACCOUNT_STATUS_LABEL, executionActionLabel, money } from "../shared/lib/format";
import { PermissionButton, StatusTag } from "../shared/ui";

export function MobileOrderList(props: {
  orders: Order[];
  emptyText: string;
  onSelect: (order: Order) => void;
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
            <div><dt>对方 / 来源</dt><dd>{[order.party_name, order.party_source].filter(Boolean).join(" · ") || "-"}</dd></div>
            <div><dt>游戏/产品类型</dt><dd>{order.account_game_type || "-"}</dd></div>
            <div><dt>游戏账号/产品</dt><dd>{order.account_game_account || "-"}</dd></div>
            <div><dt>平台</dt><dd>{order.account_platform || "-"}</dd></div>
            <div><dt>金额</dt><dd>{formatOrderAmount(order)}</dd></div>
            <div><dt>账号周期</dt><dd>{order.account_status ? ACCOUNT_STATUS_LABEL[order.account_status] ?? order.account_status : "-"}</dd></div>
            <div><dt>最新动作</dt><dd>{order.last_event_type ? executionActionLabel(order.last_event_type, order.order_type) : "-"}</dd></div>
            <div><dt>日期</dt><dd>{order.trade_date || "-"}</dd></div>
          </dl>
          <PermissionButton permission="order.update" type="link" onClick={() => props.onSelect(order)}>编辑订单</PermissionButton>
        </article>
      ))}
    </div>
  );
}

export type BusinessFilterKey = "all" | "HS" | "TH" | "DG";
export type BusinessModeFilterKey = "all" | "SELF" | "DISTRIBUTION";

export const BUSINESS_CREATE_ITEMS = [
  { key: "HS", label: "新建回收订单" },
  { key: "TH", label: "新建提号订单" },
  { key: "DG", label: "新建代挂订单" },
];

/** 分润弹窗的一行：姓名（员工 id 或 COMPANY）+ 角色 + 比例 + 金额（比例/金额都选填、互斥）。 */
export type AllocationFormRow = {
  employee?: number | "COMPANY";
  role?: string;
  allocation_rate?: string;
  allocation_amount?: string;
};

/** 分润表单的纯校验函数（不依赖组件/副作用，供单测矩阵直接覆盖）。
 *  入参 rows 已是「已选员工」过滤结果（组件层已剔除 employee 为空者）。
 *  返回 ok 时带归一化后的 items；返回非 ok 时带与组件一致的报错文案。 */
export type AllocationItem = {
  user_id: number | null;
  role: string;
  allocation_rate: string;
  allocation_amount: string;
};
export type AllocationValidation =
  | { ok: true; items: AllocationItem[] }
  | { ok: false; error: string };

export function validateAllocations(
  rows: AllocationFormRow[],
  orderProfit: string,
): AllocationValidation {
  const items: AllocationItem[] = [];
  let rateTotal = 0;
  let amountTotal = 0;
  for (const row of rows) {
    const rate = String(row.allocation_rate ?? "").trim();
    const amount = String(row.allocation_amount ?? "").trim();
    // 「已填」按数值 > 0 判定：后端回显的 0.00 不算填了比例/金额，
    // 否则金额分润的行会被互斥校验误拦。
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
  // 纯比例分润沿用「合计 100%」；一旦有人填金额，改为金额口径（后端校验不超利润）。
  if (amountTotal === 0 && Math.abs(rateTotal - 100) > 0.001) {
    return { ok: false, error: "按比例分润时合计必须为 100%（也可改用金额）" };
  }
  // 金额口径的前置拦截，与后端 _set_person_allocations 保持一致：
  // 亏损/无利润单不接受金额分润，且金额合计不得超过订单总利润。
  if (amountTotal > 0) {
    const profit = Number(orderProfit);
    if (profit <= 0) return { ok: false, error: "该单当前为亏损或无利润，不能按金额分润，请改用比例" };
    if (amountTotal > profit) {
      return { ok: false, error: `分润金额合计不能超过订单总利润 ${money(orderProfit)}` };
    }
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
  link: string,
): Order[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  return orders.filter((order) => (
    (type === "all" || order.order_type === type)
    && orderMatchesBusinessMode(order, mode)
    && (link === "all" || (order.link_status ?? "LINKED") === link)
    && (!normalizedKeyword || orderSearchText(order).includes(normalizedKeyword))
  ));
}

export function countBusinessOrders(orders: Order[], type: BusinessFilterKey, mode: BusinessModeFilterKey, link: string): number {
  return orders.filter((order) => (
    (type === "all" || order.order_type === type)
    && orderMatchesBusinessMode(order, mode)
    && (link === "all" || (order.link_status ?? "LINKED") === link)
  )).length;
}

