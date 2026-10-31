import { screen, waitFor } from "@testing-library/react";
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
