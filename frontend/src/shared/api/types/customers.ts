/** 客户档案、客户详情聚合、合作方与需求线索。
 * 按领域拆分的独立类型模块；从本文件路径直接导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface Customer {
  id: number;
  customer_no: string;
  display_name: string;
  contact_name?: string | null;
  phone?: string | null;
  wechat?: string | null;
  qq?: string | null;
  source?: string | null;
  note?: string | null;
  status: string;
  created_at?: string | null;
  created_by?: string | null;
  merged_into_id?: number | null;
  /** 表单扩展字段值：field_key → 值，由统一字段配置驱动（BAS-04） */
  extra_values?: Record<string, unknown> | null;
}

export interface CustomerSummary {
  month_count: number;
  today_count: number;
}

export interface LeadSummary {
  total_count: number;
  open_count: number;
}

/** POST /customers 建档时后端用明文联系方式精确判重返回的候选（只提示不拦截）。 */
export interface DuplicateCandidate {
  customer_id: number;
  customer_no: string;
  display_name: string;
  matched_on: string[];
}

export interface CustomerOverview {
  order_count: number;
  active_order_count: number;
  completed_order_count: number;
  cancelled_order_count: number;
  last_trade_date?: string | null;
  cumulative_profit: string;
  installment_paid_total: string;
  installment_receivable_total: string;
  installment_remaining_total: string;
  overdue_period_count: number;
}

export interface CustomerBusiness {
  order_id: number;
  order_no: string;
  order_type: string;
  status: string;
  trade_date: string;
  owner_id?: number | null;
  roles: string[];
}

export interface CustomerInstallment {
  id: number;
  inst_no: string;
  order_id: number;
  order_no?: string | null;
  contract_type: string;
  status: string;
  principal: string;
  total_receivable: string;
  paid_amount: string;
  remaining_amount: string;
  overdue_periods: number;
  first_due_on?: string | null;
}

export interface CustomerDetail {
  customer: Customer;
  overview: CustomerOverview;
  business: CustomerBusiness[];
  installments: CustomerInstallment[];
  audit: Array<{
    id: number;
    action: string;
    entity_type: string;
    entity_id: string;
    actor: string;
    reason?: string | null;
    occurred_at: string;
  }>;
}

export interface Counterparty {
  id: number;
  counterparty_no: string;
  display_name: string;
  type: string;
  status: string;
  contact_name?: string | null;
  phone?: string | null;
  wechat?: string | null;
  qq?: string | null;
  source?: string | null;
  note?: string | null;
  created_at?: string;
  created_by?: string | null;
  extra_values?: Record<string, unknown>;
  extra_fields?: Array<{ key: string; label: string; section: string; value: unknown }>;
  overview?: CounterpartyOverview | null;
  orders?: CounterpartyOrder[];
}

export interface CounterpartyOverview {
  order_count: number;
  active_order_count: number;
  completed_order_count: number;
  cumulative_profit: string;
}

export interface CounterpartyOrder {
  order_id: number;
  order_no: string;
  order_type: string;
  status: string;
  trade_date: string;
  roles: string[];
  profit: string;
}

export interface Lead {
  id: number;
  lead_no: string;
  customer_id: number;
  customer_display_name: string;
  request_type: string;
  budget?: string | null;
  target: string;
  status: string;
  created_by?: string | null;
  operation_operators?: Array<{
    operation_key: string;
    operator_user_ids: number[];
    occurred_at: string;
  }>;
}
