import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../shared/api/catalog";
import { renderLight } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";
import { accounts, setupInventoryPanelMocks } from "./InventoryPanel.test.fixtures";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("../shared/api/catalog");

setupInventoryPanelMocks();

/** 账号台账「展开」的两条约束：同时只展开一行；写操作后执行明细必须重拉，不能停在写前快照。 */
describe("InventoryPanel：账号台账展开", () => {
  it("一次只展开一行：展开另一行时前一行自动收起", async () => {
    // 默认 fixture 只有 1 条在库账号，这里补到 2 条才能验证互斥。
    vi.mocked(catalog.stocksApi.list).mockResolvedValue([
      { ...accounts[0], id: 11, game_account: "acc-11" },
      { ...accounts[0], id: 12, game_account: "acc-12" },
    ]);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-11");

    const collapsedIcons = () => Array.from(document.querySelectorAll<HTMLElement>(".ant-table-row-expand-icon-collapsed"));
    expect(collapsedIcons()).toHaveLength(2);

    // 默认「最新在前」按 id 倒序，首行是 id=12。
    await ui.click(collapsedIcons()[0]);
    await screen.findByText("当前运营状态");
    expect(document.querySelectorAll(".inventory-detail")).toHaveLength(1);

    // 展开态互斥：此时仅剩的 collapsed 图标属于另一行。
    await ui.click(collapsedIcons()[0]);
    await waitFor(() => expect(document.querySelectorAll(".inventory-detail")).toHaveLength(1));

    const ownerKey = document.querySelector(".ant-table-expanded-row")?.previousElementSibling?.getAttribute("data-row-key");
    expect(ownerKey).toBe("11");
  });

  it("展开后登记返点：详情缓存失效并重新拉取执行明细", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");

    await ui.click(document.querySelector(".ant-table-row-expand-icon-collapsed") as HTMLElement);
    await screen.findByText("当前运营状态");
    const callsBeforeWrite = vi.mocked(catalog.stocksApi.executionDetail).mock.calls.length;
    expect(callsBeforeWrite).toBeGreaterThan(0);

    // 展开后「acc-1」同时出现在主表行与展开详情里，改用全局唯一的「返点」按钮，避免 getByText 多匹配。
    await ui.click(screen.getByRole("button", { name: "返点" }));
    await screen.findByText("登记返点");
    await ui.click(await screen.findByLabelText("卖号返点"));
    await ui.type(screen.getByLabelText("返点日期"), "2026-10-20");
    await ui.click(screen.getByRole("button", { name: "确认登记" }));

    await waitFor(() => expect(vi.mocked(catalog.rebatesApi.create)).toHaveBeenCalled());
    // 缓存若未失效，executionDetail 不会再被调用，展开区会停在写之前的快照。
    await waitFor(() =>
      expect(vi.mocked(catalog.stocksApi.executionDetail).mock.calls.length).toBeGreaterThan(callsBeforeWrite),
    );
  });

  it("收起后再展开同一行：命中缓存不重复请求", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");

    await ui.click(document.querySelector(".ant-table-row-expand-icon-collapsed") as HTMLElement);
    await screen.findByText("当前运营状态");
    const callsAfterFirstExpand = vi.mocked(catalog.stocksApi.executionDetail).mock.calls.length;

    await ui.click(document.querySelector(".ant-table-row-expand-icon-expanded") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".inventory-detail")).toBeNull());

    await ui.click(document.querySelector(".ant-table-row-expand-icon-collapsed") as HTMLElement);
    await screen.findByText("当前运营状态");
    expect(vi.mocked(catalog.stocksApi.executionDetail).mock.calls.length).toBe(callsAfterFirstExpand);
  });
});
