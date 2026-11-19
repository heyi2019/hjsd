import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import type { Account } from "@/shared/api/types/accounts";
import type { InventoryOrderRow } from "@/business/stocks/InventoryPanel/types";
import { filterInventoryRows } from "@/business/stocks/InventoryPanel/helpers";

const row = (overrides: {
  id?: number;
  status?: string;
  business_mode?: string;
  inventory_type?: string;
  game_type?: string;
  game_account?: string;
} = {}): InventoryOrderRow => {
  const account = {
    id: overrides.id ?? 1,
    status: overrides.status ?? "WAITING",
    business_mode: overrides.business_mode ?? "SELF",
    inventory_type: overrides.inventory_type ?? "RECOVERY",
    game_type: overrides.game_type ?? "原神",
    game_account: overrides.game_account ?? "alpha",
    inventory_entry_at: "2026-10-01T09:00:00",
  } as Account;
  return {
    id: account.id,
    order_no: "HS-1",
    order_type: "HS",
    trade_date: "2026-10-01",
    status: "ACTIVE",
    account_status: account.status,
    account_business_mode: account.business_mode,
    account_game_type: account.game_type,
    account_game_account: account.game_account,
    account_channel_region: null,
    inventory_entry_at: account.inventory_entry_at,
    inventory_type: account.inventory_type,
    account,
  } as InventoryOrderRow;
};

describe("filterInventoryRows", () => {
  it("一次完成状态、业务、关键词和日期筛选", () => {
    const rows = [
      row(),
      row({ id: 2, game_account: "beta", business_mode: "DISTRIBUTION" }),
      row({ id: 3, status: "SOLD", game_account: "alpha-old" }),
    ];

    expect(filterInventoryRows(rows, {
      businessMode: "SELF",
      keyword: "ALP",
      dateRange: [dayjs("2026-10-01"), dayjs("2026-10-01")],
    }).map((item) => item.id)).toEqual([1]);
  });

  it("空筛选只保留仍在库账号，并支持库存类型与游戏类型", () => {
    const rows = [row(), row({ id: 2, inventory_type: "PICKUP", game_type: "王者荣耀" })];
    expect(filterInventoryRows(rows, { inventoryType: "PICKUP", gameType: "王者荣耀" }).map((item) => item.id)).toEqual([2]);
  });
});
