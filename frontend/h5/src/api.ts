/**
 * H5 接口层：只包本端用到的端点，不复用桌面端 axios 实例。
 *
 * 为什么不直接 import `src/shared/api/client.ts`：
 *  1) 那层挂了 SWR 缓存、云端只读适配器与 dev 直通用户，都是桌面调试用的，
 *     手机端不需要，且会把 antd 之类的依赖拖进 H5 包；
 *  2) H5 必须自带 401 兜底（令牌过期直接回登录页），与桌面端行为不同。
 *
 * 基址与桌面端同源：开发走 vite 代理，生产走 nginx 同源反代，故默认相对路径。
 */
import axios from "axios";

export const API_BASE = import.meta.env.VITE_API_BASE ?? "/api/v1";
export const TOKEN_KEY = "hj.access-token";

export const http = axios.create({ baseURL: API_BASE, timeout: 15_000 });

http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

http.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 0;
      const body = error.response?.data as { message?: string; code?: string } | undefined;
      const message =
        body?.message
        ?? (status === 0 ? "网络连接失败，请检查网络后重试" : "请求失败，请稍后重试");
      return Promise.reject(new ApiError(message, status, body?.code ?? "UNKNOWN"));
    }
    return Promise.reject(error);
  },
);

// ---------------------------------------------------------------- 类型

export interface SessionUser {
  id: number;
  username: string;
  display_name: string;
  role: string;
  phone?: string | null;
  must_change_password?: boolean;
  /** 来自 token 的 amr：password / phone_code / wechat。H5 改密页据此决定是否收旧密码。 */
  auth_method?: string;
}

export interface LoginMethods {
  password: { enabled: boolean };
  phone_code: { enabled: boolean; dev_code_visible: boolean };
  wechat_h5: { enabled: boolean; configured: boolean; provider: string; reason: string | null };
}

export interface CodeChallenge {
  sent: boolean;
  expires_in: number;
  phone: string;
  code_ticket: string;
  dev_code: string | null;
}

export interface PasswordlessResult {
  status: "logged_in" | "bind_required";
  access_token: string | null;
  user: SessionUser | null;
  bind_ticket: string | null;
  verify_mode: string | null;
  phone_hint: string | null;
  message: string | null;
}

