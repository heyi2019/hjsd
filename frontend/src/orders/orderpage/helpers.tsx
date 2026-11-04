import type { Order } from "../../shared/api/catalog";
import type { OrderPatchPayload } from "../../shared/api/orders.api";
import type { Dayjs } from "dayjs";
import { money } from "../../shared/lib/format";

export type BusinessFilterKey = "all" | "HS" | "TH" | "DG";
export type BusinessModeFilterKey = "all" | "SELF" | "DISTRIBUTION";

export const BUSINESS_CREATE_ITEMS = [
  { key: "HS", label: "新建回收订单" },
  { key: "TH", label: "新建提号订单" },
  { key: "DG", label: "新建代挂订单" },
];

export type AllocationType = "BUY" | "SELL" | "OPERATION" | "COMPANY";

/** 分润录入口径：按人自由分配，或按操作四项（买号/售出/运营/公司）。 */
export type AllocationMode = "PERSON" | "ACTION";

export const ALLOCATION_TYPE_LABEL: Record<AllocationType, string> = {
  BUY: "买号",
  SELL: "售出",
  OPERATION: "运营",
  COMPANY: "公司",
};

export const ALLOCATION_TYPE_ROLE: Record<AllocationType, string> = {
  BUY: "BUYER",
  SELL: "SALES",
  OPERATION: "SERVICE",
  COMPANY: "OWNER",
};

export type AllocationFormRow = {
  employee?: number | "COMPANY";
  role?: string;
  allocation_type?: AllocationType | "";
  allocation_rate?: string;
  allocation_amount?: string;
};

export type AllocationItem = {
  user_id: number | null;
  role: string;
  allocation_type?: AllocationType | null;
  allocation_rate: string;
  allocation_amount: string;
};

export type ActionAllocationCandidates = Record<AllocationType, number[]>;

export type AllocationValidation =
  | { ok: true; items: AllocationItem[] }
  | { ok: false; error: string };

function responsibleIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0))];
}

function postedEventOperatorIds(order: Pick<Order, "events">, eventTypes?: Set<string>): number[] {
  return [...new Set((order.events ?? [])
    .filter((event) => event.is_posted && (!eventTypes || eventTypes.has(event.event_type)))
    .flatMap((event) => responsibleIds(event.operator_user_ids)))];
}

/** 从订单事实提取四类动作负责人：建单负责人、卖出表单负责人和运营信息中的操作人。 */
export function buildActionAllocationCandidates(order: Pick<Order, "events" | "form_extra">): ActionAllocationCandidates {
  const formExtra = order.form_extra ?? {};
  const businessResponsibleIds = responsibleIds(formExtra.business_responsible_ids);
  const deliveryResponsibleIds = responsibleIds(formExtra.delivery_responsible_ids);
  const operationResponsibleIds = responsibleIds(formExtra.operation_responsible_ids);
  const operationEventTypes = new Set((order.events ?? [])
    .map((event) => event.event_type)
    .filter((eventType) => !["BUY", "SELL", "CANCEL"].includes(eventType)));
  const operationEventOperatorIds = postedEventOperatorIds(order, operationEventTypes);
  return {
    BUY: businessResponsibleIds.length ? businessResponsibleIds : postedEventOperatorIds(order, new Set(["BUY"])),
    SELL: deliveryResponsibleIds.length ? deliveryResponsibleIds : postedEventOperatorIds(order, new Set(["SELL"])),
    OPERATION: operationResponsibleIds.length
      ? operationResponsibleIds
      : operationEventOperatorIds.length ? operationEventOperatorIds : businessResponsibleIds,
    COMPANY: [],
  };
}

/** 按操作四项构建表单行：买号/售出只有唯一执行人时自动带出，多人协作留空由人工选。 */
export function buildActionAllocationRows(
  items: Array<{
    allocation_type?: AllocationType | null;
    user_id?: number | null;
    role?: string;
    allocation_rate?: string;
    allocation_amount?: string;
  }>,
  candidates: ActionAllocationCandidates,
): AllocationFormRow[] {
  const order: AllocationType[] = ["BUY", "SELL", "OPERATION", "COMPANY"];
  return order.map((kind) => {
    const existed = items.find((item) => item.allocation_type === kind);
    let employee: number | "COMPANY" | undefined;
    if (existed) {
      employee = existed.user_id ?? "COMPANY";
    } else if (kind === "COMPANY") {
      employee = "COMPANY";
    } else {
      const ids = candidates[kind];
      employee = ids.length === 1 ? ids[0] : undefined;
    }
    return {
      allocation_type: kind,
      employee,
      role: ALLOCATION_TYPE_ROLE[kind],
      allocation_rate: existed?.allocation_rate ?? "",
      allocation_amount: existed?.allocation_amount ?? "",
    };
  });
}

