import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import type { Account } from "@/shared/api/types/accounts";
import { filterInventoryRows } from "@/stocks/InventoryPanel/helpers";

const row = (overrides: Partial<Account> = {}) => ({
  id: 1,
  status: "WAITING",
  business_mode: "SELF",
  inventory_type: "RECOVERY",
  game_type: "原神",
  game_account: "alpha",
  inventory_entry_at: "2026-10-01T09:00:00",
  ...overrides,
} as Account);

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
