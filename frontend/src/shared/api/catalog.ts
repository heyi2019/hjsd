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
  th_advance: string;
  available: string;
}

export interface OrderType {
  id: number;
  code: string;
  name: string;
  capital_type: string;
  is_active: boolean;
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
  note?: string | null;
  status: string;
  contact_masked?: boolean;
  merged_into_id?: number | null;
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
  note?: string | null;
}

export interface Order {
  id: number;
  order_no: string;
  order_type: string;
  capital_type: string;
  trade_date: string;
  account_id?: number | null;
  status: string;
  note?: string | null;
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
}

export interface EventPostResult {
  event: OrderEvent;
  cashflow_no: string | null;
}

export interface Account {
  id: number;
  account_no: string;
  game_account?: string | null;
  platform?: string | null;
  status: string;
  cost_amount: string;
}

export interface Installment {
  id: number;
  inst_no: string;
  order_id: number;
  contract_type: string;
  principal: string;
  down_payment: string;
  periods: number;
  per_period: string;
  paid_amount: string;
  status: string;
  delivery_mode?: string | null;
  delivered_on?: string | null;
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
  deposit_no: string;
  pool_id: number;
  paid_amount: string;
  returned_amount: string;
  status: string;
  paid_on: string;
  released_on?: string | null;
  note?: string | null;
}

export interface Rebate {
  id: number;
  rebate_group_no: string;
  source_order_id?: number | null;
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
}

export const poolsApi = {
  list: () => api.get<Pool[]>("/pools").then((r) => r.data),
  create: (payload: Partial<Pool>) => api.post<Pool>("/pools", payload).then((r) => r.data),
  balance: (poolId: number) =>
    api.get<PoolBalance>(`/pools/${poolId}/balance`).then((r) => r.data),
};

export const orderTypesApi = {
  list: () => api.get<OrderType[]>("/order-types").then((r) => r.data),
  create: (payload: Partial<OrderType>) =>
    api.post<OrderType>("/order-types", payload).then((r) => r.data),
  routes: (orderTypeId: number) =>
    api.get<OrderTypeRoute[]>(`/order-types/${orderTypeId}/routes`).then((r) => r.data),
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
  setStatus: (id: number, active: boolean) =>
    api.patch<Counterparty>(`/counterparties/${id}/status`, { active }).then((r) => r.data),
};

export const ordersApi = {
  list: (params?: { order_type?: string; status?: string }) =>
    api.get<Order[]>("/orders", { params }).then((r) => r.data),
  create: (payload: {
    order_type: string;
    trade_date: string;
    account_id?: number;
    owner_id?: number;
    capital_type?: string;
    note?: string;
    customer_roles?: { customer_id: number; role: string }[];
    counterparty_roles?: { counterparty_id: number; role: string }[];
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
      note?: string;
    },
  ) => api.post<EventPostResult>(`/orders/${orderId}/events`, payload).then((r) => r.data),
  transfer: (payload: {
    source_pool_id: number;
    target_pool_id: number;
    amount: string;
    occurred_on: string;
    note?: string;
  }) =>
    api.post<{ transfer_id: string; out_flow_no: string; in_flow_no: string; amount: string }>(
      "/transfers",
      payload,
    ).then((r) => r.data),
};

export const accountsApi = {
  list: (params?: { status?: string }) =>
    api.get<Account[]>("/accounts", { params }).then((r) => r.data),
  create: (payload: Partial<Account>) =>
    api.post<Account>("/accounts", payload).then((r) => r.data),
  inventory: () =>
    api
      .get<{ items: Account[]; count: number; total_cost: string }>("/accounts/inventory")
      .then((r) => r.data),
};

