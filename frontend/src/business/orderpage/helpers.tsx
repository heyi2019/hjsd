import type { Order } from "../../shared/api/types/orders";
import { money } from "../../shared/lib/format";

export type BusinessFilterKey = "all" | "HS" | "TH" | "DG";
export type BusinessModeFilterKey = "all" | "SELF" | "DISTRIBUTION";

export const BUSINESS_CREATE_ITEMS = [
  { key: "HS", label: "新建回收订单" },
  { key: "TH", label: "新建提号订单" },
  { key: "DG", label: "新建代挂订单" },
];

export type AllocationType = "BUY" | "SELL" | "OPERATION" | "COMPANY";
export const ALLOCATION_TYPES: readonly AllocationType[] = ["BUY", "SELL", "OPERATION", "COMPANY"];

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
  employee_ids?: number[];
  role?: string;
  allocation_type?: AllocationType | "";
  allocation_rate?: string;
  allocation_amount?: string;
};

export type ActionAllocationCandidates = Record<AllocationType, number[]>;

/** 正整数 ID 去重：所有来源统一走这里，避免各写一遍。 */
function ids(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0))];
}

/** 已过账事件里的操作人，可按事件类型过滤。 */
function operatorIds(order: Pick<Order, "events">, eventTypes?: ReadonlySet<string>): number[] {
  const matched = (order.events ?? []).filter(
    (event) => event.is_posted && (!eventTypes || eventTypes.has(event.event_type)),
  );
  return ids(matched.flatMap((event) => event.operator_user_ids ?? []));
}

/** 依次取第一个非空来源，表达"首选 A、否则 B、再否则 C"的优先级。 */
function firstNonEmpty(...sources: number[][]): number[] {
  return sources.find((source) => source.length > 0) ?? [];
}

/** 从订单事实提取四类动作操作人：建单操作人、卖出表单操作人和运营信息中的操作人。 */
export function buildActionAllocationCandidates(
  order: Pick<Order, "events" | "form_extra">,
  defaultOperatorId?: number,
): ActionAllocationCandidates {
  const formExtra = order.form_extra ?? {};
  // 运营事件类型 = 除 BUY/SELL/CANCEL 之外的已登记事件。
  const operationTypes = new Set(
    (order.events ?? [])
      .map((event) => event.event_type)
      .filter((eventType) => !["BUY", "SELL", "CANCEL"].includes(eventType)),
  );
  const sellIds = operatorIds(order, new Set(["SELL"]));
  const operationEventIds = operatorIds(order, operationTypes);
  return {
    BUY: firstNonEmpty(ids(formExtra.business_responsible_ids), operatorIds(order, new Set(["BUY"]))),
    SELL: firstNonEmpty(ids(formExtra.delivery_responsible_ids), sellIds, defaultOperatorId ? [defaultOperatorId] : []),
    OPERATION: firstNonEmpty(ids(formExtra.operation_responsible_ids), operationEventIds, ids(formExtra.business_responsible_ids)),
    COMPANY: [],
  };
}

/**
 * 按操作四项构建表单行。每个动作固定一行，人员使用多选，比例或金额只填动作合计；
 * 保存时由后端按所选人数均分并校验。
 */
export function buildActionAllocationRows(
  items: Array<{
    allocation_type?: AllocationType | null;
    user_id?: number | null;
    role?: string;
    allocation_rate?: string;
    allocation_amount?: string;
  }>,
  candidates: ActionAllocationCandidates,
  totalsByType: Partial<Record<AllocationType, { allocation_rate: string; allocation_amount: string }>> = {},
): AllocationFormRow[] {
  return ALLOCATION_TYPES.map((kind) => {
    const isCompany = kind === "COMPANY";
    const existed = items.filter((item) => item.allocation_type === kind);
    const existedIds = ids(existed.map((item) => item.user_id));
    const selectedIds = isCompany ? undefined : firstNonEmpty(candidates[kind], existedIds);
    return {
      allocation_type: kind,
      employee: isCompany ? "COMPANY" : undefined,
      employee_ids: selectedIds,
      role: existed[0]?.role || ALLOCATION_TYPE_ROLE[kind],
      allocation_rate: totalsByType[kind]?.allocation_rate ?? "",
      allocation_amount: totalsByType[kind]?.allocation_amount ?? "",
    };
  });
}

export type CancelFormScope = "ORDERCANC" | "INVREFUND";

/** 从后端下发的可冲销动作里挑一条：显式选择优先，否则取第一条（reversibleEvents 已按新→旧排）。
 *  offsetEventId 来自表单，可能是 undefined / 字符串，统一 Number() 后比较。 */
export function pickCancelableEvent<T extends { event: { id: number }; remaining: string }>(
  reversible: T[],
  offsetEventId: unknown,
): T | undefined {
  return reversible.find((item) => item.event.id === Number(offsetEventId)) ?? reversible[0];
}

const CANCEL_AMOUNT_FIELD: Record<CancelFormScope, "cancel_amount" | "refund_amount"> = {
  ORDERCANC: "cancel_amount",
  INVREFUND: "refund_amount",
};

/**
 * 冲销/退款金额的确定与校验。
 * 规则：留空 → 全额（取剩余可冲金额）；必须为正数；不得超过剩余（1e-9 容差）。
 * 余额唯一来源是后端的 `event.cancellable_amount`，前端不重算。
 */
export function resolveCancelAmount(params: {
  scope: CancelFormScope;
  values: { amount?: string; cancel_amount?: string; refund_amount?: string };
  remaining: string;
}): { ok: true; amount: string } | { ok: false; error: string } {
  const { scope, values, remaining } = params;
  const field = CANCEL_AMOUNT_FIELD[scope];
  const raw = values[field] ?? values.amount;
  const amount = (raw ?? "").trim() || remaining;
  if (Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    return { ok: false, error: "请输入有效的冲销金额" };
  }
  if (Number(amount) > Number(remaining) + 1e-9) {
    return { ok: false, error: `冲销金额不能超过该动作剩余可冲金额 ¥${remaining}` };
  }
  return { ok: true, amount };
}

export function formatOrderAmount(order: Order): string {
  return order.sale_amount ? `¥${money(order.sale_amount)}` : "-";
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
