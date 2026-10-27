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
  sequence_prefix?: string | null;
}

/** 业务 → 资金池路由（get_order_type routes）。份额可选集必须由它决定：
 *  HS/TH/DFQ 只配 本金/利润，DG 只配 利润/总额——写死选项必然撞 POOL_ROUTE_MISSING。 */
export interface OrderTypeRoute {
  id: number;
  order_type_code: string;
  portion: string;
  fund_nature?: string | null;
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
  links?: OrderLink[];
  cashflows?: OrderCashflow[];
  rebates?: OrderRebate[];
  installment?: OrderInstallment | null;
  installment_schedule?: OrderScheduleRow[];
  audit?: OrderAuditEntry[];
  attachments?: OrderAttachment[];
  /** DFQ 建单时的账号文本快照（无 order.create 权限时 game_password 被后端置空）。 */
  account_snapshot?: {
    game_account: string;
    game_type?: string | null;
    game_password?: string | null;
    channel_region?: string | null;
    bound_phone?: string | null;
    has_secondary?: boolean | null;
    platform?: string | null;
    purchase_price?: string | null;
    note?: string | null;
  } | null;
  /** 关联完整性：NORMAL / ORPHAN / UNLINKED_TRANSFER（后端 orders/schemas.py）。 */
  link_status?: string;
}

/** GET /orders/{id}（OrderDetailOut）返回的关联资金流水。 */
export interface OrderCashflow {
  flow_no: string;
  pool_id: number;
  occurred_on: string;
  nature: string;
  category: string;
  direction: string;
  amount: string;
  status: string;
  order_event_id?: number | null;
  note?: string | null;
  operator: string;
}

/** GET /orders/{id}（OrderDetailOut）返回的关联返点。 */
export interface OrderRebate {
  id: number;
  rebate_no: string;
  rebate_type: string;
  channel?: string | null;
  rate: string;
  base_amount: string;
  link_status: string;
  status: string;
  collected_on: string;
  expected_on?: string | null;
  note?: string | null;
  created_at?: string;
  operator: string;
}

/** GET /orders/{id}（OrderDetailOut）返回的分期合约摘要。 */
export interface OrderInstallment {
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
  waived_amount: string;
  bad_debt_amount: string;
  status: string;
  delivery_mode?: string | null;
  delivered_on?: string | null;
  first_due_on?: string | null;
  note?: string | null;
}

/** GET /orders/{id}（OrderDetailOut）返回的分期期次。 */
export interface OrderScheduleRow {
  id: number;
  installment_id: number;
  period_no: number;
  due_on: string;
  due_amount: string;
  received_amount: string;
  waived_amount: string;
  status: string;
}

/** GET /orders/{id}（OrderDetailOut）返回的审计摘要。 */
export interface OrderAuditEntry {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string;
  actor: string;
  reason?: string | null;
  request_id?: string | null;
  occurred_at: string;
}

/** GET /orders/{id}（OrderDetailOut）返回的附件。 */
export interface OrderAttachment {
  id: number;
  attachment_no: string;
  entity_type: string;
  entity_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  deleted_at?: string | null;
  created_at: string;
}

export interface OrderEvent {
  id: number;
  event_no: string;
  order_id: number;
  event_type: string;
  amount: string;
  occurred_on: string;
  pool_id?: number | null;
  portion?: string;
  delivery_mode?: string | null;
  offset_event_id?: number | null;
  reason?: string | null;
  refund_responsibility?: string | null;
  is_posted: boolean;
  posted_at?: string | null;
  operator?: string;
}

