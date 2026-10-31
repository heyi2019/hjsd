import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import * as catalog from "../shared/api/catalog";
import { renderLight } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";
import { stockNoAccounts, setupInventoryPanelMocks } from "./InventoryPanel.test.fixtures";
import { buildInventoryCsv } from "./inventory-export";

vi.mock("../shared/api/catalog");

setupInventoryPanelMocks();

// 覆盖共享 mock：本文件使用含 DG 代挂衍生账号的 stockNoAccounts。
beforeEach(() => {
  vi.mocked(catalog.stocksApi.list).mockResolvedValue(stockNoAccounts as never);
});

describe("InventoryPanel：库存编号（KU 编码）", () => {
  // 表格按 id 倒序，KU_00004(id=4) 为首个数据行，作为等待锚点最稳。
  it("台账首列库存编号展示账号的 stock_no（KU+4位）", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("KU_00004");

    const rows = screen.getAllByRole("row");
    const first = within(rows[1]);
    expect(first.getByText("KU_00004")).toBeInTheDocument();
    // 首列库存编号应排在订单号之前
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.indexOf("库存编号")).toBeLessThan(headers.indexOf("订单号"));
  });

  it("游戏账号独立成列，展示 game_account 而非库存编号", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-4");
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("acc-4")).toBeInTheDocument();
    // 同表内其他账号的游戏账号也正确
    expect(screen.getByText("acc-1")).toBeInTheDocument();
  });

  it("不同业务类型的库存账号均显示各自 stock_no（含 DG/TH 衍生）", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("KU_00004");
    // 库存中心只展示仍在库的 HS 回收 / DG 代挂 / TH 提号账号
    expect(screen.getByText("KU_00001")).toBeInTheDocument();
    expect(screen.getByText("KU_00003")).toBeInTheDocument();
    expect(screen.getByText("KU_00004")).toBeInTheDocument();
    expect(screen.queryByText("KU_00002")).toBeNull();
  });

  it("导出 CSV 的库存编号列取自 stock_no（含 DG/TH 衍生）", () => {
    const csv = buildInventoryCsv(stockNoAccounts);
    expect(csv).toContain("KU_00003");
    expect(csv).toContain("KU_00004");
  });
});
