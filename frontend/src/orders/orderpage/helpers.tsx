import type { Order } from "../../shared/api/catalog";
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
