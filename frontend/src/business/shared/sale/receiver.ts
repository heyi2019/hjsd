/**
 * 库存售出的收款逻辑：全款收款与分期收款两段后端调用。
 * 从售出弹窗抽出，便于复用与单测。
 *
 * - 全款收款：在原入库订单上登记 SELL 事件，金额作为 PROFIT 份额入账（代挂无买入价，利润即售出金额）。
 * - 分期收款：建立库存分期出售合同（STOCK_SALE），买家分期支付。
 */
import { installmentsApi } from "../../../shared/api/installments.api";
import { ordersApi } from "../../../shared/api/orders.api";
import { today } from "../../../shared/lib/format";
import { formExtraOrUndefined } from "../../../shared/lib/formExtra";
import { serializeInstallmentSchedule } from "../forms/InstallmentScheduleFields";
import type { SaleCustomerInput } from "../../../shared/api/orders-api/orders";

interface CollectPaymentInput {
  /** 关联入库订单 ID（售出事件/分期合同登记在其上）。 */
  sourceOrderId: number;
  /** 表单值。 */
  values: Record<string, unknown>;
  /** 是否代挂（CONSIGNMENT）：代挂无买入价，且只走全款。 */
  isConsignment: boolean;
  customerInput?: SaleCustomerInput;
  deliveryFormExtra?: Record<string, unknown>;
  idempotencyKey?: string;
}

/** 全款收款：登记 SELL 事件，金额作为 PROFIT 份额入账。 */
export async function collectFullPayment(input: CollectPaymentInput): Promise<void> {
  const { sourceOrderId, values, isConsignment, customerInput, deliveryFormExtra, idempotencyKey } = input;
  await ordersApi.stockSale(sourceOrderId, {
    amount: values.amount as string,
    occurred_on: today(),
    pool_id: values.pool_id as number,
    operator_user_ids: values.operator_user_ids as number[] | undefined,
    note: values.cashflow_note as string | undefined,
    bound_phone: values.bound_phone as string | undefined,
    bound_phone_owner: values.bound_phone_owner as string | undefined,
    ...(isConsignment && values.sale_amount != null && String(values.sale_amount) !== "" ? { sale_amount: String(values.sale_amount) } : {}),
    customer_input: customerInput,
    delivery_form_extra: deliveryFormExtra,
    form_extra: formExtraOrUndefined(values.form_extra),
  }, idempotencyKey);
}

/** 分期收款：建立库存分期出售合同（STOCK_SALE），并在确立时收首付（期次 0）。 */
export async function collectInstallmentPayment(input: Omit<CollectPaymentInput, "isConsignment">): Promise<void> {
  const { sourceOrderId, values, customerInput, deliveryFormExtra, idempotencyKey } = input;
  const schedule = serializeInstallmentSchedule(
    values.installment_schedule as Array<{ due_on?: unknown }> | undefined,
    (value) => value && typeof value === "object" && "format" in value
      ? (value as { format: (template: string) => string }).format("YYYY-MM-DD")
      : today(),
  );
  const firstDueOn = schedule[0]?.due_on ?? today();
  await installmentsApi.stockSale({
    order_id: sourceOrderId,
    adjust_final_period: true,
    // 提号账号进入库存后，分期售出统一按库存分期出售处理（代挂售出仅全款，不在本表单分期）。
    contract_type: "STOCK_SALE",
    principal: String(values.amount ?? 0),
    down_payment: String(values.down_payment ?? 0),
    service_fee: String(values.service_fee ?? 0),
    periods: Number(values.periods ?? 1),
    per_period_service_fee: String(values.per_period_service_fee ?? 0),
    per_period: String(values.per_period ?? 0),
    first_due_on: firstDueOn,
    paid_on: today(),
    pool_id: values.pool_id as number | undefined,
    schedule,
    note: values.note as string | undefined,
    operator_user_ids: values.operator_user_ids as number[] | undefined,
    customer_input: customerInput,
    delivery_form_extra: deliveryFormExtra,
    form_extra: formExtraOrUndefined(values.form_extra),
  }, idempotencyKey);
}
