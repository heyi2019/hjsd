/** 全部 v1 接口：路径与 docs/ERP_API接口规范_v1.0.md 一致。
 * 金额一律以字符串传输，前端不做浮点数计算。 */
import { api } from "./client";

export interface Pool {
  id: number;
  code: string;
  name: string;
  pool_type: string;
  ownership: string;
  status: string;
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

export interface OrderType {
  id: number;
  code: string;
  name: string;
  capital_type: string;
  is_active: boolean;
  description?: string | null;
  sort_order?: number;
}

/** 业务 → 资金池路由（get_order_type routes）。份额可选集必须由它决定：
 *  HS/TH/DFQ 只配 本金/利润，DG 只配 利润/总额——写死选项必然撞 POOL_ROUTE_MISSING。 */
export interface OrderTypeRoute {
  id: number;
  order_type_code: string;
  portion: string;
  pool_code: string;
  pool_name: string;
  priority: number;
  is_active: boolean;
}

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
  contact_masked?: boolean;
  merged_into_id?: number | null;
  /** 活字段值：field_key → 值，由设置页字段定义驱动（BAS-04） */
  extra_values?: Record<string, unknown> | null;
}

export interface CustomerOverview {
  order_count: number;
  active_order_count: number;
  completed_order_count: number;
  cancelled_order_count: number;
  last_trade_date?: string | null;
  installment_paid_total: string;
  installment_receivable_total: string;
  installment_remaining_total: string;
  overdue_period_count: number;
}

export interface CustomerBusiness {
  order_id: number;
  order_no: string;
  order_type: string;
  capital_type: string;
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
  extra_values?: Record<string, unknown>;
}

export interface Order {
  id: number;
  order_no: string;
  order_type: string;
  capital_type: string;
  business_mode?: string | null;
  business_type?: string | null;
  value_added_service?: string | null;
  trade_date: string;
  account_id?: number | null;
  status: string;
  note?: string | null;
  account_game_type?: string | null;
  account_game_account?: string | null;
  account_channel_region?: string | null;
  account_business_mode?: string | null;
  account_platform?: string | null;
  account_status?: string | null;
  party_name?: string | null;
  party_role?: string | null;
  party_source?: string | null;
  party_created_by?: string | null;
  party_created_at?: string | null;
  event_total?: string | null;
  last_event_type?: string | null;
  last_event_amount?: string | null;
  last_event_on?: string | null;
  installment_principal?: string | null;
  installment_paid?: string | null;
  installment_periods?: number | null;
  installment_status?: string | null;
  events?: OrderEvent[];
}

export interface OrderEvent {
  id: number;
  event_no: string;
  order_id: number;
  event_type: string;
  amount: string;
  occurred_on: string;
  pool_id?: number | null;
  delivery_mode?: string | null;
  is_posted: boolean;
  operator?: string;
}

export interface EventPostResult {
  event: OrderEvent;
  cashflow_no: string | null;
}

export interface Account {
  id: number;
  source_order_no?: string | null;
  game_type?: string | null;
  business_mode?: string | null;
  inventory_type?: string | null;
  game_account?: string | null;
  game_password?: string | null;
  channel_region?: string | null;
  bound_phone?: string | null;
  has_secondary?: boolean | null;
  account_description?: string | null;
  account_images?: string[] | null;
  extra_values?: Record<string, unknown>;
  note?: string | null;
  platform?: string | null;
  status: string;
  cost_amount: string;
  buy_date?: string | null;
  created_by: string;
  created_at?: string | null;
}

export interface AccountInventoryRow {
  account_id: number;
  game_account?: string | null;
  business_mode?: string | null;
  inventory_type?: string | null;
  platform?: string | null;
  status: string;
  cost_amount: string;
  account_description?: string | null;
  account_images?: string[];
  extra_values?: Record<string, unknown>;
}

export interface AccountExecutionCashflow {
  flow_no: string;
  pool_name?: string | null;
  occurred_on: string;
  occurred_at?: string | null;
  direction: string;
  nature: string;
  category: string;
  amount: string;
  note?: string | null;
  operator: string;
}

export interface AccountExecutionEvent {
  id: number;
  event_no: string;
  event_type: string;
  amount: string;
  occurred_on: string;
  occurred_at?: string | null;
  offset_event_id?: number | null;
  portion: string;
  delivery_mode?: string | null;
  is_posted: boolean;
  note?: string | null;
  cashflow?: AccountExecutionCashflow | null;
  operator: string;
  operator_user_ids?: number[] | null;
  operator_names?: string[];
}

