import { api } from "./client";
import type { PageResponse } from "./types/common";
import type { FormScope, ListColumnConfig, ListCustomFieldOption, ListScopeConfig, OrderFormField } from "./types/forms";
import type { EventPostResult, OrderLink } from "./types/order-events";
import type { Order, OrderType, OrderTypeRoute } from "./types/orders";
import type { RouteImpactPreview } from "./types/policy";
import type { AccountExecutionDetail } from "./types/account-execution";

export interface OrderListParams {
  order_type?: string;
  status?: string;
  trade_date_from?: string;
  trade_date_to?: string;
  business_mode?: string;
  game_type?: string;
  account_status?: string;
  keyword?: string;
  sort_desc?: boolean;
  mine?: boolean;
  limit?: number;
  offset?: number;
}

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
/** 订单编辑入参（PATCH /orders/{id}）：未传字段保持原值，显式 null 清空可空字段。 */
export interface OrderPatchPayload {
  trade_date?: string;
  form_extra?: Record<string, unknown>;
  note?: string | null;
  account_snapshot?: {
    game_account: string;
    game_type?: string | null;
    game_password?: string | null;
    camp_account?: string | null;
    channel_region?: string | null;
    bound_phone?: string | null;
    has_secondary?: boolean | null;
    wallet_realname?: string | null;
    platform?: string | null;
    purchase_price?: string | null;
    note?: string | null;
  } | null;
}

export type OrderExecutionEditPayload = {
  profile: object;
  events: { id: number; expected_amount: string; amount: string; note: string | null; occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }[];
  new_events?: { operation_type: "IMAGE" | "DESCRIPTION" | "CONSIGNMENT" | "UNLIST"; occurred_at: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }[];
  cashflows?: { flow_no: string; occurred_at?: string; note?: string | null; operator_user_ids?: number[] }[];
  orders?: { order_id: number; occurred_at?: string; note?: string | null; form_extra?: Record<string, unknown> }[];
  parties?: { order_id: number; entity_type: "customer" | "counterparty"; entity_id: number; role: string; operation?: "add" | "remove" }[];
};

export const ordersApi = {
  ledgerSummary: (params?: {
    mine?: boolean;
    trade_date_from?: string;
    trade_date_to?: string;
    order_type?: string;
    business_mode?: string;
    game_type?: string;
    account_status?: string;
    keyword?: string;
  }) => api.get<{
    total_count: number;
    status_counts: Record<string, number>;
    type_counts: Record<string, number>;
    game_types: string[];
  }>("/orders/ledger-summary", { params }).then((r) => r.data),
  listPage: (params?: OrderListParams) =>
    api.get<PageResponse<Order>>("/orders", { params }).then((r) => r.data),
  /** 导出必须与当前视图同口径：「我的订单」视图传 mine=true，由后端按 operator_user_ids 过滤。 */
  exportCsv: (params?: { mine?: boolean }) =>
    api
      .get<Blob>("/orders/export.csv", { params: { ...params, _t: Date.now() }, responseType: "blob" })
      .then((r) => r.data),
  /** 订单台账 Excel：两个 sheet —— 主订单信息（列表可见列）+ 详情信息（订单详情全字段）。 */
  exportXlsx: (params?: { mine?: boolean }) =>
    api
      .get<Blob>("/orders/export.xlsx", { params: { ...params, _t: Date.now() }, responseType: "blob" })
      .then((r) => r.data),
  get: (orderId: number) =>
    api.get<Order>(`/orders/${orderId}`).then((r) => r.data),
  executionDetail: (orderId: number) =>
    api.get<AccountExecutionDetail>(`/orders/${orderId}/execution-detail`).then((r) => r.data),
  updateExecution: (orderId: number, payload: OrderExecutionEditPayload) =>
    api.patch<{ ok: boolean }>(`/orders/${orderId}/execution-edit`, payload).then((r) => r.data),
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
  cancel: (orderId: number, payload: { reason: string; form_extra?: Record<string, unknown>; form_extra_scope?: string }) =>
    api.post<Order>(`/orders/${orderId}/cancel`, payload).then((r) => r.data),
  deleteOrder: (orderId: number, reason: string) =>
    api.delete<void>(`/orders/${orderId}`, { data: { reason } }).then((r) => r.data),
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
    capital_type?: string;
    note?: string;
    /** 佣金口径：仅 DG 代挂单可用，两者必须同时填写或同时留空。 */
    commission_mode?: string;
    commission_payer?: string;
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
      delivery_mode?: string;
      note?: string;
      schedule?: { period_no: number; due_on: string }[];
    };
  }) => api.post<Order>("/orders", payload).then((r) => r.data),
  postEvent: (
    orderId: number,
    payload: {
      event_type: string;
      sale_mode?: "FULL" | "INSTALLMENT";
      operation_type?: "IMAGE" | "DESCRIPTION" | "CONSIGNMENT" | "UNLIST";
      rebate_type?: "BUY" | "SELL";
      amount?: string;
      occurred_on: string;
      pool_id?: number;
      portion?: string;
      delivery_mode?: string;
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
  ) => api.post<EventPostResult>(`/orders/${orderId}/events`, payload).then((r) => r.data),
  /** 向已有订单追加客户角色（库存售出时把买家挂到来源单，不新建订单）。 */
  addCustomerRole: (
    orderId: number,
    payload: { customer_id: number; role: string },
  ) => api.post<Order>(`/orders/${orderId}/customer-roles`, payload).then((r) => r.data),
  /** 订单编辑（PATCH /orders/{id}）：未传字段保持原值，显式 null 清空可空字段。 */
  patch: (orderId: number, payload: OrderPatchPayload) =>
    api.patch<Order>(`/orders/${orderId}`, payload).then((r) => r.data),
};

