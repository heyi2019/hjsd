/** 全部 v1 接口 DTO 类型定义（从 catalog.ts 拆分而来）。
 * 路径以后端 `/api/v1` 实际路由为准；金额一律以字符串传输，前端不做浮点数计算。 */

export interface PageResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

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
  /** 表单扩展字段值：field_key → 值，由统一字段配置驱动（BAS-04） */
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
  extra_fields?: Array<{ key: string; label: string; section: string; value: unknown }>;
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
  inventory_entry_at?: string | null;
  inventory_operator?: string | null;
  sale_at?: string | null;
  sale_operator?: string | null;
  in_hand_time?: string | null;
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
  /** 自定义扩展字段历史值（按 field_key 归集）；删除/停用字段的值仍保留在此，详情展示时兜底。 */
  form_extra?: Record<string, unknown>;
  /** 建单时的账号文本快照（无 order.create 权限时 game_password 被后端置空）。 */
  account_snapshot?: {
    game_account: string;
    game_type?: string | null;
    game_password?: string | null;
    channel_region?: string | null;
    bound_phone?: string | null;
    bound_phone_owner?: string | null;
    has_secondary?: boolean | null;
    platform?: string | null;
    purchase_price?: string | null;
    note?: string | null;
  } | null;
  /** 关联完整性：NORMAL / ORPHAN / UNLINKED_TRANSFER（后端 orders/schemas.py）。 */
  link_status?: string;
}

export interface OrderCashflow {
  flow_no: string;
  pool_id: number;
  occurred_on: string;
  occurred_at?: string | null;
  nature: string;
  category: string;
  direction: string;
  amount: string;
  status: string;
  order_event_id?: number | null;
  note?: string | null;
  operator: string;
}

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
  note?: string | null;
  created_at?: string;
  operator: string;
}

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
  operator_user_ids?: number[] | null;
  note?: string | null;
  form_extra?: Record<string, unknown> | null;
  is_posted: boolean;
  posted_at?: string | null;
  operator?: string;
}

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
  stock_no?: string | null;
  source_order_id?: number | null;
  source_order_no?: string | null;
  game_type?: string | null;
  business_mode?: string | null;
  inventory_type?: string | null;
  value_added_service?: string | null;
  game_account?: string | null;
  game_password?: string | null;
  channel_region?: string | null;
  bound_phone?: string | null;
  bound_phone_owner?: string | null;
  has_secondary?: boolean | null;
  account_description?: string | null;
  account_images?: string[] | null;
  extra_values?: Record<string, unknown>;
  note?: string | null;
  platform?: string | null;
  status: string;
  inventory_status?: string;
  inventory_entry_at?: string | null;
  inventory_operator?: string | null;
  cost_amount: string;
  buy_date?: string | null;
  created_by: string;
  created_at?: string | null;
}

export interface AccountInventoryRow {
  account_id: number;
  stock_no?: string | null;
  game_account?: string | null;
  business_mode?: string | null;
  inventory_type?: string | null;
  platform?: string | null;
  status: string;
  inventory_status?: string;
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
  pool_id?: number | null;
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
  base_amount: string;
  status: string;
  collected_on: string;
  collected_at?: string | null;
}

