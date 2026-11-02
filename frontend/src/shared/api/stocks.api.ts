import { api } from "./client";
import type { Account, AccountExecutionDetail, AccountInventoryRow, PageResponse } from "./types";

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
  executionDetail: (id: number) =>
    api.get<AccountExecutionDetail>(`/stocks/${id}/execution-detail`).then((r) => r.data),
  updateExecution: (id: number, payload: { profile: Partial<Account>; events: { id: number; expected_amount: string; amount: string; note: string | null; operator_user_ids?: number[] }[] }) =>
    api.patch<{ ok: boolean }>(`/stocks/${id}/execution-edit`, payload).then((r) => r.data),
};