export interface AccountExecutionCounterparty {
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
  base_amount: string;
  status: string;
  collected_on: string;
  collected_at?: string | null;
  settlements?: AccountExecutionRebateSettlement[];
}

export interface AccountExecutionRebateSettlement {
  id: number;
  settlement_no: string;
  settled_on: string;
  settled_at: string;
  gross_amount: string;
  platform_fee: string;
  net_amount: string;
  cashflow_id?: number | null;
  reversal_of_id?: number | null;
  note?: string | null;
  operator: string;
}

export interface AccountExecutionOrder {
  order_id: number;
  order_no: string;
  order_type: string;
  trade_date: string;
  created_at?: string | null;
  status: string;
  note?: string | null;
  extra_values?: Record<string, unknown>;
  cashflows?: AccountExecutionCashflow[];
  counterparties?: AccountExecutionCounterparty[];
  rebates?: AccountExecutionRebate[];
  events: AccountExecutionEvent[];
  operator: string;
}

export interface AccountExecutionDetail {
  account: Account;
  orders: AccountExecutionOrder[];
}

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
  status: string;
  delivery_mode?: string | null;
  delivered_on?: string | null;
  note?: string | null;
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
  due_amount: string;
  received_amount: string;
  status: string;
}

export interface Deposit {
  id: number;
  pool_id: number;
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
}

export interface Cashflow {
  status: string;
  id: number;
  flow_no: string;
  pool_id: number;
  occurred_on: string;
  nature: string;
  category: string;
  direction: "IN" | "OUT" | string;
  amount: string;
  order_id?: number | null;
  order_no?: string | null;
  deposit_id?: number | null;
  order_event_id?: number | null;
  transfer_id?: string | null;
  source: string;
  note?: string | null;
}

export interface Rebate {
  id: number;
  rebate_no: string;
  source_order_id?: number | null;
  rebate_type: "BUY" | "SELL" | "UNSPECIFIED" | string;
  rate: string;
  base_amount: string;
  status: string;
  collected_on: string;
}

export interface Settlement {
  id: number;
  settlement_no: string;
  rebate_record_id: number;
  gross_amount: string;
  platform_fee: string;
  net_amount: string;
  settled_on: string;
}

export interface FieldDefinition {
  id: number;
  entity_type: string;
  field_key: string;
  label: string;
  field_type: string;
  required: boolean;
  sort_order: number;
  is_active: boolean;
  /** SELECT / MULTI_SELECT 的选项集 */
  options?: string[] | null;
}

export interface GameTypeOption {
  id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
  is_default: boolean;
}

export const poolsApi = {
  update: (id: number, data: Partial<Pool>) => api.patch<Pool>(`/pools/${id}`, data).then(r => r.data),
  setStatus: (id: number, status: string) => api.patch<Pool>(`/pools/${id}/status`, {status}).then(r => r.data),
  list: () => api.get<Pool[]>("/pools").then((r) => r.data),
  create: (payload: Partial<Pool>) => api.post<Pool>("/pools", payload).then((r) => r.data),
  balance: (poolId: number) =>
    api.get<PoolBalance>(`/pools/${poolId}/balance`).then((r) => r.data),
};

export const orderTypesApi = {
  update: (id: number, data: Partial<OrderType>) => api.patch<OrderType>(`/order-types/${id}`, data).then(r => r.data),
  setActive: (id: number, is_active: boolean) => api.patch<OrderType>(`/order-types/${id}/active`, {is_active}).then(r => r.data),
  impactPreview: (code: string, portion: string, pool_code: string) => api.get<RouteImpactPreview>(`/order-types/${code}/routes/impact-preview`, {params: {portion, pool_code}}).then(r => r.data),
  list: () => api.get<OrderType[]>("/order-types").then((r) => r.data),
  create: (payload: Partial<OrderType>) =>
    api.post<OrderType>("/order-types", payload).then((r) => r.data),
  routes: (orderTypeId: number) =>
    api.get<OrderTypeRoute[]>(`/order-types/${orderTypeId}/routes`).then((r) => r.data),
};

