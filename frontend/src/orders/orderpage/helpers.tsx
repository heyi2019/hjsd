import type { Order } from "../../shared/api/types/orders";
import type { Dayjs } from "dayjs";
import { money } from "../../shared/lib/format";
import { toCents, fromCents, toBasisPoints, amountByBasisPoints, basisPointsByAmount, fromBasisPoints } from "../../shared/lib/money";

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

/** 把一组行里某个字段的有效数值加起来；全是空值就返回空串（不猜、不换算）。 */
function sumRowValue(
  rows: Array<{ allocation_rate?: string; allocation_amount?: string }>,
  key: "allocation_rate" | "allocation_amount",
): string {
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const text = String(row[key] ?? "").trim();
    if (text === "") continue;
    const value = Number(text);
    if (!Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? String(Number(total.toFixed(2))) : "";
}

/**
 * 按操作四项构建表单行。每个动作固定一行，人员使用多选，比例或金额只填动作合计；
 * 保存时再由 validateAllocations 按所选人数均分给后端。
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
      allocation_rate: sumRowValue(existed, "allocation_rate"),
      allocation_amount: sumRowValue(existed, "allocation_amount"),
    });
  }
  return rows;
}

/** 把合计均分到 N 人：按分（金额）/ 0.01（比例）取整，余数给最后一人，保证各人之和等于合计。 */
export function splitEven(total: number, people: number, scale = 100): number[] {
  const units = Math.round(total * scale);
  const base = Math.trunc(units / people);
  const parts = Array.from({ length: people }, () => base);
  parts[people - 1] += units - base * people;
  return parts.map((unit) => unit / scale);
}

/** 分润输入联动：按订单利润把比例换算成金额。
 *  走 money.ts 的整数分/基点口径：333.35 × 30% 必须得 100.01；
 *  旧实现的浮点 (333.35 * 30 / 100).toFixed(2) 会因 100.00499... 少 1 分得 100.00。 */
export function allocationAmountFromRate(orderProfit: string, rate: string): string {
  if (String(rate).trim() === "") return "";
  const profitCents = toCents(orderProfit);
  const bp = toBasisPoints(rate);
  if (!Number.isFinite(profitCents) || !Number.isFinite(bp)) return "";
  return fromCents(amountByBasisPoints(profitCents, bp));
}

/** 分润输入联动：按订单利润把金额反算成比例；利润为 0 时没有可推导的比例。
 *  同样走整数分/基点，避免浮点换算在末位漂移。 */
export function allocationRateFromAmount(orderProfit: string, amount: string): string {
  if (String(amount).trim() === "") return "";
  const profitCents = toCents(orderProfit);
  const amountCents = toCents(amount);
  if (!Number.isFinite(profitCents) || !Number.isFinite(amountCents) || profitCents === 0) return "";
  const bp = basisPointsByAmount(profitCents, amountCents);
  if (!Number.isFinite(bp)) return "";
  return fromBasisPoints(bp);
}

export function validateAllocations(
  rows: AllocationFormRow[],
  orderProfit: string,
): AllocationValidation {
  const order: AllocationType[] = ["BUY", "SELL", "OPERATION", "COMPANY"];
  const groups = new Map<AllocationType, AllocationFormRow[]>();
  for (const row of rows) {
    const kind = (row.allocation_type ?? "") as AllocationType;
    if (!order.includes(kind)) {
      return { ok: false, error: "分润配置只允许买号、售出、运营、公司四项" };
    }
    groups.set(kind, [...(groups.get(kind) ?? []), row]);
  }
  if (order.some((kind) => !(groups.get(kind)?.length))) {
    return { ok: false, error: "分润配置必须包含买号、售出、运营、公司四项" };
  }
  if (order.some((kind) => (groups.get(kind)?.length ?? 0) !== 1)) {
    return { ok: false, error: "分润配置每项只能有一行" };
  }

  type Expanded = { kind: AllocationType; employee?: number | "COMPANY"; role?: string; rate: number; amount: number; hasRate: boolean; hasAmount: boolean };
  const expanded: Expanded[] = [];
  for (const kind of order) {
    const row = groups.get(kind)?.[0] as AllocationFormRow;
    const rateText = String(row.allocation_rate ?? "").trim();
    const amountText = String(row.allocation_amount ?? "").trim();
    const rate = rateText === "" ? 0 : Number(rateText);
    const amount = amountText === "" ? 0 : Number(amountText);
    const hasRate = rateText !== "" && Number.isFinite(rate);
    const hasAmount = amountText !== "" && Number.isFinite(amount);
    if (!hasRate && !hasAmount) {
      return { ok: false, error: `${ALLOCATION_TYPE_LABEL[kind]} 请填写比例或金额` };
    }
    if (hasRate && rate < 0) {
      return { ok: false, error: `${ALLOCATION_TYPE_LABEL[kind]} 比例不能为负数` };
    }
    const employees = kind === "COMPANY"
      ? ["COMPANY" as const]
      : (row.employee_ids?.length ? row.employee_ids : [undefined]);
    const rates = hasRate ? splitEven(rate, employees.length) : [];
    const amounts = hasAmount ? splitEven(amount, employees.length) : [];
    employees.forEach((employee, index) => {
      expanded.push({
        kind,
        employee,
        role: row.role || ALLOCATION_TYPE_ROLE[kind],
        rate: rates[index] ?? 0,
        amount: amounts[index] ?? 0,
        hasRate,
        hasAmount,
      });
    });
  }

  // 一行可以同时填比例和金额（提交时按全局口径只取一个），
  // 但不能「有的行只填比例、有的行只填金额」——那样合计口径自相矛盾。
  const onlyRate = expanded.some((row) => row.hasRate && !row.hasAmount);
  const onlyAmount = expanded.some((row) => row.hasAmount && !row.hasRate);
  if (onlyRate && onlyAmount) {
    return { ok: false, error: "同一单的四项要么都按比例、要么都按金额，不能混填" };
  }
  const rateTotal = expanded.reduce((sum, row) => sum + row.rate, 0);
  const amountTotal = expanded.reduce((sum, row) => sum + row.amount, 0);
  const useRate = Math.abs(rateTotal - 100) <= 0.001 || amountTotal === 0;
  if (useRate) {
    if (Math.abs(rateTotal - 100) > 0.001) {
      return { ok: false, error: `四项比例合计必须为 100%，当前 ${Number(rateTotal.toFixed(2))}%` };
    }
  } else {
    const profit = Number(orderProfit);
    if (profit > 0 && amountTotal < 0) return { ok: false, error: "该单为盈利单，分润金额不能为负数" };
    if (profit < 0 && amountTotal > 0) return { ok: false, error: "该单为亏损单，分润金额必须填负数（亏损分担额）" };
    if (profit === 0) return { ok: false, error: "该单利润为 0，按金额分润只能填 0，请改用比例" };
    if (Math.abs(amountTotal) > Math.abs(profit)) {
      return { ok: false, error: `分润金额合计不能超过订单总利润 ${money(orderProfit)}` };
    }
  }
  return { ok: true, items: expanded.map((row) => ({
    user_id: row.kind === "COMPANY" || row.employee == null || row.employee === "COMPANY" ? null : Number(row.employee),
    role: row.role || ALLOCATION_TYPE_ROLE[row.kind],
    allocation_type: row.kind,
    allocation_rate: useRate ? String(row.rate) : "0",
    allocation_amount: useRate ? "0" : String(row.amount),
  })) };
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