/** 订单上下游关联：拆分口径作为关系快照保存，不改写订单金额。 */
export interface OrderLink {
  id: number;
  source_order_id: number;
  source_order_no: string;
  target_order_id: number;
  target_order_no: string;
  relation_type: string;
  /** 以当前订单视角给出方向：outgoing=本单是来源单，incoming=本单是后续单。 */
  direction: string;
  split_ratio?: string | null;
  split_amount?: string | null;
  note?: string | null;
  created_at?: string;
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
  waived_amount?: string;
  final_period_adjustment?: string;
  /** 总应收：首付 + 每期 × 期数 + 末期调整 − 减免，由后端下发，前端不自行推导。 */
  total_receivable?: string;
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
  service_fee_rate?: string;
  due_amount: string;
  received_amount: string;
  waived_amount?: string;
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

export interface PeriodLock {
  id: number;
  period: string;
  locked_at?: string;
  locked_by: string;
  note?: string | null;
}

export interface TransferResult {
  transfer_id: string;
  source_pool_id?: number;
  target_pool_id?: number;
  amount?: string;
  occurred_on?: string;
  cashflows?: Cashflow[];
}

export interface Cashflow {
  status: string;
  id: number;
  flow_no: string;
  pool_id: number;
  occurred_on: string;
  nature: string;
  fund_nature?: string;
  accounting_attribute?: string;
  category: string;
  direction: "IN" | "OUT" | string;
  amount: string;
  order_id?: number | null;
  order_no?: string | null;
  deposit_id?: number | null;
  order_event_id?: number | null;
  transfer_id?: string | null;
  source: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reversal_of_id?: number | null;
  operator?: string;
  note?: string | null;
}

export interface Rebate {
  id: number;
  rebate_no: string;
  source_order_id?: number | null;
  rebate_type: "BUY" | "SELL" | "UNSPECIFIED" | string;
  channel?: string | null;
  rate: string;
  base_amount: string;
  link_status?: string;
  status: string;
  collected_on: string;
  /** 预计到账日：晚于该日仍未结清即逾期（后端 /rebates/overdue 判定）。 */
  expected_on?: string | null;
  note?: string | null;
  created_at?: string;
  operator?: string;
}

export interface RebateOverdue extends Rebate {
  overdue_days: number;
}

export interface Settlement {
  id: number;
  settlement_no: string;
  rebate_record_id: number;
  gross_amount: string;
  platform_fee: string;
  net_amount: string;
  settled_on: string;
  cashflow_id?: number | null;
  /** 非空表示本笔结算已被冲销（指向原结算）。 */
  reversal_of_id?: number | null;
  note?: string | null;
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
  impactPreview: (code: string, portion: string, pool_code: string, fund_nature?: string) => api.get<RouteImpactPreview>(`/order-types/${code}/routes/impact-preview`, {params: {portion, pool_code, fund_nature}}).then(r => r.data),
  list: () => api.get<OrderType[]>("/order-types").then((r) => r.data),
  create: (payload: Partial<OrderType>) =>
    api.post<OrderType>("/order-types", payload).then((r) => r.data),
  routes: (orderTypeId: number) =>
    api.get<OrderTypeRoute[]>(`/order-types/${orderTypeId}/routes`).then((r) => r.data),
  setRoute: (
    code: string,
    payload: { portion: string; pool_code: string; fund_nature?: string | null; priority?: number },
  ) =>
    api.post<OrderTypeRoute>(`/order-types/${code}/routes`, payload).then((r) => r.data),
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
  links: (orderId: number) =>
    api.get<OrderLink[]>(`/orders/${orderId}/links`).then((r) => r.data),
  createLink: (
    orderId: number,
    payload: {
      related_order_id: number;
      relation_type: "SOURCE" | "FOLLOW_UP";
      split_ratio?: string;
      split_amount?: string;
      note?: string;
      form_extra?: Record<string, unknown>;
    },
  ) => api.post<OrderLink>(`/orders/${orderId}/links`, payload).then((r) => r.data),
  deleteLink: (orderId: number, linkId: number) =>
    api.delete<void>(`/orders/${orderId}/links/${linkId}`).then((r) => r.data),
  cancel: (orderId: number, payload: { reason: string; form_extra?: Record<string, unknown> }) =>
    api.post<Order>(`/orders/${orderId}/cancel`, payload).then((r) => r.data),
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
    /** 佣金口径：仅 DG 代挂单可用，两者必须同时填写或同时留空。 */
    commission_mode?: string;
    commission_payer?: string;
    form_extra?: Record<string, unknown>;
    customer_roles?: { customer_id: number; role: string }[];
    counterparty_roles?: { counterparty_id: number; role: string }[];
    initial_buy?: {
      amount: string;
      occurred_on: string;
      pool_id?: number;
      portion?: string;
      note?: string;
    };
    initial_costs?: {
      amount: string;
      occurred_on: string;
      pool_id?: number;
      portion?: string;
      flow_category?: string;
      note?: string;
    }[];
    installment?: {
      contract_type: string;
      adjust_final_period?: boolean;
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
      form_extra?: Record<string, unknown>;
    },
  ) => api.post<EventPostResult>(`/orders/${orderId}/events`, payload).then((r) => r.data),
  /** 订单编辑（PATCH /orders/{id}）：未传字段保持原值，显式 null 清空可空字段。 */
  patch: (
    orderId: number,
    payload: {
      trade_date?: string;
      form_extra?: Record<string, unknown>;
      note?: string | null;
      account_snapshot?: {
        game_account: string;
        game_type?: string | null;
        game_password?: string | null;
        channel_region?: string | null;
        bound_phone?: string | null;
        has_secondary?: boolean | null;
        platform?: string | null;
        purchase_price?: string | null;
        note?: string | null;
      } | null;
    },
  ) => api.patch<Order>(`/orders/${orderId}`, payload).then((r) => r.data),
};

