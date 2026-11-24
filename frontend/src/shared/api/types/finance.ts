/** 资金账户、存取、划转、流水、返点、对账与财务维度报表。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface Pool {
  id: number;
  code: string;
  name: string;
  pool_type: string;
  status: string;
  /** 默认资金账户：未显式指定资金账户的流水落这里（全局唯一）。 */
  is_default?: boolean;
  note?: string | null;
}

export interface PoolBalance {
  pool_id: number;
  pool_code: string;
  income: string;
  expense: string;
  transfer_in: string;
  transfer_out: string;
  cash_balance: string;
  deposit_held: string;
  available: string;
}

/** 资金账户余额汇总：由服务端聚合，前端只展示，不再本地累加。 */
export interface PoolBalanceTotals {
  pool_count: number;
  cash_balance: string;
  available: string;
  deposit_held: string;
}

export interface Deposit {
  id: number;
  pool_id: number;
  /** 押金所属账簿：BUSINESS 业务押金 / STUDIO 工作室运营押金。 */
  ledger_type: "BUSINESS" | "STUDIO" | string;
  counterparty_id?: number | null;
  source_order_id?: number | null;
  paid_amount: string;
  returned_amount: string;
  lost_amount?: string;
  status: string;
  paid_on: string;
  expected_release_on?: string | null;
  released_on?: string | null;
  note?: string | null;
  form_extra?: Record<string, unknown> | null;
  /** 押金剩余：实收 − 已退 − 已损失，且不小于 0；后端下发，前端不再相减。 */
  remaining_amount: string;
  /** 后端根据押金状态和已退、已损金额计算的可用业务动作。 */
  available_actions: string[];
  operator?: string | null;
  operation_operators?: DepositOperationOperator[];
  action_history?: DepositAction[];
}

export interface DepositAction {
  flow_no: string;
  action: "HOLD" | "RETURN" | "LOSS" | "CANCEL";
  occurred_on: string;
  amount: string;
  operator_user_ids: number[];
  operator: string;
}

export interface DepositOperationOperator {
  operation_key: string;
  operator_user_ids: number[];
  occurred_at: string;
}

export interface TransferResult {
  transfer_id: string;
  source_pool_id?: number;
  target_pool_id?: number;
  amount?: string;
  occurred_on?: string;
  cashflows?: Cashflow[];
  operation_operators?: DepositOperationOperator[];
}

export interface Cashflow {
  id: number;
  flow_no: string;
  pool_id: number;
  occurred_on: string;
  occurred_at?: string | null;
  ledger_type: "BUSINESS" | "STUDIO" | string;
  accounting_attribute?: string;
  category: string;
  direction: "IN" | "OUT" | string;
  amount: string;
  source_type: string;
  source_id?: string | null;
  is_reversed: boolean;
  order_id?: number | null;
  order_no?: string | null;
  source: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  operator?: string;
  note?: string | null;
  form_extra?: Record<string, unknown> | null;
  operator_user_ids?: number[] | null;
}

export interface Rebate {
  id: number;
  rebate_no: string;
  source_order_id?: number | null;
  rebate_type: "BUY" | "SELL" | "UNSPECIFIED" | string;
  channel?: string | null;
  amount: string;
  status: string;
  collected_on: string;
  note?: string | null;
  created_at?: string;
  operator?: string;
  operator_user_ids?: number[] | null;
  form_extra?: Record<string, unknown> | null;
}

export interface Reconciliation { id: number; pool_id: number; reconciled_on: string; account_label: string; system_balance: string; statement_balance: string; difference: string; status: string; reason?: string | null; note?: string | null; operator?: string | null; operation_operators?: DepositOperationOperator[] }