export function validateAllocations(
  rows: AllocationFormRow[],
  orderProfit: string,
  mode: AllocationMode = "PERSON",
): AllocationValidation {
  const items: AllocationItem[] = [];
  let rateTotal = 0;
  let amountTotal = 0;

  if (mode === "ACTION") {
    const kinds = rows.map((row) => row.allocation_type);
    const expected: AllocationType[] = ["BUY", "SELL", "OPERATION", "COMPANY"];
    if (rows.length !== 4 || expected.some((kind) => !kinds.includes(kind))) {
      return { ok: false, error: "按操作分配必须且只能包含买号、售出、运营、公司四项" };
    }
    for (const row of rows) {
      const rate = Number(String(row.allocation_rate ?? "").trim());
      const amount = Number(String(row.allocation_amount ?? "").trim());
      const hasRate = String(row.allocation_rate ?? "").trim() !== "";
      const hasAmount = String(row.allocation_amount ?? "").trim() !== "";
      if ((!hasRate && !hasAmount) || (hasRate && (!Number.isFinite(rate) || rate < 0)) || (hasAmount && (!Number.isFinite(amount) || amount < 0))) {
        return { ok: false, error: `${ALLOCATION_TYPE_LABEL[row.allocation_type as AllocationType]} 请输入有效的比例或金额` };
      }
      if (hasRate) rateTotal += rate;
      if (hasAmount) amountTotal += amount;
      const kind = row.allocation_type as AllocationType;
      items.push({
        user_id: kind === "COMPANY" || row.employee == null || row.employee === "COMPANY" ? null : Number(row.employee),
        role: row.role || ALLOCATION_TYPE_ROLE[kind],
        allocation_type: kind,
        allocation_rate: "0",
        allocation_amount: "0",
      });
    }
    const useRate = Math.abs(rateTotal - 100) <= 0.001 || amountTotal === 0;
    if (useRate && Math.abs(rateTotal - 100) > 0.001) {
      return { ok: false, error: "四项比例合计必须为 100%" };
    }
    if (!useRate) {
      const profit = Number(orderProfit);
      if (profit <= 0) return { ok: false, error: "该单当前为亏损或无利润，不能按金额分润，请改用比例" };
      if (amountTotal > profit) return { ok: false, error: `分润金额合计不能超过订单总利润 ${money(orderProfit)}` };
    }
    items.forEach((item, index) => {
      const row = rows[index];
      const rate = Number(String(row.allocation_rate ?? "").trim());
      const amount = Number(String(row.allocation_amount ?? "").trim());
      item.allocation_rate = useRate ? String(rate) : "0";
      item.allocation_amount = useRate ? "0" : String(amount);
    });
    return { ok: true, items };
  }

  for (const row of rows) {
    const rate = String(row.allocation_rate ?? "").trim();
    const amount = String(row.allocation_amount ?? "").trim();
    const hasRate = Number(rate) > 0;
    const hasAmount = Number(amount) > 0;
    if (!hasRate && !hasAmount) return { ok: false, error: "每行至少填比例或金额之一" };
    if (hasRate && hasAmount && Number.isFinite(Number(rate)) && Number.isFinite(Number(amount)) && Number(orderProfit) > 0) {
      const expectedAmount = Number(orderProfit) * Number(rate) / 100;
      if (Math.abs(expectedAmount - Number(amount)) > 0.01) return { ok: false, error: "比例和金额换算不一致" };
    }
    if (hasRate) rateTotal += Number(rate);
    if (hasAmount) amountTotal += Number(amount);
    items.push({
      user_id: row.employee === "COMPANY" ? null : Number(row.employee),
      role: row.role || "OWNER",
      allocation_rate: "0",
      allocation_amount: "0",
    });
  }
  const useRate = Math.abs(rateTotal - 100) <= 0.001 || amountTotal === 0;
  if (useRate && amountTotal === 0 && Math.abs(rateTotal - 100) > 0.001) {
    return { ok: false, error: "按比例分润时合计必须为 100%（也可改用金额）" };
  }
  if (!useRate && amountTotal > 0) {
    const profit = Number(orderProfit);
    if (profit <= 0) return { ok: false, error: "该单当前为亏损或无利润，不能按金额分润，请改用比例" };
    if (amountTotal > profit) return { ok: false, error: `分润金额合计不能超过订单总利润 ${money(orderProfit)}` };
  }
  items.forEach((item, index) => {
    const row = rows[index];
    item.allocation_rate = useRate ? String(row.allocation_rate ?? "0") : "0";
    item.allocation_amount = useRate ? "0" : String(row.allocation_amount ?? "0");
  });
  return { ok: true, items };
}

export type CancelFormScope = "ORDERCANC" | "INVREFUND";

/** 从后端下发的可冲销动作里挑一条：显式选择优先，否则取第一条（reversibleEvents 已按新→旧排）。
 *  offsetEventId 来自表单，可能是 undefined / 字符串，统一 Number() 后比较，与旧内联逻辑一致。 */