export const gameTypesApi = {
  list: (params?: { include_inactive?: boolean }) =>
    api.get<GameTypeOption[]>("/game-types", { params }).then((r) => r.data),
  create: (payload: { name: string; sort_order?: number; is_default?: boolean }) =>
    api.post<GameTypeOption>("/game-types", payload).then((r) => r.data),
  update: (id: number, payload: { name?: string; sort_order?: number }) =>
    api.patch<GameTypeOption>(`/game-types/${id}`, payload).then((r) => r.data),
  setActive: (id: number, active: boolean) =>
    api.patch<GameTypeOption>(`/game-types/${id}/active?active=${active}`).then((r) => r.data),
  setDefault: (id: number, isDefault: boolean) =>
    api.patch<GameTypeOption>(`/game-types/${id}/default?is_default=${isDefault}`).then((r) => r.data),
};

export const customersApi = {
  list: (params?: { keyword?: string; status?: string }) =>
    api.get<Customer[]>("/customers", { params }).then((r) => r.data),
  create: (payload: Partial<Customer>) =>
    api.post<{ customer: Customer; duplicate_candidates: unknown[] }>(
      "/customers",
      payload,
    ).then((r) => r.data),
  get: (id: number, reveal = false) =>
    api.get<Customer>(`/customers/${id}`, { params: { reveal } }).then((r) => r.data),
  detail: (id: number, reveal = false) =>
    api.get<CustomerDetail>(`/customers/${id}/detail`, { params: { reveal } }).then((r) => r.data),
  patch: (id: number, payload: Partial<Customer>) =>
    api.patch<Customer>(`/customers/${id}`, payload).then((r) => r.data),
  setStatus: (id: number, status: string) =>
    api.patch<Customer>(`/customers/${id}/status`, { status }).then((r) => r.data),
  merge: (id: number, target_customer_id: number, reason: string) =>
    api.post<Customer>(`/customers/${id}/merge`, { target_customer_id, reason }).then((r) => r.data),
};

export const counterpartiesApi = {
  list: (params?: { type?: string; status?: string }) =>
    api.get<Counterparty[]>("/counterparties", { params }).then((r) => r.data),
  create: (payload: Partial<Counterparty>) =>
    api.post<Counterparty>("/counterparties", payload).then((r) => r.data),
  get: (id: number) => api.get<Counterparty>(`/counterparties/${id}`).then((r) => r.data),
  patch: (id: number, payload: Partial<Counterparty>) =>
    api.patch<Counterparty>(`/counterparties/${id}`, payload).then((r) => r.data),
  setStatus: (id: number, active: boolean) =>
    api.patch<Counterparty>(`/counterparties/${id}/status`, { active }).then((r) => r.data),
};

export const ordersApi = {
  list: (params?: { order_type?: string; status?: string }) =>
    api.get<Order[]>("/orders", { params }).then((r) => r.data),
  get: (orderId: number) =>
    api.get<Order>(`/orders/${orderId}`).then((r) => r.data),
  create: (payload: {
    order_type: string;
    trade_date: string;
    account_snapshot?: {
      game_account: string;
      game_type?: string;
      game_password?: string;
      channel_region?: string;
      bound_phone?: string;
      has_secondary?: boolean;
      purchase_price?: string;
      note?: string;
    };
    account_id?: number;
    owner_id?: number;
    capital_type?: string;
    game_type?: string;
    game_account?: string;
    game_password?: string;
    channel_region?: string;
    bound_phone?: string;
    has_secondary?: boolean;
    account_note?: string;
    note?: string;
    customer_roles?: { customer_id: number; role: string }[];
    counterparty_roles?: { counterparty_id: number; role: string }[];
    initial_buy?: {
      amount: string;
      occurred_on: string;
      pool_id?: number;
      portion?: string;
      note?: string;
    };
    installment?: {
      contract_type: string;
      principal: string;
      down_payment: string;
      service_fee: string;
      periods: number;
      per_period_service_fee: string;
      per_period: string;
      first_due_on: string;
      delivery_mode?: string;
      note?: string;
      schedule?: { period_no: number; due_on: string }[];
    };
  }) => api.post<Order>("/orders", payload).then((r) => r.data),
  postEvent: (
    orderId: number,
    payload: {
      event_type: string;
      amount?: string;
      occurred_on: string;
      pool_id?: number;
      portion?: string;
      delivery_mode?: string;
      offset_event_id?: number;
      reason?: string;
      refund_responsibility?: "COMPANY" | "CUSTOMER" | "CONSIGNOR" | "PLATFORM" | "OTHER";
      flow_category?: string;
      note?: string;
    },
  ) => api.post<EventPostResult>(`/orders/${orderId}/events`, payload).then((r) => r.data),
};

