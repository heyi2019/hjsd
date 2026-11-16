import type { PageResponse } from "@/shared/api/types/common";
import type { InventoryStats } from "@/shared/api/types/accounts";
import type { PoolBalance, PoolBalanceTotals } from "@/shared/api/types/finance";
import type { InstallmentTotals } from "@/shared/api/types/installments";
import type { ProfitAllocation, ProfitAllocationList } from "@/shared/api/types/policy";
import type { DataCenterSummary } from "@/shared/api/types/reporting";
import type { DashboardSummary } from "@/shared/api/dashboard.api";
import type { Customer, CustomerDetail, CustomerSummary } from "@/shared/api/types/customers";
import type { OptionSet, OptionSetList } from "@/shared/api/types/common";

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

export type InventoryLedgerResponse<T> = {
  items: T[];
  total: number;
  facet_total: number;
  type_counts: Record<string, number>;
  game_types: string[];
  stats: InventoryStats;
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

export type PoolBalancesResponse = {
  items: PoolBalance[];
  totals: PoolBalanceTotals;
};

export type StudioExpenseSummary<T> = {
  items: T[];
  income: string;
  expense: string;
  net: string;
  count: number;
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

/** 构造订单分润配置响应，统一保留订单利润与按类型汇总。 */
export function profitAllocationResponse<T extends ProfitAllocation>(
  items: T[],
  overrides: Partial<Omit<ProfitAllocationList, "items" | "total">> & { total?: number } = {},
): ProfitAllocationList {
  return {
    items,
    total: items.length,
    order_profit: "0.00",
    totals_by_type: {},
    ...overrides,
  };
}

/** 构造库存台账响应，统一列表、筛选汇总与库存统计字段。 */
export function inventoryLedgerResponse<T>(
  items: T[],
  overrides: Partial<Omit<InventoryLedgerResponse<T>, "items" | "total">> & { total?: number } = {},
): InventoryLedgerResponse<T> {
  return {
    items,
    total: items.length,
    facet_total: items.length,
    type_counts: {},
    game_types: [],
    stats: { account_count: 0, occupied_cost: "0.00", over_7d_count: 0, over_30d_count: 0 },
    ...overrides,
  };
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

/** 构造资金池批量余额响应，汇总字段始终与服务端余额契约一起出现。 */
export function poolBalancesResponse(items: PoolBalance[], totals: PoolBalanceTotals): PoolBalancesResponse {
  return { items, totals };
}

/** 构造工作室收支摘要响应，统一携带明细、收入、支出、净额与条目数。 */
export function studioExpenseSummary<T>(items: T[], overrides: Partial<Omit<StudioExpenseSummary<T>, "items" | "count">> & { count?: number } = {}): StudioExpenseSummary<T> {
  return {
    items,
    income: "0.00",
    expense: "0.00",
    net: "0.00",
    count: items.length,
    ...overrides,
  };
}

/** 构造分期服务端汇总，默认值与空数据状态一致。 */
export function installmentTotals(overrides: Partial<InstallmentTotals> = {}): InstallmentTotals {
  return {
    total_receivable: "0.00",
    total_paid: "0.00",
    total_remaining: "0.00",
    total_count: 0,
    overdue_count: 0,
    ...overrides,
  };
}

/** 构造工作台汇总，默认值与空数据状态一致。 */
export function dashboardSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    period: { from: "2026-11-01", to: "2026-11-16" },
    orders: { total_count: 0, completed_count: 0, active_count: 0 },
    personal_orders: 0,
    personal_earnings: "0.00",
    inventory: { account_count: 0, aging_count: 0, overdue_count: 0 },
    installments: { total_count: 0, overdue_count: 0 },
    notifications: { pending_profit_count: 0, allocated_profit_count: 0 },
    reminders: { inventory_aging_days: 7, profit_notifications_enabled: true, overdue_installments_enabled: true },
    ...overrides,
  };
}

/** 构造客户中心统计，默认值与空数据状态一致。 */
export function customerSummary(overrides: Partial<CustomerSummary> = {}): CustomerSummary {
  return { month_count: 0, today_count: 0, ...overrides };
}

/** 构造客户详情聚合，默认值与空详情状态一致。 */
export function customerDetail(customer: Customer, overrides: Partial<Omit<CustomerDetail, "customer">> = {}): CustomerDetail {
  return {
    customer,
    overview: {
      order_count: 0,
      active_order_count: 0,
      completed_order_count: 0,
      cancelled_order_count: 0,
      last_trade_date: null,
      installment_paid_total: "0.00",
      installment_receivable_total: "0.00",
      installment_remaining_total: "0.00",
      overdue_period_count: 0,
    },
    business: [],
    installments: [],
    audit: [],
    ...overrides,
  };
}

/** 构造选项字典列表响应。 */
export function optionSetList(items: OptionSet[] = []): OptionSetList {
  return { items };
}

/** 构造选项字典详情响应，默认返回空选项集。 */
export function optionSet(overrides: Partial<OptionSet> = {}): OptionSet {
  return { id: 0, code: "", label: "", group: "", editable: true, options: [], ...overrides };
}
