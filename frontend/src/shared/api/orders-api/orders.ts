import { api, type CacheAwareRequestConfig } from "../client";
import { idempotencyConfig } from "../idempotency";
import type { PageResponse } from "../types/common";
import type { EventPostResult } from "../types/order-events";
import type { Order } from "../types/orders";
import type { AccountExecutionDetail } from "../types/account-execution";

export interface OrderListParams {
  order_type?: string;
  status?: string;
  trade_date_from?: string;
  trade_date_to?: string;
  business_mode?: string;
  game_type?: string;
  account_status?: string;
  keyword?: string;
  inventory_operator_ids?: number[];
  sale_operator_ids?: number[];
  sort_desc?: boolean;
  mine?: boolean;
  limit?: number;
  offset?: number;
}

type OrderExportParams = Omit<OrderListParams, "limit" | "offset">;

export type OrderExecutionEditPayload = {
  profile: object;
  expected_profile?: Record<string, unknown>;
  events: { id: number; expected_amount: string; amount: string; note: string | null; occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }[];
  new_events?: { operation_type: "IMAGE" | "DESCRIPTION" | "CONSIGNMENT" | "UNLIST"; occurred_at: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[]; note?: string }[];
  cashflows?: { flow_no: string; amount?: string; pool_id?: number; occurred_at?: string; note?: string | null; operator_user_ids?: number[] }[];
  orders?: { order_id: number; expected?: Record<string, unknown>; occurred_at?: string; note?: string | null; form_extra?: Record<string, unknown> }[];
  parties?: { order_id: number; entity_type: "customer" | "counterparty"; entity_id: number; role: string; operation?: "add" | "remove" }[];
};

export type SaleCustomerInput = {
  display_name: string;
  role: "BUYER" | "CONSIGNOR";
  contact_name?: string;
  phone?: string;
  wechat?: string;
  qq?: string;
  source?: string;
  note?: string;
};

