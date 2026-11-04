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

export async function fetchStock(id: number): Promise<StockRow> {
  const { data } = await http.get<StockRow>(`/stocks/${id}`);
  return data;
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
