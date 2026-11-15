import type { Order } from "../../shared/api/types/orders";
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
  const order: AllocationType[] = ["BUY", "SELL", "OPERATION", "COMPANY"];
  const rows: AllocationFormRow[] = [];
  for (const kind of order) {
    const existed = items.filter((item) => item.allocation_type === kind);
    const existedIds = kind === "COMPANY" ? [] : [...new Set(existed
      .map((item) => item.user_id)
      .filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0))];
    const candidateIds = kind === "COMPANY" ? [] : candidates[kind];
    const selectedIds = candidateIds.length > 0 ? candidateIds : existedIds;
    rows.push({
      allocation_type: kind,
      employee: kind === "COMPANY" ? "COMPANY" : undefined,
      employee_ids: kind === "COMPANY" ? undefined : selectedIds,
      role: existed[0]?.role || ALLOCATION_TYPE_ROLE[kind],
      allocation_rate: totalsByType[kind]?.allocation_rate ?? "",
      allocation_amount: totalsByType[kind]?.allocation_amount ?? "",
    });
  }
  return rows;
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

export function countBusinessOrders(orders: Order[], type: BusinessFilterKey, mode: BusinessModeFilterKey): number {
  return orders.filter((order) => (
    (type === "all" || order.order_type === type)
    && orderMatchesBusinessMode(order, mode)
  )).length;
}
