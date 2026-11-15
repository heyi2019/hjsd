import { api } from "./client";
import type { Account, AccountInventoryRow, InventoryStats } from "./types/accounts";
import type { Order } from "./types/orders";
import type { PageResponse } from "./types/common";

export const stocksApi = {
  dashboardSummary: (reminderDays: number) =>
    api
      .get<{ account_count: number; aging_count: number; overdue_count: number }>("/stocks/dashboard-summary", {
        params: { reminder_days: reminderDays },
      })
      .then((r) => r.data),
  list: async (params?: { status?: string; limit?: number; offset?: number }): Promise<Account[]> => {
    if (params?.limit != null) {
      return api.get<PageResponse<Account>>("/stocks", { params }).then((r) => r.data.items);
    }
    const all: Account[] = [];
    const PAGE = 500;
    for (let i = 0; i < 50; i++) {
      const page = await api.get<PageResponse<Account>>("/stocks", {
        params: { ...params, limit: PAGE, offset: i * PAGE },
      }).then((r) => r.data.items);
      all.push(...page);
      if (page.length < PAGE) break;
    }
    return all;
  },
  updateProfile: (id: number, payload: Partial<Pick<Account, "game_account" | "game_type" | "game_password" | "camp_account" | "channel_region" | "bound_phone" | "has_secondary" | "secondary_images" | "wallet_realname" | "wallet_realname_images" | "platform" | "note" | "account_description" | "account_images">> & { form_extra?: Record<string, unknown> }) =>
    api.patch<Account>(`/stocks/${id}`, payload).then((r) => r.data),
  inventory: () =>
    api
      .get<{ items: AccountInventoryRow[]; count: number; total_cost: string }>("/stocks/inventory")
      .then((r) => r.data),
  inventoryCostSummary: (params?: { entry_date_from?: string; entry_date_to?: string }) =>
    api
      .get<{ total_cost: string }>("/stocks/inventory/cost-summary", { params })
      .then((r) => r.data),
  /** 汇总当前可见账号的占用成本与库龄档位（金额与天数只在后端算）。 */
  inventoryStats: (accountIds: number[]) =>
    api
      .post<InventoryStats>("/stocks/inventory/stats", { account_ids: accountIds })
      .then((r) => r.data),
  inventoryLedger: (params: {
    business_mode?: string;
    inventory_type?: string;
    game_type?: string;
    keyword?: string;
    date_from?: string;
    date_to?: string;
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
  }>("/stocks/inventory/ledger", { params }).then((r) => r.data),
  /** 删除不可恢复：原因必填，由后端写入审计日志（仅管理员可调用）。 */
  remove: (id: number, reason: string) =>
    api.delete<void>(`/stocks/${id}`, { data: { reason } }).then(() => undefined),
};
