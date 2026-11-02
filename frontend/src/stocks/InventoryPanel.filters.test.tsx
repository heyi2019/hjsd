import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../shared/api/catalog";
import { renderLight } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";
import { setupInventoryPanelMocks } from "./InventoryPanel.test.fixtures";

vi.mock("../shared/api/catalog");

setupInventoryPanelMocks();

describe("InventoryPanel：职责边界", () => {
  it("库存中心不提供新增账号入口", async () => {
    renderLight(<InventoryPanel />, { user: "viewer" });
    await screen.findByText("acc-1");
    expect(screen.queryByText("新增账号")).toBeNull();
    expect(screen.queryByRole("button", { name: /建\s*档/ })).toBeNull();
  });
});

describe("InventoryPanel：状态边界", () => {
  it("固定只向库存接口请求在库账号，不提供跨状态筛选", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await waitFor(() =>
      expect(vi.mocked(catalog.stocksApi.list).mock.calls.some((c) => (c[0] as { status?: string })?.status === "WAITING")).toBe(true),
    );
    expect(screen.queryByPlaceholderText("按状态筛选")).toBeNull();
  });
});

describe("InventoryPanel：卡片指标的取数口径", () => {
  it("汇总只带当前可见账号：筛选收窄后重新请求，清空后回到空集合", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    // 初次加载：accounts 里只有 acc-1 在库（acc-2 已售）。
    await waitFor(() => expect(vi.mocked(catalog.stocksApi.inventoryStats)).toHaveBeenLastCalledWith([1]));

    const search = screen.getByPlaceholderText("搜索游戏账号/产品 / 游戏/产品类型 / 平台");
    await ui.type(search, "acc-1");
    await waitFor(() => expect(vi.mocked(catalog.stocksApi.inventoryStats)).toHaveBeenLastCalledWith([1]));

    // 搜不到任何行时集合为空：后端据此返回全 0，前端不做本地求和。
    await ui.clear(search);
    await ui.type(search, "none-match");
    await waitFor(() => expect(vi.mocked(catalog.stocksApi.inventoryStats)).toHaveBeenLastCalledWith([]));
  });
});