export interface AccountExecutionOrder {
  order_id: number;
  order_no: string;
  order_type: string;
  trade_date: string;
  created_at?: string | null;
  status: string;
  account_platform?: string | null;
  note?: string | null;
  extra_values?: Record<string, unknown>;
  extra_fields?: Array<{ key: string; label: string; section: string; value: unknown }>;
  cashflows?: AccountExecutionCashflow[];
  customers?: AccountExecutionCustomer[];
  counterparties?: AccountExecutionCounterparty[];
  rebates?: AccountExecutionRebate[];
  events: AccountExecutionEvent[];
  operator: string;
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

export interface AccountExecutionDetail {
  account: Account;
  orders: AccountExecutionOrder[];
  audit?: AccountAuditEntry[];
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
  total_receivable: string;
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
  occurred_at?: string | null;
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
  note?: string | null;
  created_at?: string;
  operator?: string;
  operator_user_ids?: number[] | null;
}

export interface GameTypeOption {
  id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
  is_default: boolean;
  channel_regions?: string[];
}

export interface EmployeeOption { id: number; username: string; display_name: string; is_active: boolean }

export interface ManagedUser extends EmployeeOption {
  role: string;
  owner_scope: string;
  pool_ids: number[];
  team_ids: number[];
  must_change_password: boolean;
}

export interface Team {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  is_active: boolean;
}

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
  options?: Array<{ value: string; label: string }> | null;
  flow_direction?: "IN" | "OUT" | null;
  required: boolean;
  /** 条件必填：与 required 互斥；为空即纯选填 */
  required_when?: RequiredWhen | null;
  is_active: boolean;
  sort_order: number;
  /** 核心核算字段锁定：禁止删除，但仍可改必填/停用 */
  locked: boolean;
  /** 用户自定义字段（区别于种子预置的系统字段）；自定义字段可增删停 */
  is_custom: boolean;
  section?: string;
  note?: string | null;
}

export interface ListColumnConfig {
  key: string;
  label: string;
  /** 锁定列（身份列/操作列）不可隐藏，后端二次校验 */
  locked: boolean;
  is_visible: boolean;
  sort_order: number;
  /** 列宽覆盖值（px）；null/undefined = 沿用列定义自身宽度 */
  width?: number | null;
  /** 固定列；null/undefined = 不固定 */
  fixed?: "left" | "right" | null;
  /** 管理员新增的自定义列（绑定表单自定义字段） */
  custom?: boolean;
  /** 取值键：行数据 form_extra / extra_values 里的字段键 */
  source_key?: string | null;
  /** 选项码 → 中文展示名（SELECT / MULTI_SELECT） */
  value_labels?: Record<string, string> | null;
}

export interface ListScopeConfig {
  code: string;
  label: string;
  columns: ListColumnConfig[];
}

export interface ListCustomFieldOption {
  scope: string;
  scope_label: string;
  field_key: string;
  label: string;
  field_type: string;
  options: Array<{ value: string; label: string }>;
  /** 数据中已有值的键（无字段定义，按原值展示，标注来源与行数） */
  data_only?: boolean;
  source_label?: string | null;
  row_count?: number | null;
}

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
  total: { order_count: number; profit_base: string; payable: string; paid: string; difference: string };
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

export interface RouteImpactPreview { changed: boolean; historical_impact: Record<string, unknown>; future_effect: string }

export interface InstallmentDisposition { id: number; installment_id: number; account_id: number; action: string; occurred_on: string; related_order_id?: number | null; note: string }

export interface FinanceDimensionRow { pool_id: number; pool_code: string; pool_name: string; fund_nature: string; accounting_attribute: string; direction: string; flow_count: number; amount: string; signed_amount: string }

export interface FinanceDimensionReport { items: FinanceDimensionRow[]; total_amount: string; total_signed_amount: string }

export interface Reconciliation { id: number; pool_id: number; reconciled_on: string; account_label: string; system_balance: string; statement_balance: string; difference: string; status: string; reason?: string | null; unmatched_flow_ids?: number[]; note?: string | null }

export interface AttachmentItem { id: number; attachment_no: string; file_name: string; size_bytes: number; created_by: string }

export interface Lead { id: number; lead_no: string; customer_id: number; request_type: string; budget?: string | null; target: string; status: string }

export interface QualityIssue { id: number; issue_no: string; severity: string; title: string; entity_type: string; entity_id: string; status: string; message: string }

export interface QualitySummary { total: number; by_severity: Record<string, number> }

export interface QualityMetricValue {
  rate: number | null;
  numerator: number | null;
  denominator: number | null;
  amount: string | null;
}

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

export interface DocumentSequence {
  sequence_key: string;
  prefix: string;
  padding: number;
  current_value: number;
  next_number: string;
}