export function pickCancelableEvent<T extends { event: { id: number }; remaining: string }>(
  reversible: T[],
  offsetEventId: unknown,
): T | undefined {
  return reversible.find((item) => item.event.id === Number(offsetEventId)) ?? reversible[0];
}

/**
 * 冲销/退款金额的确定与校验（原本内联在 submitCancelTransaction 里，无任何测试可触达）。
 * 规则：留空或不填 → 全额（取剩余可冲金额）；必须是正数；不得超过剩余可冲金额（1e-9 容差）。
 * 余额唯一来源是后端的 `event.cancellable_amount`，前端不重算。
 */
export function resolveCancelAmount(params: {
  scope: CancelFormScope;
  values: { amount?: string; cancel_amount?: string; refund_amount?: string };
  remaining: string;
}): { ok: true; amount: string } | { ok: false; error: string } {
  const { scope, values, remaining } = params;
  const raw = scope === "INVREFUND"
    ? (values.refund_amount ?? values.amount)
    : (values.cancel_amount ?? values.amount);
  const amount = (raw ?? "").trim() || remaining;
  if (Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    return { ok: false, error: "请输入有效的冲销金额" };
  }
  if (Number(amount) > Number(remaining) + 1e-9) {
    return { ok: false, error: `冲销金额不能超过该动作剩余可冲金额 ¥${remaining}` };
  }
  return { ok: true, amount };
}

/**
 * 订单编辑 PATCH 入参组装（原本内联在 submitEditOrder 里）。
 * 三条规则都由后端契约决定，抽出来才可免挂载覆盖：
 *  1. 成交日期始终回写：后端按天数差平移本单事件/资金流水日期并重取规则快照；
 *  2. 快照密码被后端隐去（无 order.create 权限）→ 完全不带 account_snapshot，
 *     避免把隐藏密码覆盖成空；
 *  3. 快照是整体替换：表单里没有的控件（钱包实名 / 营地账号）沿用原快照值，
 *     否则编辑一次订单就把钱包实名抹掉。
 */
export function buildOrderPatchPayload(params: {
  values: Record<string, unknown>;
  snapshot: Order["account_snapshot"];
  hasPosted: boolean;
}): OrderPatchPayload {
  const { values, snapshot, hasPosted } = params;
  const payload: OrderPatchPayload = {};
  // 成交日期始终回写；hasPosted 只影响账号快照（后端对有登记事件的单也拒收快照）。
  payload.trade_date = values.trade_date as string;
  const note = (values.note as string | undefined)?.trim();
  payload.note = note ? note : null;
  payload.form_extra = (values.form_extra as Record<string, unknown> | undefined) ?? undefined;
  if (!hasPosted && snapshot && snapshot.game_password) {
    payload.account_snapshot = {
      game_account: (values.snap_game_account as string) ?? snapshot.game_account,
      game_type: (values.snap_game_type as string) || null,
      game_password: (values.snap_game_password as string) || null,
      channel_region: (values.snap_channel_region as string) || null,
      bound_phone: (values.snap_bound_phone as string) || null,
      wallet_realname: (values.snap_wallet_realname as string) || snapshot.wallet_realname || null,
      camp_account: (values.snap_camp_account as string) || snapshot.camp_account || null,
      platform: (values.snap_platform as string) || null,
      purchase_price: (values.snap_purchase_price as string) || null,
      note: (values.snap_note as string) || null,
    };
  }
  return payload;
}

/**
 * 资金收支（REFUND）事件入参组装。两条规则此前只能靠挂载页面才能碰到：
 *  - 发生日期留空 → 取当天（后端不接受空日期）；
 *  - 资金账户「显式选择优先」：未选时保持 undefined，让后端按订单类型默认路由，
 *    不要擅自填 0 或空串（会被当成某个池的 id）。
 */
export function buildRefundEventPayload(params: {
  values: {
    amount: string;
    occurred_on?: Dayjs | null;
    pool_id?: number | string;
    reason?: string;
    operator_user_ids?: number[];
    form_extra?: Record<string, unknown>;
  };
  fallbackDate: string;
}): {
  event_type: "REFUND";
  amount: string;
  occurred_on: string;
  pool_id?: number;
  reason?: string;
  operator_user_ids?: number[];
  form_extra?: Record<string, unknown>;
} {
  const { values, fallbackDate } = params;
  return {
    event_type: "REFUND",
    amount: values.amount,
    occurred_on: values.occurred_on?.format("YYYY-MM-DD") ?? fallbackDate,
    pool_id: values.pool_id === undefined || values.pool_id === null || values.pool_id === ""
      ? undefined
      : Number(values.pool_id),
    reason: values.reason,
    operator_user_ids: values.operator_user_ids,
    form_extra: values.form_extra,
  };
}

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