export interface EmployeeOption { id: number; username: string; display_name: string; is_active: boolean }
export const employeesApi = {
  list: () => api.get<EmployeeOption[]>("/users").then((r) => r.data),
};

export const accountsApi = {
  list: (params?: { status?: string }) =>
    api.get<Account[]>("/accounts", { params }).then((r) => r.data),
  updateProfile: (id: number, payload: Partial<Pick<Account, "game_account" | "game_type" | "game_password" | "channel_region" | "bound_phone" | "has_secondary" | "platform" | "note" | "account_description" | "account_images">> & { form_extra?: Record<string, unknown> }) =>
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
  /** 回收转售登记：把已回收账号的新售出订单关联回分期合约（后端只认 resale_order_id）。 */
  resale: (id: number, data: {resale_order_id: number; occurred_on: string; note: string}) => api.post<InstallmentDisposition>(`/installments/${id}/resale`, data).then(r => r.data),
  list: (params?: { status?: string; order_id?: number }) =>
    api.get<Installment[]>("/installments", { params }).then((r) => r.data),
  create: (payload: Partial<Installment> & { first_due_on: string; adjust_final_period?: boolean; schedule?: InstallmentScheduleInput[] }) =>
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
  cancel: (id: number, payload: { cancelled_on: string; reason: string; form_extra?: Record<string, unknown> }) =>
    api.post<InstallmentCancelResult>(`/installments/${id}/cancel`, payload).then((r) => r.data),
  settleEarly: (id: number, payload: { paid_on: string; pool_id?: number; note?: string }) =>
    api.post<Installment>(`/installments/${id}/settle-early`, payload).then((r) => r.data),
  markDefault: (id: number, payload: { reason: string }) =>
    api.post<Installment>(`/installments/${id}/default`, payload).then((r) => r.data),
  waiveSchedule: (id: number, periodNo: number, payload: { amount: string; waived_on: string; reason: string }) =>
    api.post<Schedule>(`/installments/${id}/schedules/${periodNo}/waive`, payload).then((r) => r.data),
  extendSchedule: (id: number, periodNo: number, payload: { new_due_on: string; reason: string }) =>
    api.post<Schedule>(`/installments/${id}/schedules/${periodNo}/extend`, payload).then((r) => r.data),
  markOverdue: (asOf?: string) =>
    api.post<{ marked: number }>("/installments/mark-overdue", undefined, { params: asOf ? { as_of: asOf } : undefined }).then((r) => r.data),
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
  loss: (id: number, payload: { amount: string; lost_on: string; category: string; reason: string }) =>
    api.post<Cashflow>(`/deposits/${id}/losses`, payload).then((r) => r.data),
  /** 取消押金：仅未发生退还/损失的 PAID 押金；服务端全额写 DEPOSIT_CANCEL 冲正流水。 */
  cancel: (id: number, payload: { cancelled_on: string; reason: string }) =>
    api.post<Deposit>(`/deposits/${id}/cancel`, payload).then((r) => r.data),
};

