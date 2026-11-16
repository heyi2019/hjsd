import { orderCashflowsApi } from "../../shared/api/orderCashflows.api";
import { today } from "../../shared/lib/format";
import type { CashflowDisplayItem, CashflowFormValues } from "./types";

type CashflowDisplaySource = Pick<CashflowDisplayItem, "flow_no" | "occurred_on" | "direction" | "amount"> & {
  operator?: string | null;
};

/**
 * 订单台账与库存中心共用的资金明细口径：订单直接流水 + 事件产生的流水，按流水号去重。
 * 金额和方向直接使用后端值，前端只负责展示编排。
 */
export function buildCashflowDisplayItems(
  orderCashflows: readonly CashflowDisplaySource[] = [],
  eventCashflows: readonly (CashflowDisplaySource | null | undefined)[] = [],
): CashflowDisplayItem[] {
  const seen = new Set<string>();
  return [...orderCashflows, ...eventCashflows.flatMap((flow) => flow ? [flow] : [])].filter((flow) => {
    if (seen.has(flow.flow_no)) return false;
    seen.add(flow.flow_no);
    return true;
  });
}

export async function createOrderCashflow(orderId: number, values: CashflowFormValues): Promise<void> {
  const direction = values.direction === "IN" ? "IN" : "OUT";
  const occurredOn = typeof values.occurred_on === "string"
    ? values.occurred_on.slice(0, 10)
    : values.occurred_on?.format("YYYY-MM-DD") ?? today();
  await orderCashflowsApi.create(orderId, {
    pool_id: values.pool_id,
    occurred_on: occurredOn,
    direction,
    nature: direction === "IN" ? "BUSINESS_IN" : "BUSINESS_OUT",
    fund_nature: "BUSINESS",
    accounting_attribute: direction === "IN" ? "SELF_REVENUE" : "OPERATING_EXPENSE",
    // 当前业务只区分收入/支出，后台分类统一落 OTHER；后续需要细分类别时再扩展表单。
    category: "OTHER",
    amount: values.amount,
    note: values.note,
    ...(values.operator_user_ids?.length ? { operator_user_ids: values.operator_user_ids } : {}),
    ...(values.form_extra ? { form_extra: values.form_extra } : {}),
  });
}