export interface EmployeeOption { id: number; username: string; display_name: string; is_active: boolean }
export const employeesApi = {
  list: () => api.get<EmployeeOption[]>("/users").then((r) => r.data),
};

export const accountsApi = {
  list: (params?: { status?: string }) =>
    api.get<Account[]>("/accounts", { params }).then((r) => r.data),
  updateProfile: (id: number, payload: Partial<Pick<Account, "game_account" | "game_type" | "game_password" | "channel_region" | "bound_phone" | "has_secondary" | "platform" | "note" | "account_description" | "account_images">>) =>
    api.patch<Account>(`/accounts/${id}`, payload).then((r) => r.data),
  inventory: () =>
    api
      .get<{ items: AccountInventoryRow[]; count: number; total_cost: string }>("/accounts/inventory")
      .then((r) => r.data),
  executionDetail: (id: number) =>
    api.get<AccountExecutionDetail>(`/accounts/${id}/execution-detail`).then((r) => r.data),
  updateExecution: (id: number, payload: { profile: Partial<Account>; events: { id: number; expected_amount: string; amount: string; note: string | null; operator_user_ids?: number[] }[] }) =>
    api.patch<{ ok: boolean }>(`/accounts/${id}/execution-edit`, payload).then((r) => r.data),
};

export const installmentsApi = {
  dispositions: (id: number) => api.get<InstallmentDisposition[]>(`/installments/${id}/dispositions`).then(r => r.data),
  recover: (id: number, data: {occurred_on: string; note: string}) => api.post<InstallmentDisposition>(`/installments/${id}/recover`, data).then(r => r.data),
  sale: (id: number, data: {sale_order_id: number; occurred_on: string; note: string}) => api.post<InstallmentDisposition>(`/installments/${id}/resale`, {resale_order_id: data.sale_order_id, occurred_on: data.occurred_on, note: data.note}).then(r => r.data),
  resale: (id: number, data: {resale_order_id: number; occurred_on: string; note: string}) => api.post<InstallmentDisposition>(`/installments/${id}/resale`, data).then(r => r.data),
  list: (params?: { status?: string; order_id?: number }) =>
    api.get<Installment[]>("/installments", { params }).then((r) => r.data),
  create: (payload: Partial<Installment> & { first_due_on: string; schedule?: InstallmentScheduleInput[] }) =>
    api.post<Installment>("/installments", payload).then((r) => r.data),
  schedules: (id: number) =>
    api.get<Schedule[]>(`/installments/${id}/schedules`).then((r) => r.data),
  pay: (
    id: number,
    payload: { amount: string; paid_on: string; period_no?: number; note?: string },
  ) =>
    api
      .post<{ installment: Installment; schedule: Schedule }>(
        `/installments/${id}/payments`,
        payload,
      )
      .then((r) => r.data),
  cancel: (id: number, payload: { cancelled_on: string; reason: string }) =>
    api.post<InstallmentCancelResult>(`/installments/${id}/cancel`, payload).then((r) => r.data),
  deliver: (id: number, payload: { delivery_mode: string; delivered_on: string; note: string }) =>
    api.post<Installment>(`/installments/${id}/deliver`, payload).then((r) => r.data),
};

export const depositsApi = {
  list: (params?: { pool_id?: number }) =>
    api.get<Deposit[]>("/deposits", { params }).then((r) => r.data),
  create: (payload: Partial<Deposit> & { pool_id: number; amount: string; paid_on: string }) =>
    api.post<Deposit>("/deposits", payload).then((r) => r.data),
  release: (id: number, payload: { amount: string; released_on: string }) =>
    api.post<Deposit>(`/deposits/${id}/returns`, payload).then((r) => r.data),
};

export const cashflowsApi = {
  create: (data: Record<string, unknown>) => api.post<Cashflow>("/cashflows", data).then(r => r.data),
  approve: (id: number) => api.post<Cashflow>(`/cashflows/${id}/approve`).then(r => r.data),
  reject: (id: number, reason: string) => api.post<Cashflow>(`/cashflows/${id}/reject`, {reason}).then(r => r.data),
  reverse: (id: number, data: {reversed_on: string; reason: string}) => api.post<Cashflow>(`/cashflows/${id}/reverse`, data).then(r => r.data),
  list: (params?: {
    pool_id?: number;
    order_id?: number;
    direction?: string;
    occurred_from?: string;
    occurred_to?: string;
    limit?: number;
    offset?: number;
  }) => api.get<Cashflow[]>("/cashflows", { params }).then((r) => r.data),
};

