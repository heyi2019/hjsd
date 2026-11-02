import { api } from "./client";
import type { EventPostResult, FormScope, ListColumnConfig, ListCustomFieldOption, ListScopeConfig, Order, OrderFormField, OrderLink, OrderType, OrderTypeRoute, PageResponse, RouteImpactPreview, SearchResult } from "./types";

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

export const ordersApi = {
  // 自动翻页取全量：后端 GET /orders 默认 limit=100、max=500，调用方不传 limit 时
  // 只会取到前 100 单，导致订单列表/聚合缺失数据（dev 库 627 单只取 100 的数据完整性缺口）。
  // 仅在未显式传入 limit 时自动翻页（每页 500，最多 50 页=25k 上限防意外死循环）；
  // 显式传入 limit 时原样透传（用于只需少量数据的场景）。
  list: async (params?: {
    order_type?: string;
    status?: string;
    limit?: number;
    offset?: number;
    mine?: boolean;
  }): Promise<Order[]> => {
    if (params?.limit != null) {
      return api.get<PageResponse<Order>>("/orders", { params }).then((r) => r.data.items);
    }
    const all: Order[] = [];
    const PAGE = 500;
    for (let i = 0; i < 50; i++) {
      const page = await api.get<PageResponse<Order>>("/orders", {
        params: { ...params, limit: PAGE, offset: i * PAGE },
      }).then((r) => r.data.items);
      all.push(...page);
      if (page.length < PAGE) break;
    }
    return all;
  },
  exportCsv: () =>
    api
      .get<Blob>("/orders/export.csv", { params: { _t: Date.now() }, responseType: "blob" })
      .then((r) => r.data),
  /** 订单台账 Excel：两个 sheet —— 主订单信息（列表可见列）+ 详情信息（订单详情全字段）。 */
  exportXlsx: () =>
    api
      .get<Blob>("/orders/export.xlsx", { params: { _t: Date.now() }, responseType: "blob" })
      .then((r) => r.data),
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
  cancel: (orderId: number, payload: { reason: string; form_extra?: Record<string, unknown>; form_extra_scope?: string }) =>
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
      bound_phone_owner?: string;
      has_secondary?: boolean;
      wallet_realname?: string;
      purchase_price?: string;
      note?: string;
      extra_values?: Record<string, unknown>;
    };
    account_id?: number;
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
        wallet_realname?: string | null;
        platform?: string | null;
        purchase_price?: string | null;
        note?: string | null;
      } | null;
    },
  ) => api.patch<Order>(`/orders/${orderId}`, payload).then((r) => r.data),
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
    items: Array<Pick<ListColumnConfig, "key" | "is_visible" | "sort_order" | "width" | "fixed">>,
  ) =>
    api
      .put<ListScopeConfig>(`/list-columns/${scope}`, {
        items: items.map((item) => ({
          column_key: item.key,
          is_visible: item.is_visible,
          sort_order: item.sort_order,
          width: item.width ?? null,
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

export const searchApi = { query: (q: string) => api.get<{ items: SearchResult[] }>("/search", { params: { q } }).then(r => r.data) };
