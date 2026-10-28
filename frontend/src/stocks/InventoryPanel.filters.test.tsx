import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../shared/api/catalog";
import { renderLight } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";
import { setupInventoryPanelMocks } from "./InventoryPanel.test.fixtures";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

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

describe("InventoryPanel：状态筛选", () => {
  it("按状态筛选时把 status 传给后端，而非前端过滤", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(document.querySelector(".ant-select-selector") as Element);
    const dropdowns = document.querySelectorAll(".ant-select-dropdown");
    const option = await waitFor(() => {
      const found = [...(dropdowns[dropdowns.length - 1] as HTMLElement).querySelectorAll(
        ".ant-select-item-option",
      )].find((o) => /在库/.test(o.getAttribute("title") ?? o.textContent ?? ""));
      if (!found) throw new Error("option not ready");
      return found as Element;
    });
    await ui.click(option);
    await waitFor(() =>
      expect(vi.mocked(catalog.stocksApi.list).mock.calls.some((c) => (c[0] as { status?: string })?.status === "IN_STOCK")).toBe(
        true,
      ),
    );

    await ui.click(document.querySelector(".ant-select-selector") as Element);
    const voidOption = await waitFor(() => {
      const found = [...(document.querySelectorAll(".ant-select-dropdown")[0] as HTMLElement).querySelectorAll(
        ".ant-select-item-option",
      )].find((o) => /下架/.test(o.getAttribute("title") ?? o.textContent ?? ""));
      if (!found) throw new Error("下架选项未准备好");
      return found as Element;
    });
    await ui.click(voidOption);
    await waitFor(() =>
      expect(vi.mocked(catalog.stocksApi.list).mock.calls.some((c) => (c[0] as { status?: string })?.status === "VOID")).toBe(true),
    );
  });
});
