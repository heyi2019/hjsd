import type { Order } from "../../shared/api/types/orders";
import { money } from "../../shared/lib/format";
import { compareMoney } from "../../shared/lib/money";

export async function resolveCancellationOperators(
  selected: number[] | undefined,
  employees: Array<{ id: number; username: string }>,
  currentOperator: string | undefined,
  getCurrentUser: () => Promise<{ id: number; username: string }>,
): Promise<number[] | undefined> {
  if (selected?.length) return selected;
  const employee = employees.find((item) => item.username === currentOperator)
    ?? (employees.length === 1 ? employees[0] : undefined);
  if (employee) return [employee.id];
  if (!employees.length) return undefined;
  try {
    const current = await getCurrentUser();
    const match = employees.find((item) => item.id === current.id || item.username === current.username);
    return match ? [match.id] : undefined;
  } catch {
    // 无法取得当前人员时交给后端校验。
    return undefined;
  }
}

export type BusinessFilterKey = "all" | "HS" | "TH" | "DG";
export type BusinessModeFilterKey = "all" | "SELF" | "DISTRIBUTION";

export const BUSINESS_CREATE_ITEMS = [
  { key: "HS", label: "新建回收订单" },
  { key: "TH", label: "新建提号订单" },
  { key: "DG", label: "新建代挂订单" },
];

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
 * 规则：留空 → 全额（取剩余可冲金额）；必须为正数；不得超过剩余。
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
  const positive = compareMoney(amount, "0");
  const comparison = compareMoney(amount, remaining);
  if (positive === null || positive <= 0 || comparison === null) {
    return { ok: false, error: "请输入有效的冲销金额" };
  }
  if (comparison > 0) {
    return { ok: false, error: `冲销金额不能超过该动作剩余可冲金额 ¥${remaining}` };
  }
  return { ok: true, amount };
}

export function formatOrderAmount(order: Order): string {
  return order.sale_amount ? `¥${money(order.sale_amount)}` : "-";
}
