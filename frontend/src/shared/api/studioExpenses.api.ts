import { api } from "./client";
import type { Cashflow } from "./types/finance";

export const studioExpensesApi = {
  /** 工作室收支明细与汇总由服务端按统一口径一次返回。 */
  summary: (params?: {
    pool_ids?: string;
    occurred_from?: string;
    occurred_to?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }) =>
    api
      .get<{
        items: Cashflow[];
        income: string;
        expense: string;
        net: string;
        count: number;
      }>("/cashflows/studio-summary", { params })
      .then((r) => r.data),
};
