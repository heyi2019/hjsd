import { api } from "./client";
import type { Account, AccountExecutionDetail, AccountInventoryRow, InventoryStats, PageResponse } from "./types";

export const stocksApi = {
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
  /** 汇总当前可见账号的占用成本与库龄档位（金额与天数只在后端算）。 */
  inventoryStats: (accountIds: number[]) =>
    api
      .post<InventoryStats>("/stocks/inventory/stats", { account_ids: accountIds })
      .then((r) => r.data),
  /** 删除账号不可恢复：原因必填，由后端写入审计日志（仅管理员可调用）。 */
  remove: (id: number, reason: string) =>
    api.delete<void>(`/stocks/${id}`, { data: { reason } }).then(() => undefined),
  executionDetail: (id: number) =>
    api.get<AccountExecutionDetail>(`/stocks/${id}/execution-detail`).then((r) => r.data),
  updateExecution: (id: number, payload: { profile: Partial<Account>; events: { id: number; expected_amount: string; amount: string; note: string | null; operator_user_ids?: number[] }[]; time_shift?: { delta_minutes: number }; time_set?: { registered_at?: string | null; sold_at?: string | null; flow_at?: string | null } }) =>
    api.patch<{ ok: boolean }>(`/stocks/${id}/execution-edit`, payload).then((r) => r.data),
};