export const cashflowsApi = {
  create: (data: Record<string, unknown>) => api.post<Cashflow>("/cashflows", data).then(r => r.data),
  approve: (id: number) => api.post<Cashflow>(`/cashflows/${id}/approve`).then(r => r.data),
  reject: (id: number, reason: string, formExtra?: Record<string, unknown>) => api.post<Cashflow>(`/cashflows/${id}/reject`, { reason, form_extra: formExtra }).then(r => r.data),
  reverse: (id: number, data: {reversed_on: string; reason: string; form_extra?: Record<string, unknown>}) => api.post<Cashflow>(`/cashflows/${id}/reverse`, data).then(r => r.data),
  list: (params?: {
    pool_id?: number;
    order_id?: number;
    direction?: string;
    occurred_from?: string;
    occurred_to?: string;
    status?: string;
    nature?: string;
    fund_nature?: string;
    accounting_attribute?: string;
    category?: string;
    created_by?: string;
    limit?: number;
    offset?: number;
  }) =>
    // 兼容两种后端契约：分页对象 {items,total}（当前 main）与旧版裸数组，
    // 避免任一形态下 result.items 为 undefined 引发 `.filter is not a function` 类整页崩溃。
    api.get<{ items: Cashflow[]; total: number } | Cashflow[]>("/cashflows", { params }).then((r) => {
      const data = r.data as unknown;
      if (Array.isArray(data)) return { items: data as Cashflow[], total: (data as Cashflow[]).length };
      const obj = data as { items?: Cashflow[]; total?: number };
      return { items: obj.items ?? [], total: obj.total ?? 0 };
    }),
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
  /** 预计到账逾期清单（后端按 as_of 判定，返回逾期天数）。 */
  overdue: (asOf?: string) =>
    api.get<RebateOverdue[]>("/rebates/overdue", { params: asOf ? { as_of: asOf } : undefined }).then((r) => r.data),
  settlements: (id: number) =>
    api.get<Settlement[]>(`/rebates/${id}/settlements`).then((r) => r.data),
  reverseSettlement: (
    id: number,
    settlementId: number,
    payload: { reversed_on: string; reason: string },
  ) =>
    api
      .post<Settlement>(`/rebates/${id}/settlements/${settlementId}/reverse`, payload)
      .then((r) => r.data),
  /** 作废返点记录：仅零结算（OPEN）可作废；已有结算须走结算冲销。 */
  voidRecord: (id: number, reason: string) =>
    api.post<Rebate>(`/rebates/${id}/void`, { reason }).then((r) => r.data),
};

export interface RequiredWhen {
  /** 依赖字段键（同作用域内其它字段） */
  field: string;
  /** eq=等于任一触发值；ne=不等于任一触发值；filled=依赖字段有值 */
  op: "eq" | "ne" | "filled";
  /** 触发值（op=filled 时必须为空） */
  values?: string[] | null;
}

export interface FormScope {
  code: string;
  label: string;
  group: string;
}

export interface OrderFormField {
  id: number;
  order_type_code: string;
  field_key: string;
  label: string;
  field_type: string;
  options?: Array<string | { value: string; label: string }> | null;
  required: boolean;
  /** 条件必填：与 required 互斥；为空即纯选填 */
  required_when?: RequiredWhen | null;
  is_active: boolean;
  sort_order: number;
  /** 核心核算字段锁定：禁止删除，但仍可改必填/停用 */
  locked: boolean;
  /** 用户自定义字段（区别于种子预置的系统字段）；自定义字段可增删停 */
  is_custom: boolean;
  note?: string | null;
}

/** 表单字段配置（按表单作用域码维度）；自定义字段即客户/订单的扩展字段定义。 */
export const orderFormFieldsApi = {
  /** 表单作用域注册表（后端单一事实源；前端仅作降级兜底）。 */
  scopes: () => api.get<FormScope[]>("/order-form-fields/scopes").then((r) => r.data),
  list: (orderTypeCode: string, includeInactive = true) =>
    api
      .get<OrderFormField[]>("/order-form-fields", {
        params: { order_type_code: orderTypeCode, include_inactive: includeInactive },
      })
      .then((r) => r.data),
  create: (payload: Partial<OrderFormField>) =>
    api.post<OrderFormField>("/order-form-fields", payload).then((r) => r.data),
  update: (id: number, payload: Partial<OrderFormField>) =>
    api.patch<OrderFormField>(`/order-form-fields/${id}`, payload).then((r) => r.data),
  setActive: (id: number, active: boolean) =>
    api
      .patch<OrderFormField>(`/order-form-fields/${id}/active?active=${active}`)
      .then((r) => r.data),
  remove: (id: number) => api.delete(`/order-form-fields/${id}`),
};

/* ── T20：选项词典（D 类筛选器 / 业务字典） ────────────── */

export interface OptionItem {
  value: string;
  label: string;
}

export interface OptionSet {
  id: number;
  code: string;
  label: string;
  group: string;
  /** true=纯字典可编辑；false=后端死枚举只读 */
  editable: boolean;
  options: OptionItem[] | null;
  description?: string | null;
}

export interface OptionSetList {
  items: OptionSet[];
}

