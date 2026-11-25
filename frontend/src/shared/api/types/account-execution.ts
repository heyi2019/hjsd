/** 账号执行详情（订单/事件/往来/返点/财务汇总）。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

import type { Account } from "./accounts";

export interface AccountExecutionCashflow {
  flow_no: string;
  pool_id?: number | null;
  pool_name?: string | null;
  occurred_on: string;
  occurred_at?: string | null;
  direction: string;
  category: string;
  amount: string;
  note?: string | null;
  operator: string;
  operator_user_ids?: number[] | null;
}

export interface AccountExecutionEvent {
  id: number;
  event_no: string;
  event_type: string;
  operation_type?: "IMAGE" | "DESCRIPTION" | "CONSIGNMENT" | "UNLIST" | null;
  rebate_type?: "BUY" | "SELL" | null;
  amount: string;
  /** 仍可被冲销的余额（后端按已冲销合计算好并夹底 0），前端不再自行相减。 */
  cancellable_amount: string;
  occurred_on: string;
  occurred_at?: string | null;
  pool_id?: number | null;
  offset_event_id?: number | null;
  portion: string;
  delivery_direction?: "BUY" | "SELL" | null;
  is_posted: boolean;
  reason?: string | null;
  note?: string | null;
  form_extra?: Record<string, unknown>;
  cashflow?: AccountExecutionCashflow | null;
  cashflows?: AccountExecutionCashflow[];
  operator: string;
  operator_user_ids?: number[] | null;
  operator_names?: string[];
}

export interface AccountExecutionCounterparty {
  id: number;
  display_name: string;
  role: string;
}

export interface AccountExecutionCustomer {
  id: number;
  display_name: string;
  role: string;
}

export interface AccountExecutionRebate {
  id: number;
  rebate_no: string;
  rebate_type: "BUY" | "SELL" | "UNSPECIFIED" | string;
  channel?: string | null;
  rate: string;
  amount: string;
  status: string;
  collected_on: string;
  collected_at?: string | null;
}

export interface AccountExecutionOrder {
  order_id: number;
  order_no: string;
  order_type: string;
  game_type_label?: string | null;
  channel_region_label?: string | null;
  option_label_snapshot?: Record<string, string> | null;
  trade_date: string;
  created_at?: string | null;
  occurred_at?: string | null;
  status: string;
  note?: string | null;
  extra_values?: Record<string, unknown>;
  extra_fields?: Array<{ key: string; label: string; section: string; value: unknown }>;
  cashflows?: AccountExecutionCashflow[];
  customers?: AccountExecutionCustomer[];
  counterparties?: AccountExecutionCounterparty[];
  rebates?: AccountExecutionRebate[];
  events: AccountExecutionEvent[];
  /** 最近售出事件由后端按业务登记顺序确定。 */
  latest_sale_event_id?: number | null;
  /** 已保存的上架状态由服务端统一计算。 */
  active_consignments?: Array<{ event_id: number; platform: string; platform_label?: string | null; price: string | number | null; listed_at: string }>;
  operator: string;
  operator_user_ids?: number[] | null;
}

export interface OrderDetailExecutionRow {
  key: string;
  order_id: number;
  category: "INBOUND" | "OPERATING" | "OUTBOUND";
  action: string;
  occurred_at?: string | null;
  amount?: string | null;
  operator: string;
  note: string;
  platform: string;
  operator_user_ids?: number[] | null;
  event_id?: number | null;
}

export interface OrderDetailFinanceRow {
  key: string;
  flow_no: string;
  type: string;
  direction: string;
  amount: string;
  occurred_at?: string | null;
  pool_id?: number | null;
  pool_name: string;
  note: string;
  operator: string;
  operator_user_ids?: number[] | null;
  event_id?: number | null;
}

export interface OrderDetailOperationRow {
  key: string;
  action: string;
  content: string;
  occurred_at?: string | null;
  operator: string;
  event_id?: number | null;
}

export interface OrderDetailView {
  execution_rows: OrderDetailExecutionRow[];
  finance_rows: OrderDetailFinanceRow[];
  operation_rows: OrderDetailOperationRow[];
  lifecycle: {
    sold_at?: string | null;
    removed_at?: string | null;
    removed_platform: string;
    recovery_platform: string;
    sale_platform: string;
  };
  order_notes: string;
  parties: Array<{ id: number; display_name: string; role: string; entity_type: string }>;
  extras: Array<{ key: string; label: string; value: string; section: string }>;
}

export interface AccountAuditEntry {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string;
  actor: string;
  reason?: string | null;
  occurred_at: string;
}

export interface ExecutionFinanceSummary {
  /** 流入流水合计（不含返点）。 */
  cashflow_income: string;
  /** 返点收入合计。 */
  rebate_income: string;
  /** 总收入 = cashflow_income + rebate_income。 */
  total_income: string;
  /** 流出流水合计。 */
  total_expense: string;
  /** 净额 = total_income − total_expense。 */
  net_amount: string;
}

export interface AccountExecutionDetail {
  image_previews?: boolean;
  image_versions?: Record<string, string[]>;
  account: Account;
  orders: AccountExecutionOrder[];
  /** 账号维度财务汇总：由后端按同一份明细算好下发，前端不再自行累加。 */
  finance_summary: ExecutionFinanceSummary;
  detail_view: OrderDetailView;
  audit?: AccountAuditEntry[];
}
