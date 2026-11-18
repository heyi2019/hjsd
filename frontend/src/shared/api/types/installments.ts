/** 分期合约、期次排期、取消结果与逾期处置。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface Installment {
  id: number;
  inst_no: string;
  order_id: number;
  contract_type: string;
  principal: string;
  down_payment: string;
  service_fee: string;
  periods: number;
  per_period_service_fee: string;
  per_period: string;
  paid_amount: string;
  bad_debt_amount?: string;
  waived_amount?: string;
  final_period_adjustment?: string;
  /** 总应收：首付 + 每期 × 期数 + 末期调整 − 减免，由后端下发，前端不自行推导。 */
  total_receivable: string;
  /** 剩余应收：总应收 − 已收 − 坏账，且不小于 0；后端下发，前端不再相减。 */
  remaining_receivable: string;
  status: string;
  operator?: string | null;
  delivery_mode?: string | null;
  delivered_on?: string | null;
  note?: string | null;
  order: InstallmentOrderContext;
  schedules: Schedule[];
  dispositions: InstallmentDisposition[];
  operation_operators: InstallmentOperationOperator[];
  /** 后端下发的合约级可用动作（pay/deliver/recover/cancel/settle_early/default/resale）；前端只回显，不自行判定 */
  available_actions: string[];
}

export interface InstallmentOperationOperator {
  operation_key: string;
  operator_user_ids: number[];
  occurred_at: string;
}

export interface InstallmentOrderContext {
  id: number;
  order_no: string;
  order_type: string;
  trade_date: string;
  account_game_type?: string | null;
  account_game_account?: string | null;
  account_business_mode?: string | null;
  party_name?: string | null;
  bound_phone?: string | null;
  bound_phone_owner?: string | null;
}

export interface InstallmentTotals {
  total_receivable: string;
  total_paid: string;
  total_remaining: string;
  total_count: number;
  overdue_count: number;
}

export interface InstallmentCancelResult {
  installment: Installment;
  order_status: string;
  account_status?: string | null;
  refund_amount: string;
  reversed_amount: string;
  cancel_event_ids: number[];
}

export interface InstallmentScheduleInput {
  period_no: number;
  due_on: string;
}

export interface Schedule {
  id: number;
  installment_id: number;
  period_no: number;
  due_on: string;
  service_fee_rate?: string;
  due_amount: string;
  received_amount: string;
  waived_amount?: string;
  status: string;
  /** 后端下发的期次可用动作（waive/extend）；前端只回显 */
  available_actions: string[];
}

export interface InstallmentDisposition { id: number; installment_id: number; account_id: number; action: string; occurred_on: string; related_order_id?: number | null; note: string }