export const rebatesApi = {
  list: (params?: { source_order_id?: number }) =>
    api.get<Rebate[]>("/rebates", { params }).then((r) => r.data),
  create: (payload: Partial<Rebate> & {
    source_order_id: number;
    rebate_type: "BUY" | "SELL";
    base_amount: string;
    collected_on: string;
    channel?: string;
    note?: string;
  }) =>
    api.post<Rebate>("/rebates", payload).then((r) => r.data),
  settle: (
    id: number,
    payload: { gross_amount: string; settled_on: string; pool_id: number; platform_fee?: string },
  ) => api.post<Settlement>(`/rebates/${id}/settlements`, payload).then((r) => r.data),
};

export const fieldsApi = {
  list: (params?: { entity_type?: string }) =>
    api.get<FieldDefinition[]>("/field-definitions", { params }).then((r) => r.data),
  create: (payload: Partial<FieldDefinition>) =>
    api.post<FieldDefinition>("/field-definitions", payload).then((r) => r.data),
  update: (id: number, payload: Partial<FieldDefinition>) =>
    api.patch<FieldDefinition>(`/field-definitions/${id}`, payload).then((r) => r.data),
  setActive: (id: number, active: boolean) =>
    api.patch<FieldDefinition>(`/field-definitions/${id}/active?active=${active}`).then((r) => r.data),
  /** 删除字段定义：有历史值返回 409，只能停用（BAS-04-03） */
  remove: (id: number) => api.delete(`/field-definitions/${id}`),
};

/* ── M4：报表 / 审计 ─────────────────────────────── */

export interface InventoryHealthRow {
  account_id: number;
  game_account?: string | null;
  platform?: string | null;
  business?: string | null;
  status: string;
  buy_amount: string;
  expected_price?: string | null;
  expected_profit?: string | null;
  extra_cost: string;
  total_cost: string;
  holding_days?: number | null;
  owner_id?: number | null;
}

export interface InventoryHealthReport {
  generated_on: string;
  total_cost: string;
  items: InventoryHealthRow[];
}

export interface MonthlyPnlRow {
  month: string;
  sales_income: string;
  account_direct_cost: string;
  operating_expense: string;
  rebate_income: string;
  operating_profit: string;
}

export interface MonthlyPnlReport {
  from?: string | null;
  to?: string | null;
  total: Omit<MonthlyPnlRow, "month">;
  items: MonthlyPnlRow[];
}

export interface CommissionRow {
  user_id: number;
  order_id: number;
  order_no: string;
  profit_base: string;
  rate: string;
  payable: string;
  paid: string;
  difference: string;
}

export interface CommissionGroup {
  user_id: number;
  order_count: number;
  profit_base: string;
  payable: string;
  paid: string;
  difference: string;
  orders: CommissionRow[];
}

export interface CommissionReport {
  total: { order_count: number; payable: string; paid: string; difference: string };
  items: CommissionRow[];
  groups?: CommissionGroup[];
}

export interface BusinessPnlRow {
  business_mode?: string | null;
  business_type?: string | null;
  order_type: string;
  order_count?: number;
  main_income: string;
  main_cost: string;
  main_profit: string;
  settled_rebate: string;
  uncollected_rebate: string;
  full_income: string;
}

export interface BusinessPnlReport {
  total: Omit<BusinessPnlRow, "order_type">;
  items: BusinessPnlRow[];
}

export interface DailyFundsRow {
  pool_code: string;
  pool_name: string;
  opening: string;
  income: string;
  expense: string;
  deposit_paid: string;
  deposit_held: string;
  cash_balance: string;
  available: string;
}

export interface DailyFundsReport {
  date: string;
  total: Omit<DailyFundsRow, "pool_code" | "pool_name">;
  items: DailyFundsRow[];
}

export interface OrderProfitRow {
  order_id: number;
  order_no: string;
  order_type: string;
  trade_date: string;
  status: string;
  income: string;
  direct_cost: string;
  rebate: string;
  net_profit: string;
}

export interface OrderProfitReport {
  from?: string | null;
  to?: string | null;
  total: { income: string; buy_amount?: string; direct_cost: string; rebate: string; net_profit: string };
  items: OrderProfitRow[];
}

