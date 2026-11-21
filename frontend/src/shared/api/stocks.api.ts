import { api } from "./client";
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
  }): Promise<{ blob: Blob; failedDetailCount: number }> => {
    const response = await api.get<Blob>("/stocks/inventory/ledger/export.csv", {
      params: { ...params, _t: Date.now() },
      paramsSerializer: { indexes: null },
      responseType: "blob",
    });
    return {
      blob: response.data,
      failedDetailCount: Number(response.headers["x-inventory-detail-failures"] ?? 0),
    };
  },
  /** 删除不可恢复：原因必填，由后端写入审计日志（仅管理员可调用）。 */
  remove: (id: number, reason: string) =>
    api.delete<void>(`/stocks/${id}`, { data: { reason } }).then(() => undefined),
};