export const installmentsApi = {
  list: (params?: { status?: string; order_id?: number }) =>
    api.get<Installment[]>("/installments", { params }).then((r) => r.data),
  create: (payload: Partial<Installment> & { first_due_on: string }) =>
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

export const rebatesApi = {
  list: (params?: { source_order_id?: number }) =>
    api.get<Rebate[]>("/rebates", { params }).then((r) => r.data),
  create: (payload: Partial<Rebate> & { source_order_id: number; base_amount: string; collected_on: string }) =>
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
  setActive: (id: number, active: boolean) =>
    api.patch<FieldDefinition>(`/field-definitions/${id}/active?active=${active}`).then((r) => r.data),
};

/* ── M4：质量工单 / 报表 / 审计 ─────────────────────────────── */

export interface QualityIssue {
  id: number;
  issue_no: string;
  issue_type: string;
  severity: string;
  status: string;
  entity_type?: string | null;
  entity_id?: number | null;
  entity_label?: string | null;
  amount: string;
  detected_on: string;
  owner_id?: number | null;
  resolution?: string | null;
  closed_at?: string | null;
  note?: string | null;
}

export interface QualityOverviewItem {
  issue_type: string;
  severity: string;
  open: number;
  assigned: number;
  total: number;
  entry: string;
}

export interface QualityOverview {
  total: number;
  blockers: number;
  items: QualityOverviewItem[];
}

export interface InventoryHealthRow {
  account_no: string;
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
  risk_level: string;
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
  rebate_net: string;
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

export interface CommissionReport {
  total: { order_count: number; payable: string; paid: string; difference: string };
  items: CommissionRow[];
}

export interface BusinessPnlRow {
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
  transfer_in: string;
  transfer_out: string;
  deposit_paid: string;
  deposit_held: string;
  th_advance: string;
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

export const qualityApi = {
  overview: () => api.get<QualityOverview>("/quality/overview").then((r) => r.data),
  detect: () => api.post<{ detected_on: string; created_total: number }>("/quality/detect").then((r) => r.data),
  listIssues: (params?: {
    issue_type?: string;
    status?: string;
    severity?: string;
    limit?: number;
    offset?: number;
  }) => api.get<{ items: QualityIssue[]; total: number }>("/quality/issues", { params }).then((r) => r.data),
  issue: (id: number) => api.get<QualityIssue>(`/quality/issues/${id}`).then((r) => r.data),
  assign: (id: number, ownerId: number) =>
    api.post<QualityIssue>(`/quality/issues/${id}/assign`, { owner_id: ownerId }).then((r) => r.data),
  resolve: (id: number, payload: { resolution: string; note?: string }) =>
    api.post<QualityIssue>(`/quality/issues/${id}/resolve`, payload).then((r) => r.data),
  ignore: (id: number, reason: string) =>
    api.post<QualityIssue>(`/quality/issues/${id}/ignore`, { reason }).then((r) => r.data),
};

export const reportsApi = {
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
  entity_id?: number | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  occurred_at?: string | null;
}

export const auditApi = {
  list: (params?: { entity_type?: string; entity_id?: number; limit?: number; offset?: number }) =>
    api.get<{ items: AuditLogRow[]; total: number }>("/audit-logs", { params }).then((r) => r.data),
  actions: () => api.get<string[]>("/audit-logs/actions").then((r) => r.data),
};

/* ── M4 补齐：P2 历史参考导入（MIG-01）───────────────────────
 * 红线：只落原始行 + 人工映射，系统绝不自动匹配、绝不补造历史划转。 */

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

export const historyApi = {
  batches: () => api.get<{ items: ImportBatch[]; total: number }>("/history/batches").then((r) => r.data),
  createBatch: (payload: { source_name: string; rows: Record<string, unknown>[]; source_kind?: string; note?: string }) =>
    api.post<ImportBatch>("/history/batches", payload).then((r) => r.data),
  rows: (batchId: number, status?: string) =>
    api.get<{ items: ImportRow[]; total: number }>(`/history/batches/${batchId}/rows`, { params: { status } }).then((r) => r.data),
  preview: (batchId: number) =>
    api.get<MappingPreview>(`/history/batches/${batchId}/preview`).then((r) => r.data),
  reconciliation: (batchId: number) =>
    api.get<ReconciliationReport>(`/history/batches/${batchId}/reconciliation`).then((r) => r.data),
  /** basis 必填：补录关联必须有依据（MIG-01-05） */
  map: (rowId: number, payload: { order_id?: number | null; account_id?: number | null; basis: string }) =>
    api.post<ImportRow>(`/history/rows/${rowId}/map`, payload).then((r) => r.data),
  skip: (rowId: number, reason: string) =>
    api.post<ImportRow>(`/history/rows/${rowId}/skip`, { reason }).then((r) => r.data),
  /** 只打标记 + 开工单，服务端绝不补造配对流水 */
  markUnlinked: (rowId: number, note?: string) =>
    api.post<ImportRow>(`/history/rows/${rowId}/unlinked-transfer`, { note }).then((r) => r.data),
  commit: (batchId: number) =>
    api.post<ImportBatch & { imported: number; unmapped: number }>(`/history/batches/${batchId}/commit`).then((r) => r.data),
  rollback: (batchId: number, reason: string) =>
    api.post<ImportBatch>(`/history/batches/${batchId}/rollback`, { reason }).then((r) => r.data),
  createCorrection: (batchId: number, payload: { rows: Record<string, unknown>[]; reason: string }) =>
    api.post<ImportBatch>(`/history/batches/${batchId}/corrections`, payload).then((r) => r.data),
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
  user_id: number;
  role: string;
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
  setAllocations: (orderId: number, items: { user_id: number; role: string; allocation_rate: string }[]) =>
    api.put<{ items: ProfitAllocation[]; total: number }>(`/orders/${orderId}/profit-allocations`, { items }).then((r) => r.data),
  orderSnapshot: (orderId: number) =>
    api
      .get<{ found: boolean; snapshot: { policy_version_id?: number | null; policy_snapshot?: Record<string, unknown> | null } | null }>(
        `/orders/${orderId}/policy-snapshot`,
      )
      .then((r) => r.data),
};