/** 选项词典：读取（筛选器广泛使用，仅登录即可） + 管理（option-set.manage）。 */
export const optionSetsApi = {
  list: (params?: { group?: string; editable?: boolean }) =>
    api.get<OptionSetList>("/option-sets", { params }).then((r) => r.data),
  get: (code: string) =>
    api.get<OptionSet>(`/option-sets/${code}`).then((r) => r.data),
  create: (payload: Partial<OptionSet>) =>
    api.post<OptionSet>("/option-sets", payload).then((r) => r.data),
  update: (code: string, payload: Partial<OptionSet>) =>
    api.put<OptionSet>(`/option-sets/${code}`, payload).then((r) => r.data),
  remove: (code: string) => api.delete(`/option-sets/${code}`),
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

export interface AuditEntityStat {
  entity_type: string;
  /** 真实累计条数（COUNT(*)） */
  count: number;
  last_at?: string | null;
  last_actor?: string | null;
}

export const auditApi = {
  list: (params?: {
    entity_type?: string;
    entity_id?: string;
    action?: string;
    actor?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }) =>
    api.get<{ items: AuditLogRow[]; total: number }>("/audit-logs", { params }).then((r) => r.data),
  actions: () => api.get<{ items: string[] }>("/audit-logs/actions").then((r) => r.data.items),
  /** 按 entity_type 汇总真实累计数。
   *  ⚠️ 不要用 list 的 `total` 当累计数——它的语义是「当前页行数」，
   *  limit=1 时恒等于 1（见 backend/app/audit/router.py）。 */
  stats: (entityTypes: string[]) =>
    api
      .get<{ items: AuditEntityStat[] }>("/audit-logs/stats", {
        params: { entity_types: entityTypes.join(",") },
      })
      .then((r) => r.data.items),
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
  /** 整批驳回（终态）：仅未确认批次可驳回；已确认走回滚/更正。 */
  reject: (batchId: number, reason: string) =>
    api.post<ImportBatch>(`/imports/batches/${batchId}/reject`, { reason }).then((r) => r.data),
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
  allocation_amount?: string;
  policy_version_id?: number | null;
  total_rate?: string;
  total_amount?: string;
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
  /** 作废草稿版本（SUPERSEDED）：仅 DRAFT 可作废；已发布版本是历史解析口径，服务端拒绝。 */
  supersede: (versionId: number, payload: { reason: string; replaced_by_version_id?: number }) =>
    api.post<PolicyVersion>(`/policy-versions/${versionId}/supersede`, payload).then((r) => r.data),
  /** 过期清扫：把 effective_to < on 的 ACTIVE 版本固化为 EXPIRED（幂等）。 */
  expireSweep: (on: string) =>
    api
      .post<{ swept: number; version_ids: number[]; on: string }>("/policies/versions/expire-sweep", undefined, {
        params: { on },
      })
      .then((r) => r.data),
  resolve: (policyCode: string, on: string, scope?: { scope_type?: string; scope_id?: number }) =>
    api
      .get<{ found: boolean; version: PolicyVersion | null }>("/policy-versions/resolve", {
        params: { policy_code: policyCode, on, scope_type: scope?.scope_type, scope_id: scope?.scope_id },
      })
      .then((r) => r.data),
  allocations: (orderId: number) =>
    api.get<{ items: ProfitAllocation[]; total: number; order_profit?: string }>(`/orders/${orderId}/profit-allocations`).then((r) => r.data),
  setAllocations: (orderId: number, items: { user_id?: number | null; role: string; allocation_type?: "BUY" | "SELL" | "OPERATION" | "COMPANY" | null; allocation_rate: string; allocation_amount?: string }[], formExtra?: Record<string, unknown>) =>
    api.put<{ items: ProfitAllocation[]; total: number; order_profit?: string }>(`/orders/${orderId}/profit-allocations`, { items, form_extra: formExtra }).then((r) => r.data),
  orderSnapshot: (orderId: number) =>
    api
      .get<{ found: boolean; snapshot: { policy_version_id?: number | null; policy_snapshot?: Record<string, unknown> | null } | null }>(
        `/orders/${orderId}/policy-snapshot`,
      )
      .then((r) => r.data),
};

export interface RouteImpactPreview { changed: boolean; historical_impact: Record<string, unknown>; future_effect: string }
export interface InstallmentDisposition { id: number; installment_id: number; account_id: number; action: string; occurred_on: string; related_order_id?: number | null; note: string }
export interface FinanceDimensionRow { pool_id: number; pool_code: string; pool_name: string; fund_nature: string; accounting_attribute: string; direction: string; flow_count: number; amount: string; signed_amount: string }
export interface FinanceDimensionReport { items: FinanceDimensionRow[]; total_amount: string; total_signed_amount: string }
export interface Reconciliation { id: number; pool_id: number; reconciled_on: string; account_label: string; system_balance: string; statement_balance: string; difference: string; status: string; reason?: string | null; unmatched_flow_ids?: number[]; note?: string | null }
export interface AttachmentItem { id: number; attachment_no: string; file_name: string; size_bytes: number; created_by: string }
export interface Lead { id: number; lead_no: string; customer_id: number; request_type: string; budget?: string | null; target: string; status: string }
export interface QualityIssue { id: number; issue_no: string; severity: string; title: string; entity_type: string; entity_id: string; status: string; message: string }
export interface QualitySummary { total: number; by_severity: Record<string, number> }

/** 单个指标的月度取值：rate 为空表示分母为 0（当月无该口径的数据），前端不得自行推算。 */
export interface QualityMetricValue {
  rate: number | null;
  numerator: number | null;
  denominator: number | null;
  amount: string | null;
}
/** 指标口径由后端下发（label/formula/unit），前端只负责展示，不在前端复写公式。 */
export interface QualityMetricDefinition { label: string; formula: string; unit: string }
export interface QualityMetricRow {
  month: string;
  reconciliation_completion_rate: QualityMetricValue;
  overdue_rate: QualityMetricValue;
  missing_attachment_rate: QualityMetricValue;
}
export interface QualityMetrics {
  from: string;
  to: string;
  definitions: Record<string, QualityMetricDefinition>;
  items: QualityMetricRow[];
}
export interface NotificationItem { id: number; notification_no: string; title: string; message: string; entity_type: string; entity_id: string; read_at?: string | null }
export interface SearchResult { id: number; type: string; code: string; title: string; subtitle?: string | null; route: string }
export const transfersApi = {
  create: (data: Record<string, unknown>) => api.post<TransferResult>("/transfers", data).then(r => r.data),
  repair: (transferId: string, data: { counterpart_pool_id: number; reason: string }) =>
    api.post<TransferResult>(`/transfers/${transferId}/repair`, data).then(r => r.data),
};
export const periodLocksApi = {
  list: () => api.get<PeriodLock[]>("/period-locks").then((r) => r.data),
  create: (data: { period: string; note?: string }) => api.post<PeriodLock>("/period-locks", data).then((r) => r.data),
};
export const reconciliationsApi = {
  list: () => api.get<Reconciliation[]>("/reconciliations").then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<Reconciliation>("/reconciliations", data).then(r => r.data),
  resolve: (id: number, reason: string) => api.post<Reconciliation>(`/reconciliations/${id}/resolve`, { reason }).then(r => r.data),
};
export interface DocumentSequence {
  sequence_key: string;
  prefix: string;
  padding: number;
  current_value: number;
  next_number: string;
}
export const sequencesApi = {
  list: () => api.get<DocumentSequence[]>("/sequences").then(r => r.data),
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
  /** 月度质量指标（对账完成率/分期逾期率/缺附件率）；不传区间时后端只给当月。 */
  metrics: (range?: { from?: string; to?: string }) =>
    api.get<QualityMetrics>("/quality/metrics", { params: range }).then(r => r.data),
  list: () => api.get<{ items: QualityIssue[] }>("/quality/issues").then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<QualityIssue>("/quality/issues", data).then(r => r.data),
  update: (id: number, data: { status: string }) => api.patch<QualityIssue>(`/quality/issues/${id}`, data).then(r => r.data),
  scan: () => api.post<QualityIssue[]>("/quality/scan").then(r => r.data),
  close: (id: number, data: { resolution: string; evidence: string }) => api.post<QualityIssue>(`/quality/issues/${id}/close`, data).then(r => r.data),
  batchClose: (data: { issue_ids: number[]; resolution: string; evidence: string }) => api.post<QualityIssue[]>("/quality/issues/batch-close", data).then(r => r.data),
};
export const notificationsApi = {
  list: (params: { limit: number; unread_only?: boolean }) => api.get<{ items: NotificationItem[]; unread_total: number }>("/notifications", { params }).then(r => r.data),
  markRead: (id: number) => api.post<NotificationItem>(`/notifications/${id}/read`).then(r => r.data),
  syncOverdueRebates: () => api.post<{ created: number }>("/notifications/sync-overdue-rebates").then(r => r.data),
};
export const searchApi = { query: (q: string) => api.get<{ items: SearchResult[] }>("/search", { params: { q } }).then(r => r.data) };