export const orderFormFieldsApi = {
  /** 表单作用域注册表（后端单一事实源）。 */
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
  /** 拉取某业务类型的板块标题覆盖映射（section_key -> 显示标题）。 */
  listSectionLabels: (orderTypeCode: string) =>
    api
      .get<Record<string, string>>("/order-form-fields/section-labels", {
        params: { order_type_code: orderTypeCode },
      })
      .then((r) => r.data),
  /** 保存某业务类型的板块标题覆盖映射（section_key -> 显示标题；空串=恢复默认）。 */
  saveSectionLabels: (payload: { order_type_code: string; labels: Record<string, string> }) =>
    api
      .put<Record<string, string>>("/order-form-fields/section-labels", payload)
      .then((r) => r.data),
};

export const listColumnsApi = {
  all: () => api.get<ListScopeConfig[]>("/list-columns").then((r) => r.data),
  save: (
    scope: string,
    items: Array<Pick<ListColumnConfig, "key" | "is_visible" | "sort_order" | "fixed">>,
  ) =>
    api
      .put<ListScopeConfig>(`/list-columns/${scope}`, {
        items: items.map((item) => ({
          column_key: item.key,
          is_visible: item.is_visible,
          sort_order: item.sort_order,
          fixed: item.fixed ?? null,
        })),
      })
      .then((r) => r.data),
  /** 恢复默认：清空该列表的显示配置；自定义列定义保留，需单独删除。 */
  reset: (scope: string) =>
    api.delete<ListScopeConfig>(`/list-columns/${scope}`).then((r) => r.data),
  /** 可新增为自定义列的表单自定义字段（按作用域标注）。 */
  customFields: () =>
    api.get<ListCustomFieldOption[]>("/list-columns/custom-fields").then((r) => r.data),
  /** 新增一列；label 省略则沿用字段标签。 */
  addCustom: (scope: string, fieldKey: string, label?: string) =>
    api
      .post<ListScopeConfig>(`/list-columns/${scope}/custom`, {
        field_key: fieldKey,
        label: label?.trim() || null,
      })
      .then((r) => r.data),
  /** 删除自定义列定义及其显示配置。 */
  removeCustom: (scope: string, columnKey: string) =>
    api
      .delete<ListScopeConfig>(
        `/list-columns/${scope}/custom/${encodeURIComponent(columnKey)}`,
      )
      .then((r) => r.data),
};
