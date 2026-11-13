import { cashflowsApi } from "../../shared/api/cashflows.api";
import { today } from "../../shared/lib/format";
import type { CashflowFormValues } from "./types";

export async function createOrderCashflow(orderId: number, values: CashflowFormValues): Promise<void> {
  const direction = values.direction === "IN" ? "IN" : "OUT";
  await cashflowsApi.createForOrder(orderId, {
    pool_id: values.pool_id,
    occurred_on: (values.occurred_on ?? today()).toString().slice(0, 10),
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