export interface OrderRow {
  id: number;
  order_no: string;
  order_type: string;
  status: string;
  trade_date: string;
  party_name: string | null;
  account_game_account: string | null;
  account_game_type: string | null;
  event_total: string | null;
  profit_base: string | null;
  last_event_type: string | null;
  last_event_amount: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface PoolBalance {
  pool_id: number;
  pool_code: string;
  available: string;
  cash_balance: string;
  deposit_held: string;
}

// ---------------------------------------------------------------- 认证

export async function fetchLoginMethods(): Promise<LoginMethods> {
  const { data } = await http.get<LoginMethods>("/auth/login-methods");
  return data;
}

export async function loginWithPassword(username: string, password: string): Promise<string> {
  const { data } = await http.post<{ access_token: string; user: SessionUser }>("/auth/login", {
    username,
    password,
  });
  return data.access_token;
}

export async function sendPhoneCode(phone: string): Promise<CodeChallenge> {
  const { data } = await http.post<CodeChallenge>("/auth/phone/code", { phone });
  return data;
}

export async function loginWithPhone(
  phone: string,
  code: string,
  codeTicket: string,
): Promise<string> {
  const { data } = await http.post<{ access_token: string }>("/auth/phone/login", {
    phone,
    code,
    code_ticket: codeTicket,
  });
  return data.access_token;
}

export async function requestWechatAuthorize(channel: "web" | "h5", redirectUri: string) {
  const { data } = await http.get<{ authorize_url: string; state: string; channel: string }>(
    "/auth/wechat/authorize",
    { params: { channel, redirect_uri: redirectUri } },
  );
  return data;
}

export async function loginWithWechat(
  code: string,
  state: string,
  channel: "web" | "h5",
): Promise<PasswordlessResult> {
  const { data } = await http.post<PasswordlessResult>("/auth/wechat/login", {
    code,
    state,
    channel,
  });
  return data;
}

export async function sendWechatBindCode(bindTicket: string, phone: string): Promise<CodeChallenge> {
  const { data } = await http.post<CodeChallenge>("/auth/wechat/bind/code", {
    bind_ticket: bindTicket,
    phone,
  });
  return data;
}

export async function confirmWechatBind(payload: {
  bindTicket: string;
  phone: string;
  code?: string;
  codeTicket?: string;
  password?: string;
}): Promise<PasswordlessResult> {
  const { data } = await http.post<PasswordlessResult>("/auth/wechat/bind/confirm", {
    bind_ticket: payload.bindTicket,
    phone: payload.phone,
    code: payload.code ?? null,
    code_ticket: payload.codeTicket ?? null,
    password: payload.password ?? null,
  });
  return data;
}

export async function fetchMe(): Promise<SessionUser> {
  const { data } = await http.get<SessionUser>("/auth/me");
  return data;
}

export async function changePassword(
  oldPassword: string | null,
  newPassword: string,
): Promise<void> {
  await http.post("/auth/change-password", {
    old_password: oldPassword,
    new_password: newPassword,
  });
}

export async function logout(): Promise<void> {
  await http.post("/auth/logout", {}).catch(() => undefined);
  localStorage.removeItem(TOKEN_KEY);
}

// ---------------------------------------------------------------- 业务

export async function listOrders(params: {
  limit?: number;
  offset?: number;
  keyword?: string;
  orderType?: string;
  status?: string;
  tradeDateFrom?: string;
  tradeDateTo?: string;
}): Promise<Page<OrderRow>> {
  const { data } = await http.get<Page<OrderRow>>("/orders", {
    params: {
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
      keyword: params.keyword || undefined,
      order_type: params.orderType || undefined,
      status: params.status || undefined,
      trade_date_from: params.tradeDateFrom || undefined,
      trade_date_to: params.tradeDateTo || undefined,
    },
  });
  return data;
}

export async function fetchPoolBalances(): Promise<PoolBalance[]> {
  const { data } = await http.get<{ items: PoolBalance[] }>("/pools/balances");
  return data.items ?? [];
}

export async function fetchStockTotal(): Promise<number> {
  const { data } = await http.get<Page<unknown>>("/stocks", { params: { limit: 1 } });
  return data.total ?? 0;
}

// ---------------------------------------------------------------- 订单详情

/** 订单详情：后端 GET /orders/{id} 返回全量字段，移动端只取要展示的部分。 */
export interface OrderDetail extends OrderRow {
  account_id?: number | null;
  link_status?: string | null;
  owner_name?: string | null;
  capital_type?: string | null;
  note?: string | null;
  created_at?: string | null;
  created_by?: string | null;
  customer_roles?: { customer_id: number; role: string; customer_name?: string | null }[];
  counterparty_roles?: { counterparty_id: number; role: string; counterparty_name?: string | null }[];
  form_extra?: Record<string, unknown> | null;
  account_snapshot?: Record<string, unknown> | null;
}

export async function fetchOrder(id: number): Promise<OrderDetail> {
  const { data } = await http.get<OrderDetail>(`/orders/${id}`);
  return data;
}

// ---------------------------------------------------------------- 库存

export interface StockRow {
  id: number;
  stock_no?: string | null;
  game_account?: string | null;
  /** 明文密码（既定裁决，勿加密/脱敏）；展示层默认折叠，见 StockDetailPage 的 Secret。 */
  game_password?: string | null;
  camp_account?: string | null;
  bound_phone?: string | null;
  wallet_realname?: string | null;
  game_type?: string | null;
  platform?: string | null;
  channel_region?: string | null;
  business_mode?: string | null;
  inventory_type?: string | null;
  status: string;
  inventory_status?: string | null;
  cost_amount: string;
  buy_date?: string | null;
  inventory_age_days?: number | null;
  inventory_age_level?: "NORMAL" | "WARNING" | "OVERDUE" | null;
  /** 入库订单 ID：库存售出必须在它上面登记 SELL 事件，缺失就无法售出。 */
  source_order_id?: number | null;
  source_order_no?: string | null;
  note?: string | null;
}

export async function listStocks(params: {
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<Page<StockRow>> {
  const { data } = await http.get<Page<StockRow>>("/stocks", {
    params: {
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
      status: params.status || undefined,
    },
  });
  return data;
}

/**
 * 单个账号。
 * 后端**没有** `GET /stocks/{id}`（只有 PATCH），直接取会 405；单账号资料在
 * `GET /stocks/{id}/execution-detail` 的 `account` 里，这里复用它，
 * 顺带拿到财务汇总，详情页不必再发第二个请求。
 */
export async function fetchStock(id: number): Promise<StockRow> {
  const { data } = await http.get<{ account: StockRow }>(`/stocks/${id}/execution-detail`);
  return data.account;
}

// ---------------------------------------------------------------- 客户

export interface CustomerRow {
  id: number;
  customer_no: string;
  display_name: string;
  contact_name?: string | null;
  phone?: string | null;
  wechat?: string | null;
  source?: string | null;
  status: string;
  note?: string | null;
  created_at?: string | null;
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

export interface CustomerDetail {
  customer: CustomerRow;
  overview?: CustomerOverview;
  business?: {
    order_id: number;
    order_no: string;
    order_type: string;
    status: string;
    trade_date: string;
    roles: string[];
  }[];
}

export async function listCustomers(params: {
  limit?: number;
  offset?: number;
  keyword?: string;
  status?: string;
}): Promise<Page<CustomerRow>> {
  const { data } = await http.get<Page<CustomerRow>>("/customers", {
    params: {
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
      keyword: params.keyword || undefined,
      status: params.status || undefined,
    },
  });
  return data;
}

export async function fetchCustomerDetail(id: number): Promise<CustomerDetail> {
  const { data } = await http.get<CustomerDetail>(`/customers/${id}/detail`);
  return data;
}

export async function createCustomer(payload: {
  display_name: string;
  contact_name?: string | null;
  phone?: string | null;
  wechat?: string | null;
  qq?: string | null;
  source?: string | null;
  note?: string | null;
}): Promise<{ customer: CustomerRow }> {
  const { data } = await http.post<{ customer: CustomerRow }>("/customers", payload);
  return data;
}

// ---------------------------------------------------------------- 资金流水

export interface CashflowRow {
  id: number;
  flow_no: string;
  pool_id: number;
  pool_name?: string | null;
  occurred_on: string;
  category: string;
  direction: "IN" | "OUT" | string;
  amount: string;
  status: string;
  nature?: string;
  fund_nature?: string;
  order_no?: string | null;
  operator?: string | null;
  note?: string | null;
}

export async function listCashflows(params: {
  limit?: number;
  offset?: number;
  pool_id?: number;
  direction?: string;
  status?: string;
  occurred_from?: string;
  occurred_to?: string;
  keyword?: string;
}): Promise<{ items: CashflowRow[]; total: number; total_in?: string; total_out?: string }> {
  const { data } = await http.get<{ items: CashflowRow[]; total: number; total_in?: string; total_out?: string }>(
    "/cashflows",
    {
      params: {
        limit: params.limit ?? 20,
        offset: params.offset ?? 0,
        pool_id: params.pool_id || undefined,
        direction: params.direction || undefined,
        status: params.status || undefined,
        occurred_from: params.occurred_from || undefined,
        occurred_to: params.occurred_to || undefined,
        keyword: params.keyword || undefined,
      },
    },
  );
  return data;
}

// ---------------------------------------------------------------- 分期

export interface InstallmentRow {
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

export async function listInstallments(params?: {
  status?: string;
  order_id?: number;
}): Promise<InstallmentRow[]> {
  const { data } = await http.get<InstallmentRow[]>("/installments", { params });
  return data;
}

export async function fetchInstallmentTotals(params?: {
  status?: string;
}): Promise<{ total_receivable: string; total_paid: string; total_remaining: string }> {
  const { data } = await http.get<{ total_receivable: string; total_paid: string; total_remaining: string }>(
    "/installments/totals",
    { params },
  );
  return data;
}

// ---------------------------------------------------------------- 建单基础数据
// 说明：以下接口与桌面端 `shared/api/*.api.ts` 一一对应，但**不自动翻页**。
// H5 的列表都带分页或筛选，一次拉全量会把蜂窝网络下的首屏拖到十几秒。

export interface OptionItem {
  value: string;
  label: string;
}

export interface OrderTypeRow {
  id: number;
  code: string;
  name: string;
  is_active: boolean;
  contract_type?: string | null;
}

export interface FormFieldRow {
  id: number;
  order_type_code: string;
  field_key: string;
  label: string;
  field_type: string;
  options?: OptionItem[] | null;
  flow_direction?: "IN" | "OUT" | null;
  required: boolean;
  required_when?: { field: string; op: "eq" | "ne" | "filled"; values?: string[] } | null;
  is_active: boolean;
  sort_order: number;
  locked: boolean;
  is_custom: boolean;
  section?: string | null;
  note?: string | null;
}

export interface PoolRow {
  id: number;
  code: string;
  name: string;
  pool_type: string;
  ownership: string;
  status: string;
  note?: string | null;
}

export interface GameTypeRow {
  id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
  is_default: boolean;
  channel_regions?: string[];
}

export interface EmployeeOption {
  id: number;
  username: string;
  display_name: string;
  is_active: boolean;
}

export interface CounterpartyRow {
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
}

export async function listOrderTypes(): Promise<OrderTypeRow[]> {
  const { data } = await http.get<OrderTypeRow[]>("/order-types");
  return data;
}

export async function listFormFields(orderTypeCode: string): Promise<FormFieldRow[]> {
  const { data } = await http.get<FormFieldRow[]>("/order-form-fields", {
    params: { order_type_code: orderTypeCode, include_inactive: true },
  });
  return data;
}

export async function listSectionLabels(orderTypeCode: string): Promise<Record<string, string>> {
  const { data } = await http.get<Record<string, string>>("/order-form-fields/section-labels", {
    params: { order_type_code: orderTypeCode },
  });
  return data;
}

export async function listPools(): Promise<PoolRow[]> {
  const { data } = await http.get<PoolRow[]>("/pools");
  return data;
}

export async function listGameTypes(includeInactive = false): Promise<GameTypeRow[]> {
  const { data } = await http.get<GameTypeRow[]>("/game-types", { params: { include_inactive: includeInactive } });
  return data;
}

export async function listEmployees(): Promise<EmployeeOption[]> {
  const { data } = await http.get<EmployeeOption[]>("/users/options");
  return data;
}

export async function listCounterparties(params?: { type?: string }): Promise<CounterpartyRow[]> {
  const { data } = await http.get<CounterpartyRow[]>("/counterparties", { params });
  return data;
}

export async function listOptionSet(code: string): Promise<OptionItem[]> {
  const { data } = await http.get<{ options: OptionItem[] | null }>(`/option-sets/${code}`);
  return data.options ?? [];
}

// ---------------------------------------------------------------- 订单写操作

export interface OrderCreatePayload {
  order_type: string;
  trade_date: string;
  account_snapshot?: {
    game_account: string;
    game_type?: string;
    game_password?: string;
    camp_account?: string;
    channel_region?: string;
    bound_phone?: string;
    bound_phone_owner?: string;
    has_secondary?: boolean;
    wallet_realname?: string;
    note?: string;
    extra_values?: Record<string, unknown>;
  };
  confirm_repurchase?: boolean;
  note?: string | null;
  form_extra?: Record<string, unknown>;
  customer_roles?: { customer_id: number; role: string }[];
  counterparty_roles?: { counterparty_id: number; role: string }[];
  initial_buy?: { amount: string; occurred_on: string; pool_id?: number; portion?: string; note?: string };
  initial_costs?: {
    amount: string;
    occurred_on: string;
    pool_id?: number;
    portion?: string;
    flow_category?: string;
    note?: string;
  }[];
}

/** 建单。后端会返回 REPURCHASE_CONFIRM_REQUIRED / INVENTORY_ACCOUNT_IN_STOCK 两个业务码。 */
export async function createOrder(payload: OrderCreatePayload): Promise<OrderDetail> {
  const { data } = await http.post<OrderDetail>("/orders", payload);
  return data;
}

export interface OrderEventPayload {
  event_type: "BUY" | "COST" | "SELL" | "PAYMENT" | "DELIVER" | "CANCEL" | "REFUND";
  amount?: string;
  occurred_on: string;
  pool_id?: number;
  pool_id2?: number;
  amount2?: string;
  portion?: string;
  delivery_mode?: string;
  offset_event_id?: number;
  reason?: string;
  refund_responsibility?: "COMPANY" | "CUSTOMER" | "CONSIGNOR" | "PLATFORM" | "OTHER";
  operator_user_ids?: number[];
  flow_category?: string;
  note?: string;
  bound_phone?: string;
  bound_phone_owner?: string;
  form_extra?: Record<string, unknown>;
}

export async function postOrderEvent(orderId: number, payload: OrderEventPayload): Promise<unknown> {
  const { data } = await http.post(`/orders/${orderId}/events`, payload);
  return data;
}

export async function cancelOrder(
  orderId: number,
  payload: { reason: string; form_extra?: Record<string, unknown> },
): Promise<OrderDetail> {
  const { data } = await http.post<OrderDetail>(`/orders/${orderId}/cancel`, payload);
  return data;
}

export async function patchOrder(
  orderId: number,
  payload: {
    trade_date?: string;
    note?: string | null;
    form_extra?: Record<string, unknown>;
    account_snapshot?: Record<string, unknown> | null;
  },
): Promise<OrderDetail> {
  const { data } = await http.patch<OrderDetail>(`/orders/${orderId}`, payload);
  return data;
}

export async function addOrderCustomerRole(
  orderId: number,
  payload: { customer_id: number; role: string },
): Promise<unknown> {
  const { data } = await http.post(`/orders/${orderId}/customer-roles`, payload);
  return data;
}

// ---------------------------------------------------------------- 库存售出 / 分期

export async function createInstallmentForOrder(payload: {
  order_id: number;
  contract_type: string;
  principal: string;
  down_payment: string;
  service_fee: string;
  periods: number;
  per_period_service_fee: string;
  per_period: string;
  first_due_on: string;
  adjust_final_period?: boolean;
  note?: string;
  schedule?: { period_no: number; due_on: string }[];
}): Promise<{ id: number }> {
  const { data } = await http.post<{ id: number }>("/installments", payload);
  return data;
}

export async function payInstallment(
  id: number,
  payload: { amount: string; paid_on: string; period_no?: number; pool_id?: number; note?: string },
): Promise<unknown> {
  const { data } = await http.post(`/installments/${id}/payments`, payload);
  return data;
}

export interface ScheduleRow {
  period_no: number;
  due_on: string;
  amount: string;
  service_fee?: string;
  paid_amount?: string;
  status: string;
}

export async function fetchInstallmentSchedules(id: number): Promise<ScheduleRow[]> {
  const { data } = await http.get<ScheduleRow[]>(`/installments/${id}/schedules`);
  return data;
}

export async function fetchInstallment(id: number): Promise<InstallmentRow> {
  const { data } = await http.get<InstallmentRow>(`/installments/${id}`);
  return data;
}

export async function installmentAction(
  id: number,
  action: "cancel" | "settle-early" | "default" | "deliver" | "recover",
  payload: Record<string, unknown>,
): Promise<unknown> {
  const { data } = await http.post(`/installments/${id}/${action}`, payload);
  return data;
}

// ---------------------------------------------------------------- 资金写操作

export async function createCashflow(payload: {
  pool_id: number;
  occurred_on: string;
  direction: "IN" | "OUT";
  nature: string;
  fund_nature?: string;
  accounting_attribute?: string;
  category: string;
  amount: string;
  order_id?: number;
  note?: string | null;
}): Promise<CashflowRow> {
  const { data } = await http.post<CashflowRow>("/cashflows", payload);
  return data;
}

export async function reverseCashflow(
  id: number,
  payload: { reversed_on: string; reason: string },
): Promise<CashflowRow> {
  const { data } = await http.post<CashflowRow>(`/cashflows/${id}/reverse`, payload);
  return data;
}

export async function createTransfer(payload: {
  from_pool_id: number;
  to_pool_id: number;
  amount: string;
  occurred_on: string;
  note?: string;
}): Promise<unknown> {
  const { data } = await http.post("/transfers", payload);
  return data;
}

export interface ReconciliationRow {
  id: number;
  pool_id: number;
  reconciled_on: string;
  account_label: string;
  statement_balance: string;
  book_balance?: string;
  difference?: string;
  status: string;
  reason?: string | null;
}

export async function listReconciliations(): Promise<ReconciliationRow[]> {
  const { data } = await http.get<ReconciliationRow[]>("/reconciliations");
  return data;
}

export async function createReconciliation(payload: {
  pool_id: number;
  reconciled_on: string;
  account_label: string;
  statement_balance: string;
  note?: string;
}): Promise<ReconciliationRow> {
  const { data } = await http.post<ReconciliationRow>("/reconciliations", payload);
  return data;
}

export async function resolveReconciliation(id: number, reason: string): Promise<ReconciliationRow> {
  const { data } = await http.post<ReconciliationRow>(`/reconciliations/${id}/resolve`, { reason });
  return data;
}

export interface DepositRow {
  id: number;
  pool_id: number;
  amount: string;
  returned_amount?: string;
  lost_amount?: string;
  paid_on: string;
  status: string;
  note?: string | null;
}

export async function listDeposits(): Promise<DepositRow[]> {
  const { data } = await http.get<DepositRow[]>("/deposits");
  return data;
}

// ---------------------------------------------------------------- 报表

export interface MonthlyPnlReport {
  rows?: { month: string; income: string; expense: string; profit: string }[];
  from?: string;
  to?: string;
  [key: string]: unknown;
}

export async function fetchMonthlyPnl(params?: { from?: string; to?: string }): Promise<MonthlyPnlReport> {
  const { data } = await http.get<MonthlyPnlReport>("/reports/monthly-pnl", { params });
  return data;
}

export async function fetchCommissionReport(params?: { from?: string; to?: string; mine?: boolean }): Promise<unknown> {
  const { data } = await http.get("/reports/commission", { params });
  return data;
}

export async function fetchBusinessPnl(params?: { from?: string; to?: string }): Promise<unknown> {
  const { data } = await http.get("/reports/business-pnl", { params });
  return data;
}

export async function fetchDailyFunds(params?: { on?: string }): Promise<unknown> {
  const { data } = await http.get("/reports/daily-funds", { params });
  return data;
}

export async function fetchOrderProfit(params?: { from?: string; to?: string }): Promise<unknown> {
  const { data } = await http.get("/reports/order-profit", { params });
  return data;
}

export async function fetchInventoryHealth(): Promise<unknown> {
  const { data } = await http.get("/reports/inventory-health");
  return data;
}

export async function fetchFinanceDimensions(params?: { from?: string; to?: string }): Promise<unknown> {
  const { data } = await http.get("/reports/finance-dimensions", { params });
  return data;
}

// ---------------------------------------------------------------- 设置

export interface ManagedUser {
  id: number;
  username: string;
  display_name: string;
  role: string;
  owner_scope: string;
  pool_ids: number[];
  team_ids: number[];
  phone?: string | null;
  is_active: boolean;
  must_change_password: boolean;
}

export async function listUsers(): Promise<ManagedUser[]> {
  const { data } = await http.get<ManagedUser[]>("/users");
  return data;
}

export async function createUser(payload: Record<string, unknown>): Promise<ManagedUser> {
  const { data } = await http.post<ManagedUser>("/users", payload);
  return data;
}

export async function updateUser(id: number, payload: Record<string, unknown>): Promise<ManagedUser> {
  const { data } = await http.patch<ManagedUser>(`/users/${id}`, payload);
  return data;
}

export async function resetUserPassword(id: number, password: string): Promise<void> {
  await http.post(`/users/${id}/reset-password`, { password });
}

export interface PolicyRow {
  id: number;
  policy_code: string;
  name: string;
  scope_type: string;
  status?: string;
  description?: string | null;
}

export async function listPolicies(): Promise<{ items: PolicyRow[]; total: number }> {
  const { data } = await http.get<{ items: PolicyRow[]; total: number }>("/policies");
  return data;
}

export async function listPolicyVersions(definitionId: number): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const { data } = await http.get<{ items: Record<string, unknown>[]; total: number }>(
    `/policies/${definitionId}/versions`,
  );
  return data;
}

export interface AuditRow {
  id: number;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  created_at: string;
  summary?: string | null;
  details?: Record<string, unknown> | null;
}

export async function listAuditLogs(params?: {
  entity_type?: string;
  actor?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: AuditRow[]; total: number }> {
  const { data } = await http.get<{ items: AuditRow[]; total: number }>("/audit-logs", {
    params: { limit: params?.limit ?? 30, offset: params?.offset ?? 0, entity_type: params?.entity_type, actor: params?.actor },
  });
  return data;
}

export interface ImportBatchRow {
  id: number;
  source_name: string;
  status: string;
  row_count?: number;
  created_at?: string;
}

export async function listImportBatches(): Promise<{ items: ImportBatchRow[]; total: number }> {
  const { data } = await http.get<{ items: ImportBatchRow[]; total: number }>("/imports/batches");
  return data;
}

export interface SequenceRow {
  sequence_key: string;
  prefix: string;
  padding: number;
  current_value: number;
}

export async function listSequences(): Promise<SequenceRow[]> {
  const { data } = await http.get<SequenceRow[]>("/sequences");
  return data;
}

export interface OptionSetRow {
  id: number;
  code: string;
  label: string;
  group: string;
  editable: boolean;
  options: OptionItem[] | null;
  description?: string | null;
}

export async function listOptionSets(): Promise<OptionSetRow[]> {
  const { data } = await http.get<{ items: OptionSetRow[] }>("/option-sets");
  return data.items;
}

// ---------------------------------------------------------------- 客户写操作

export async function updateCustomer(id: number, payload: Record<string, unknown>): Promise<CustomerRow> {
  const { data } = await http.patch<CustomerRow>(`/customers/${id}`, payload);
  return data;
}

export async function setCustomerStatus(id: number, status: string): Promise<CustomerRow> {
  const { data } = await http.patch<CustomerRow>(`/customers/${id}/status`, { status });
  return data;
}

export async function mergeCustomer(
  id: number,
  targetCustomerId: number,
  reason: string,
): Promise<CustomerRow> {
  const { data } = await http.post<CustomerRow>(`/customers/${id}/merge`, {
    target_customer_id: targetCustomerId,
    reason,
  });
  return data;
}

export async function createCounterparty(payload: Record<string, unknown>): Promise<CounterpartyRow> {
  const { data } = await http.post<CounterpartyRow>("/counterparties", payload);
  return data;
}

export async function updateCounterparty(id: number, payload: Record<string, unknown>): Promise<CounterpartyRow> {
  const { data } = await http.patch<CounterpartyRow>(`/counterparties/${id}`, payload);
  return data;
}

export async function setCounterpartyActive(id: number, active: boolean): Promise<CounterpartyRow> {
  const { data } = await http.patch<CounterpartyRow>(`/counterparties/${id}/status`, { active });
  return data;
}

// ---------------------------------------------------------------- 订单执行明细
// 订单本身（GET /orders/{id}）不带事件；事件、流水、客户/合作方都在账号维度的
// 执行明细里（GET /stocks/{account_id}/execution-detail），一张账号可能挂着多张单。

export interface ExecutionEvent {
  id: number;
  event_no: string;
  event_type: string;
  amount: string;
  cancellable_amount: string;
  occurred_on: string;
  occurred_at?: string | null;
  pool_id?: number | null;
  offset_event_id?: number | null;
  portion: string;
  delivery_mode?: string | null;
  is_posted: boolean;
  note?: string | null;
  operator: string;
  cashflow?: {
    flow_no: string;
    pool_name?: string | null;
    direction: string;
    category: string;
    amount: string;
    note?: string | null;
  } | null;
}

export interface ExecutionOrder {
  order_id: number;
  order_no: string;
  order_type: string;
  trade_date: string;
  status: string;
  note?: string | null;
  cashflows?: {
    flow_no: string;
    pool_name?: string | null;
    occurred_on: string;
    direction: string;
    nature: string;
    category: string;
    amount: string;
    note?: string | null;
    operator: string;
  }[];
  customers?: { id: number; display_name: string; role: string }[];
  counterparties?: { id: number; display_name: string; role: string }[];
  events: ExecutionEvent[];
  operator: string;
}

export interface AccountExecutionDetail {
  account: Record<string, unknown> & { id: number; stock_no?: string | null; game_account?: string | null };
  orders: ExecutionOrder[];
  finance_summary: {
    cashflow_income: string;
    rebate_income: string;
    total_income: string;
    total_expense: string;
    net_amount: string;
  };
}

export async function fetchExecutionDetail(accountId: number): Promise<AccountExecutionDetail> {
  const { data } = await http.get<AccountExecutionDetail>(`/stocks/${accountId}/execution-detail`);
  return data;
}
