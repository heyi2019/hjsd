import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");
import { renderLight } from "../../test/render";
import { PoolsPanel } from "./PoolsPanel";
import { resolveMock } from "../../test/mock-api";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});





const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.poolsApi).list.mockResolvedValue(pools);
  vi.mocked(catalog.policyApi).list.mockResolvedValue({ items: [], total: 0 });
  vi.mocked(catalog.policyApi).versions.mockResolvedValue({ items: [], total: 0 });
  vi.mocked(catalog.gameTypesApi).list.mockResolvedValue([
    { id: 1, name: "王者荣耀", sort_order: 10, is_active: true, is_default: true },
    { id: 2, name: "原神", sort_order: 20, is_active: true, is_default: false },
  ]);
});

describe("设置面板：资金池", () => {
  it("admin 可见新增资金池入口", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });
    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增资金池/ })).toBeInTheDocument();
  });

  it("viewer 无 pool.manage 时显示只读回退且无新增按钮", async () => {
    renderLight(<PoolsPanel />, { user: "viewer" });
    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(screen.getByText("当前角色无主数据维护权限。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新增资金池/ })).toBeNull();
  });

  it("admin 可编辑资金池名称、用途和归属", async () => {
    vi.mocked(catalog.poolsApi).update.mockResolvedValue({ ...pools[0], name: "新托管池" });
    renderLight(<PoolsPanel />, { user: "admin" });
    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /编辑/ }));
    const dialog = screen.getByRole("dialog", { name: /编辑资金池/ });
    const name = within(dialog).getAllByRole("textbox")[1];
    await ui.clear(name);
    await ui.type(name, "新托管池");
    await ui.click(within(dialog).getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(vi.mocked(catalog.poolsApi).update).toHaveBeenCalledWith(1, expect.objectContaining({ name: "新托管池", pool_type: "OTHER", ownership: "OWNED" })));
  });

});

describe("设置面板：游戏类型", () => {
  it("展示游戏类型并可勾选默认游戏类型", async () => {
    const { GameTypeSettingsPanel } = await import("./GameTypeSettingsPanel");
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    expect(await screen.findByText("王者荣耀")).toBeInTheDocument();
    await ui.click(screen.getByRole("checkbox", { name: "原神设为默认" }));

    await waitFor(() => expect(vi.mocked(catalog.gameTypesApi).setDefault).toHaveBeenCalledWith(2, true));
  });

  it("管理员可新增游戏类型", async () => {
    const { GameTypeSettingsPanel } = await import("./GameTypeSettingsPanel");
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    await screen.findByText("王者荣耀");
    await ui.type(screen.getByPlaceholderText("如：王者荣耀"), "和平精英");
    await ui.click(screen.getByRole("button", { name: /新增游戏类型/ }));

    await waitFor(() => expect(vi.mocked(catalog.gameTypesApi).create).toHaveBeenCalledWith({ name: "和平精英", sort_order: 0, channel_regions: [] }));
  });

  it("管理员可编辑游戏类型名称和排序", async () => {
    const { GameTypeSettingsPanel } = await import("./GameTypeSettingsPanel");
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    await screen.findByText("王者荣耀");
    await ui.click(screen.getByRole("button", { name: "编辑王者荣耀" }));
    await ui.clear(screen.getByPlaceholderText("如：王者荣耀"));
    await ui.type(screen.getByPlaceholderText("如：王者荣耀"), "王者荣耀手游");
    await ui.click(screen.getByRole("button", { name: /保存游戏类型/ }));

    await waitFor(() => expect(vi.mocked(catalog.gameTypesApi).update).toHaveBeenCalledWith(1, {
      name: "王者荣耀手游",
      sort_order: 10,
      channel_regions: [],
    }));
  });
});
