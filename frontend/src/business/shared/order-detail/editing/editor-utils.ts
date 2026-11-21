import type { EmployeeOption } from "../../../../shared/api/types/org";
import type { AccountExecutionDetail, AccountExecutionOrder } from "../../../../shared/api/types/account-execution";
import type { OrderDraft } from "./editor-types";

const SHARED_ORDER_FORM_EXTRA_KEYS = new Set(["bound_phone_owner"]);

/** 新增详情动作行沿用建单口径：默认当前会话对应的在职员工。 */
export function defaultOperatorUserIds(employees: EmployeeOption[], username: string): number[] | undefined {
  const employee = employees.find((item) => item.is_active && item.username === username);
  return employee ? [employee.id] : undefined;
}

/** 把订单详情内的共享交付字段投影到当前详情涉及的全部订单草稿。 */
export function propagateSharedOrderExtra(
  drafts: Record<number, OrderDraft>,
  orderIds: number[],
  changes: Record<string, unknown>,
  originalOrders: Array<Pick<AccountExecutionOrder, "order_id" | "created_at" | "note">> = [],
): Record<number, OrderDraft> {
  const sharedChanges = Object.fromEntries(
    Object.entries(changes).filter(([key]) => SHARED_ORDER_FORM_EXTRA_KEYS.has(key)),
  );
  if (!Object.keys(sharedChanges).length) return drafts;

  const originals = new Map<number, (typeof originalOrders)[number]>();
  for (const order of originalOrders) {
    const id = order.order_id;
    if (!Number.isNaN(id) && !originals.has(id)) originals.set(id, order);
  }
  const next = { ...drafts };
  orderIds.forEach((orderId) => {
    const original = originals.get(orderId);
    const current = next[orderId] ?? {
      order_id: orderId,
      occurred_at: original?.created_at ?? "",
      note: original?.note ?? "",
      form_extra: {},
    };
    next[orderId] = {
      ...current,
      form_extra: { ...current.form_extra, ...sharedChanges },
    };
  });
  return next;
}

/** 解析共享字段需要同步的订单，避免在 React 状态更新回调里读取详情缓存。 */
export function sharedOrderIdsForEdit(
  detail: Pick<AccountExecutionDetail, "orders"> | undefined,
  fallbackOrderId: number,
): number[] {
  return detail?.orders.map((order) => order.order_id) ?? [fallbackOrderId];
}