export const ordersApi = {
  stockSale: (orderId: number, payload: {
    amount: string; occurred_on: string; pool_id?: number; operator_user_ids?: number[];
    note?: string; bound_phone?: string; bound_phone_owner?: string; sale_amount?: string;
    customer_input?: SaleCustomerInput; delivery_form_extra?: Record<string, unknown>; form_extra?: Record<string, unknown>;
  }, key?: string) => api.post<EventPostResult>(`/orders/${orderId}/stock-sale`, payload, idempotencyConfig(key)).then((r) => r.data),
  ledgerSummary: (params?: {
    mine?: boolean;
    trade_date_from?: string;
    trade_date_to?: string;
    order_type?: string;
    business_mode?: string;
    game_type?: string;
    account_status?: string;
    keyword?: string;
    inventory_operator_ids?: number[];
    sale_operator_ids?: number[];
  }) => api.get<{
    total_count: number;
    in_progress_count: number;
    completed_count: number;
    cancelled_count: number;
    type_total: number;
    status_counts: Record<string, number>;
    type_counts: Record<string, number>;
    game_types: string[];
  }>("/orders/ledger-summary", { params, paramsSerializer: { indexes: null } }).then((r) => r.data),
  listPage: (params?: OrderListParams) =>
    api.get<PageResponse<Order>>("/orders", { params, paramsSerializer: { indexes: null } }).then((r) => r.data),
  /** 导出按当前筛选取全部匹配订单，不受页面大小影响。 */
  exportCsv: (params?: OrderExportParams) =>
    api
      .get<Blob>("/orders/export.csv", { params: { ...params, _t: Date.now() }, paramsSerializer: { indexes: null }, responseType: "blob" })
      .then((r) => r.data),
  /** 订单台账 Excel：两个 sheet —— 主订单信息（列表可见列）+ 详情信息（订单详情全字段）。 */
  exportXlsx: (params?: OrderExportParams) =>
    api
      .get<Blob>("/orders/export.xlsx", { params: { ...params, _t: Date.now() }, paramsSerializer: { indexes: null }, responseType: "blob" })
      .then((r) => r.data),
  get: (orderId: number, options?: { fresh?: boolean }) =>
    api.get<Order>(`/orders/${orderId}`, options?.fresh ? { refreshCache: true } as CacheAwareRequestConfig : undefined).then((r) => r.data),
  executionDetail: (orderId: number, options?: { fresh?: boolean; imagePreviews?: boolean }) =>
    api.get<AccountExecutionDetail>(`/orders/${orderId}/execution-detail`, options ? {
      ...(options.fresh ? { refreshCache: true } : {}),
      ...(options.imagePreviews ? { params: { image_previews: true } } : {}),
    } as CacheAwareRequestConfig : undefined).then((r) => r.data),
  executionImage: (orderId: number, field: "secondary_images" | "wallet_realname_images" | "account_images", index: number, version?: string) =>
    api.get<{ image: string }>(`/orders/${orderId}/execution-images/${field}/${index}`, { refreshCache: true, params: { version } } as CacheAwareRequestConfig).then((r) => r.data.image),
  updateExecution: (orderId: number, payload: OrderExecutionEditPayload) =>
    api.patch<{ ok: boolean }>(`/orders/${orderId}/execution-edit`, payload).then((r) => r.data),
  cancel: (orderId: number, payload: { reason: string; form_extra?: Record<string, unknown>; form_extra_scope?: string }) =>
    api.post<Order>(`/orders/${orderId}/cancel`, payload).then((r) => r.data),
  inventoryOffsale: (orderId: number, payload: {
    reason: string; occurred_on: string; unlisted_at: string; operator_user_ids?: number[];
    form_extra?: Record<string, unknown>; amount?: string; pool_id?: number; portion?: string; offset_event_id?: number;
  }) => api.post<{ ok: boolean }>(`/orders/${orderId}/inventory-offsale`, payload).then((r) => r.data),
  create: (payload: {
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
      secondary_images?: string[];
      wallet_realname?: string;
      wallet_realname_images?: string[];
      purchase_price?: string;
      note?: string;
      extra_values?: Record<string, unknown>;
    };
    account_id?: number;
    /** 后端判重：同账号已有「已售出」记录时，用户确认复购回流后置 true 放行。 */
    confirm_repurchase?: boolean;
    owner_id?: number;
    note?: string;
    form_extra?: Record<string, unknown>;
    form_extra_scope?: string;
    customer_roles?: { customer_id: number; role: string }[];
    counterparty_roles?: { counterparty_id: number; role: string }[];
    /** 建单客户草稿：后端在订单事务内按昵称和联系方式复用或新建。 */
    customer_input?: {
      display_name: string;
      role: string;
      contact_name?: string;
      phone?: string;
      wechat?: string;
      qq?: string;
      source?: string;
      note?: string;
    };
    /** 建单供货方草稿：后端在订单事务内按昵称和类型复用或新建。 */
    counterparty_input?: {
      display_name: string;
      type: string;
      role: string;
      contact_name?: string;
      phone?: string;
      wechat?: string;
      qq?: string;
      note?: string;
    };
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
      note?: string;
      schedule?: { period_no: number; due_on: string }[];
    };
  }) => api.post<Order>("/orders", payload).then((r) => r.data),
  postEvent: (
    orderId: number,
    payload: {
      event_type: string;
      finalize_sale_cancel?: boolean;
      sale_mode?: "FULL" | "INSTALLMENT";
      operation_type?: "IMAGE" | "DESCRIPTION" | "CONSIGNMENT" | "UNLIST";
      rebate_type?: "BUY" | "SELL";
      amount?: string;
      occurred_on: string;
      pool_id?: number;
      portion?: string;
      delivery_direction?: "BUY" | "SELL";
      offset_event_id?: number;
      reason?: string;
      operator_user_ids?: number[];
      note?: string;
      bound_phone?: string;
      bound_phone_owner?: string;
      form_extra_scope?: string;
      form_extra?: Record<string, unknown>;
    },
    key?: string,
  ) => api.post<EventPostResult>(`/orders/${orderId}/events`, payload, idempotencyConfig(key)).then((r) => r.data),
};