export const reportsApi = {
  financeDimensions: (params?: {from?: string; to?: string}) => api.get<FinanceDimensionReport>("/reports/finance-dimensions", {params}).then(r => r.data),
  exportCsv: (name: string, params?: {from?: string; to?: string}) => api.get<Blob>(`/reports/${name}/export.csv`, {params, responseType: "blob"}).then(r => r.data),
  inventoryHealth: () => api.get<InventoryHealthReport>("/reports/inventory-health").then((r) => r.data),
  monthlyPnl: (params?: { from?: string; to?: string }) =>
    api.get<MonthlyPnlReport>("/reports/monthly-pnl", { params }).then((r) => r.data),
  commission: (params?: { from?: string; to?: string }) =>
    api.get<CommissionReport>("/reports/commission", { params }).then((r) => r.data),
  businessPnl: (params?: { from?: string; to?: string }) =>
    api.get<BusinessPnlReport>("/reports/business-pnl", { params }).then((r) => r.data),
  dailyFunds: (params?: { on?: string }) =>
    api.get<DailyFundsReport>("/reports/daily-funds", { params }).then((r) => r.data),
  orderProfit: (params?: { from?: string; to?: string }) =>
    api.get<OrderProfitReport>("/reports/order-profit", { params }).then((r) => r.data),
};

export interface AuditLogRow {
  id: number;
  actor?: string | null;
  action?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  occurred_at?: string | null;
}

export const auditApi = {
  list: (params?: { entity_type?: string; entity_id?: string; limit?: number; offset?: number }) =>
    api.get<{ items: AuditLogRow[]; total: number }>("/audit-logs", { params }).then((r) => r.data),
  actions: () => api.get<{ items: string[] }>("/audit-logs/actions").then((r) => r.data.items),
};

/* ── M4 补齐：标准导入（MIG-01）──────────────────────────────
 * 红线：只落原始行 + 人工映射，系统绝不自动匹配、绝不补造单边划转。 */

export interface ImportBatch {
  id: number;
  batch_no: string;
  source_name: string;
  source_kind: string;
  status: string;
  row_count: number;
  unmapped_count: number;
  committed_at?: string | null;
  rolled_back_at?: string | null;
  rolled_back_by?: string | null;
  rollback_reason?: string | null;
  corrects_batch_id?: number | null;
  note?: string | null;
}

export interface ImportRow {
  id: number;
  batch_id: number;
  row_no: number;
  raw: Record<string, unknown>;
  mapped_order_id?: number | null;
  mapped_account_id?: number | null;
  mapped_by?: string | null;
  mapped_at?: string | null;
  mapping_basis?: string | null;
  mapped_before?: Record<string, unknown> | null;
  status: string;
  unlinked_transfer: boolean;
  issue_note?: string | null;
}

export interface MappingPreviewColumn {
  source_column: string;
  target_field?: string | null;
  suggested: boolean;
  present_count: number;
  filled_count: number;
  fill_rate: number;
  samples: string[];
}

export interface MappingPreview {
  batch_id: number;
  batch_no: string;
  source_name: string;
  total_rows: number;
  columns: MappingPreviewColumn[];
  abnormal: { empty_value: number; unmapped: number; missing_core_columns?: string[] };
  blockers: string[];
}

export interface ReconciliationReport {
  batch_id: number;
  batch_no: string;
  source_name: string;
  status: string;
  generated_at: string;
  rows: {
    source_total: number;
    imported: number;
    mapped_not_imported: number;
    unmapped: number;
    skipped: number;
    unlinked_transfer: number;
    unaccounted: number;
  };
  amounts: {
    before: Record<string, string>;
    after: Record<string, string>;
    delta: Record<string, string>;
  };
  funds: { cashflow_written: number; linked_event_cashflow: number; note: string };
  requires_adjudication: boolean;
}

