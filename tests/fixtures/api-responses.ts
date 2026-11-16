import type { PageResponse } from "@/shared/api/types/common";
import type { DataCenterSummary } from "@/shared/api/types/reporting";

export type OrderLedgerSummary = {
  total_count: number;
  status_counts: Record<string, number>;
  type_counts: Record<string, number>;
  game_types: string[];
};

export type ReportResponse<TItem, TTotal> = {
  items: TItem[];
  total: TTotal;
};

export type CommissionResponse<TGroup, TTotal> = {
  order_groups: TGroup[];
  total: TTotal;
};

export type ListResponse<T> = {
  items: T[];
  total: number;
};

export type CashflowTotals = {
  total_in: string;
  total_out: string;
};

export type CashflowPage<T> = {
  items: T[];
  total: number;
  total_in: string;
  total_out: string;
};

/** 构造完整分页响应，避免测试用例用数组冒充后端分页契约。 */
export function pageResponse<T>(items: T[], overrides: Partial<PageResponse<T>> = {}): PageResponse<T> {
  return {
    items,
    total: items.length,
    limit: 10,
    offset: 0,
    ...overrides,
  };
}

/** 构造经营报表响应，统一 items 与服务端汇总 total 的包裹结构。 */
export function reportResponse<TItem, TTotal>(items: TItem[], total: TTotal): ReportResponse<TItem, TTotal> {
  return { items, total };
}

/** 构造分润对账响应，统一订单汇总与分润合计的包裹结构。 */
export function commissionResponse<TGroup, TTotal>(orderGroups: TGroup[], total: TTotal): CommissionResponse<TGroup, TTotal> {
  return { order_groups: orderGroups, total };
}

/** 构造不带分页游标的列表响应，统一 items 与条目总数。 */
export function listResponse<T>(items: T[], total = items.length): ListResponse<T> {
  return { items, total };
}

/** 构造数据中心指标汇总，默认值与空数据状态一致。 */
export function dataCenterSummary(overrides: Partial<DataCenterSummary> = {}): DataCenterSummary {
  return {
    order_count: 0,
    active_order_count: 0,
    sold_cost: "0.00",
    in_transit_cost: "0.00",
    deposit_held: "0.00",
    studio_cost: "0.00",
    account_sale_profit: "0.00",
    studio_other_income: "0.00",
    profit: "0.00",
    ...overrides,
  };
}

/** 构造完整订单台账汇总，默认值与空列表状态一致。 */
export function orderLedgerSummary(overrides: Partial<OrderLedgerSummary> = {}): OrderLedgerSummary {
  return {
    total_count: 0,
    status_counts: {},
    type_counts: {},
    game_types: [],
    ...overrides,
  };
}

/** 构造完整资金流水汇总，金额始终使用后端字符串口径。 */
export function cashflowTotals(overrides: Partial<CashflowTotals> = {}): CashflowTotals {
  return {
    total_in: "0.00",
    total_out: "0.00",
    ...overrides,
  };
}

/** 构造资金流水分页响应，统一携带服务端聚合的收入/支出总额。 */
export function cashflowPage<T>(items: T[], overrides: Partial<Omit<CashflowPage<T>, "items" | "total">> & { total?: number } = {}): CashflowPage<T> {
  return {
    items,
    total: items.length,
    ...cashflowTotals(),
    ...overrides,
  };
}
