import { api, type CacheAwareRequestConfig } from "./client";
import type { Account, InventoryStats } from "./types/accounts";
import type { Order } from "./types/orders";

export const stocksApi = {
  inventoryLedger: (params: {
    business_mode?: string;
    inventory_type?: string;
    game_type?: string;
    keyword?: string;
    date_from?: string;
    date_to?: string;
    inventory_operator_ids?: number[];
    age_gt_days?: number;
    sort_desc?: boolean;
    limit: number;
    offset: number;
  }) => api.get<{
    items: Array<{ account: Account; order: Order }>;
    total: number;
    facet_total: number;
    type_counts: Record<string, number>;
    game_types: string[];
    stats: InventoryStats;
  }>("/stocks/inventory/ledger", { params: { ...params, include_images: false }, paramsSerializer: { indexes: null } }).then((r) => r.data),
  inventoryLedgerExport: async (params: {
    business_mode?: string;
    inventory_type?: string;
    game_type?: string;
    keyword?: string;
    date_from?: string;
    date_to?: string;
    inventory_operator_ids?: number[];
    age_gt_days?: number;
    sort_desc?: boolean;
    mode?: "full" | "visible";
  }): Promise<{ blob: Blob; failedDetailCount: number }> => {
    const config: CacheAwareRequestConfig = {
      params,
      paramsSerializer: { indexes: null },
      responseType: "blob",
      bypassCache: true,
      timeout: 120_000,
    };
    const response = await api.get<Blob>("/stocks/inventory/ledger/export.csv", config);
    return {
      blob: response.data,
      failedDetailCount: Number(response.headers["x-inventory-detail-failures"] ?? 0),
    };
  },
};