export const importsApi = {
  batches: () => api.get<{ items: ImportBatch[]; total: number }>("/imports/batches").then((r) => r.data),
  createBatch: (payload: { source_name: string; rows: Record<string, unknown>[]; source_kind?: string; note?: string }) =>
    api.post<ImportBatch>("/imports/batches", payload).then((r) => r.data),
  rows: (batchId: number, status?: string) =>
    api.get<{ items: ImportRow[]; total: number }>(`/imports/batches/${batchId}/rows`, { params: { status } }).then((r) => r.data),
  preview: (batchId: number) =>
    api.get<MappingPreview>(`/imports/batches/${batchId}/preview`).then((r) => r.data),
  reconciliation: (batchId: number) =>
    api.get<ReconciliationReport>(`/imports/batches/${batchId}/reconciliation`).then((r) => r.data),
  /** basis 必填：补录关联必须有依据（MIG-01-05） */
  map: (rowId: number, payload: { order_id?: number | null; account_id?: number | null; basis: string }) =>
    api.post<ImportRow>(`/imports/rows/${rowId}/map`, payload).then((r) => r.data),
  skip: (rowId: number, reason: string) =>
    api.post<ImportRow>(`/imports/rows/${rowId}/skip`, { reason }).then((r) => r.data),
  /** 只打标记 + 开工单，服务端绝不补造配对流水 */
  markUnlinked: (rowId: number, note?: string) =>
    api.post<ImportRow>(`/imports/rows/${rowId}/unlinked-transfer`, { note }).then((r) => r.data),
  commit: (batchId: number) =>
    api.post<ImportBatch & { imported: number; unmapped: number }>(`/imports/batches/${batchId}/commit`).then((r) => r.data),
  rollback: (batchId: number, reason: string) =>
    api.post<ImportBatch>(`/imports/batches/${batchId}/rollback`, { reason }).then((r) => r.data),
  createCorrection: (batchId: number, payload: { rows: Record<string, unknown>[]; reason: string }) =>
    api.post<ImportBatch>(`/imports/batches/${batchId}/corrections`, payload).then((r) => r.data),
};

/* ── M5：经营规则与订单利润分配（T19 / T20，BAS-06-01~04）───────── */

export interface PolicyDefinition {
  id: number;
  policy_code: string;
  name: string;
  scope_type: string;
  scope_id?: number | null;
  description?: string | null;
  status: string;
  created_at?: string | null;
}

export interface PolicyVersion {
  id: number;
  policy_definition_id: number;
  version: number;
  effective_from: string;
  effective_to?: string | null;
  config: Record<string, unknown>;
  status: string;
  approved_by?: string | null;
  approved_at?: string | null;
  note?: string | null;
}

export interface ProfitAllocation {
  id: number;
  order_id: number;
  user_id?: number | null;
  role: string;
  allocation_type?: "BUY" | "SELL" | "OPERATION" | "COMPANY" | null;
  allocation_rate: string;
  policy_version_id?: number | null;
  total_rate?: string;
}

export const policyApi = {
  list: (params?: { status?: string; policy_code?: string }) =>
    api.get<{ items: PolicyDefinition[]; total: number }>("/policies", { params }).then((r) => r.data),
  create: (payload: { policy_code: string; name: string; scope_type: string; scope_id?: number; description?: string }) =>
    api.post<PolicyDefinition>("/policies", payload).then((r) => r.data),
  versions: (definitionId: number, status?: string) =>
    api.get<{ items: PolicyVersion[]; total: number }>(`/policies/${definitionId}/versions`, { params: { status } }).then((r) => r.data),
  createVersion: (definitionId: number, payload: { effective_from: string; effective_to?: string | null; config: Record<string, unknown>; note?: string }) =>
    api.post<PolicyVersion>(`/policies/${definitionId}/versions`, payload).then((r) => r.data),
  updateDraft: (versionId: number, config: Record<string, unknown>) =>
    api.patch<PolicyVersion>(`/policy-versions/${versionId}`, { config }).then((r) => r.data),
  approve: (versionId: number, payload: { approver?: string; note?: string }) =>
    api.post<PolicyVersion>(`/policy-versions/${versionId}/approve`, payload).then((r) => r.data),
  resolve: (policyCode: string, on: string) =>
    api
      .get<{ found: boolean; version: PolicyVersion | null }>("/policy-versions/resolve", {
        params: { policy_code: policyCode, on },
      })
      .then((r) => r.data),
  allocations: (orderId: number) =>
    api.get<{ items: ProfitAllocation[]; total: number }>(`/orders/${orderId}/profit-allocations`).then((r) => r.data),
  setAllocations: (orderId: number, items: { user_id?: number | null; role: string; allocation_type: "BUY" | "SELL" | "OPERATION" | "COMPANY"; allocation_rate: string }[]) =>
    api.put<{ items: ProfitAllocation[]; total: number }>(`/orders/${orderId}/profit-allocations`, { items }).then((r) => r.data),
  orderSnapshot: (orderId: number) =>
    api
      .get<{ found: boolean; snapshot: { policy_version_id?: number | null; policy_snapshot?: Record<string, unknown> | null } | null }>(
        `/orders/${orderId}/policy-snapshot`,
      )
      .then((r) => r.data),
};

