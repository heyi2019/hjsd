import type { PageResponse } from "@/shared/api/types/common";

export type OrderLedgerSummary = {
  total_count: number;
  status_counts: Record<string, number>;
  type_counts: Record<string, number>;
  game_types: string[];
};

export type CashflowTotals = {
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