export interface RouteImpactPreview { changed: boolean; historical_impact: Record<string, unknown>; future_effect: string }
export interface InstallmentDisposition { id: number; installment_id: number; account_id: number; action: string; occurred_on: string; related_order_id?: number | null; note: string }
export interface FinanceDimensionRow { pool_id: number; pool_code: string; pool_name: string; pool_account_id?: number | null; account_no?: string | null; account_name?: string | null; fund_nature: string; accounting_attribute: string; direction: string; flow_count: number; amount: string; signed_amount: string }
export interface FinanceDimensionReport { items: FinanceDimensionRow[]; total_amount: string; total_signed_amount: string }
export interface Reconciliation { id: number; pool_id: number; pool_account_id?: number | null; reconciled_on: string; account_label: string; system_balance: string; statement_balance: string; difference: string; status: string; reason?: string | null; unmatched_flow_ids?: number[]; note?: string | null }
export interface AttachmentItem { id: number; attachment_no: string; file_name: string; size_bytes: number; created_by: string }
export interface Lead { id: number; lead_no: string; customer_id: number; request_type: string; budget?: string | null; target: string; status: string }
export interface QualityIssue { id: number; issue_no: string; severity: string; title: string; entity_type: string; entity_id: string; status: string; message: string }
export interface QualitySummary { total: number; by_severity: Record<string, number> }
export interface NotificationItem { id: number; notification_no: string; title: string; message: string; entity_type: string; entity_id: string; read_at?: string | null }
export interface SearchResult { id: number; type: string; code: string; title: string; subtitle?: string | null; route: string }
export const transfersApi = { create: (data: Record<string, unknown>) => api.post("/transfers", data).then(r => r.data) };
export const reconciliationsApi = {
  list: () => api.get<Reconciliation[]>("/reconciliations").then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<Reconciliation>("/reconciliations", data).then(r => r.data),
  resolve: (id: number, reason: string) => api.post<Reconciliation>(`/reconciliations/${id}/resolve`, { reason }).then(r => r.data),
};
export const attachmentsApi = {
  list: (entity_type: string, entity_id: string) => api.get<{ items: AttachmentItem[] }>("/attachments", { params: { entity_type, entity_id } }).then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<AttachmentItem>("/attachments", data).then(r => r.data),
  download: (id: number) => api.get<Blob>(`/attachments/${id}/download`, { responseType: "blob" }).then(r => r.data),
  remove: (id: number) => api.delete(`/attachments/${id}`).then(r => r.data),
};
export const leadsApi = {
  list: () => api.get<Lead[]>("/leads").then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<Lead>("/leads", data).then(r => r.data),
  close: (id: number, reason: string) => api.post<Lead>(`/leads/${id}/close`, { reason }).then(r => r.data),
  convert: (id: number, order_id: number) => api.post<Lead>(`/leads/${id}/convert`, { order_id }).then(r => r.data),
};
export const qualityApi = {
  summary: () => api.get<QualitySummary>("/quality/exceptions").then(r => r.data),
  list: () => api.get<{ items: QualityIssue[] }>("/quality/issues").then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<QualityIssue>("/quality/issues", data).then(r => r.data),
  close: (id: number, data: { resolution: string; evidence: string }) => api.post<QualityIssue>(`/quality/issues/${id}/close`, data).then(r => r.data),
  batchClose: (data: { issue_ids: number[]; resolution: string; evidence: string }) => api.post<QualityIssue[]>("/quality/issues/batch-close", data).then(r => r.data),
};
export const notificationsApi = {
  list: (params: { limit: number }) => api.get<{ items: NotificationItem[]; unread_total: number }>("/notifications", { params }).then(r => r.data),
  markRead: (id: number) => api.post<NotificationItem>(`/notifications/${id}/read`).then(r => r.data),
  syncOverdueRebates: () => api.post<{ created: number }>("/notifications/sync-overdue-rebates").then(r => r.data),
};
export const searchApi = { query: (q: string) => api.get<{ items: SearchResult[] }>("/search", { params: { q } }).then(r => r.data) };
