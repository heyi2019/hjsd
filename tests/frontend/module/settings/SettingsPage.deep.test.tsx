import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gameTypesApi } from "@/shared/api/misc.api";
import { orderTypesApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";
import { auditApi } from "@/shared/api/reports.api";
import type { Pool } from "@/shared/api/types/finance";
import type { OrderType } from "@/shared/api/types/orders";
vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;
import * as client from "@/shared/api/client";
import { renderLight, renderApp } from "@fixtures/render";
import { SettingsPage } from "@/settings/SettingsPage";
import { listResponse } from "@fixtures/api-responses";

let ui: ReturnType<typeof userEvent.setup>;

const orderTypes = [
  { id: 1, code: "HS", name: "回收", is_active: true },
] as unknown as import("@/shared/api/types/orders").OrderType[];

const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", status: "ACTIVE" },
] as unknown as import("@/shared/api/types/finance").Pool[];

// 复用现有 SettingsPage.test 的 client 桩，避免挂载面板时真实网络请求。
vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
}));

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(orderTypesApi.list).mockResolvedValue(orderTypes);
  vi.mocked(poolsApi.list).mockResolvedValue(pools);
  vi.mocked(gameTypesApi.list).mockResolvedValue([]);
  vi.mocked(auditApi.list).mockResolvedValue(listResponse([]));
  vi.mocked(auditApi.actions).mockResolvedValue([]);
  vi.mocked(client.api).get.mockResolvedValue({ data: [] });
  // 默认非紧凑：matchMedia 对任何查询返回 matches=false（与 setup.ts afterEach 一致）。
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

/** 进入配置中心并等待其渲染。 */
async function openConfigCenter() {
  await ui.click(screen.getByRole("tab", { name: "配置中心" }));
  await screen.findByTestId("center-nav-order-types");
}

describe("SettingsPage.deep", () => {
  it("管理员可在设置中找到订单导入入口，人员和团队合并", async () => {
    renderLight(<SettingsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "业务字典" });
    expect(screen.getByRole("tab", { name: "订单导入" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "经营规则" })).toBeNull();
    expect(screen.getByRole("tab", { name: "人员与团队" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "人员与权限" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "团队管理" })).toBeNull();
    expect(screen.getByRole("tab", { name: "审计记录" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "改动追溯" })).toBeNull();
    // 配置中心为聚合入口
    expect(screen.getByRole("tab", { name: "配置中心" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "外观" })).toBeInTheDocument();
    // 原独立业务配置页签已移除
    expect(screen.queryByRole("tab", { name: "业务类型" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "游戏与渠道" })).toBeNull();
  });

  it("设置页的审计记录页签挂载完整审计流水", async () => {
    renderLight(<SettingsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "业务字典" });
    await ui.click(screen.getByRole("tab", { name: "审计记录" }));
    expect((await screen.findAllByText("审计记录")).length).toBeGreaterThan(1);
    expect(document.querySelector(".audit-config-item-select")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("对象编号")).toBeInTheDocument();
  });

  it("查看人(viewer)屏蔽 user.manage 条件 Tab，配置中心仍可见", async () => {
    renderLight(<SettingsPage />, { user: "viewer" });
    await screen.findByRole("tab", { name: "业务字典" });
    expect(screen.queryByRole("tab", { name: "订单导入" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "人员与权限" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "团队管理" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "人员与团队" })).toBeNull();
    // 配置中心（含无权限字段/主数据项）仍可作为入口
    expect(screen.getByRole("tab", { name: "配置中心" })).toBeInTheDocument();
  });

  it("紧凑屏宽下 tabPosition 切换为 top（ant-tabs-top）", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 960px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const { container } = renderLight(<SettingsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "业务字典" });
    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 960px)");
    expect(container.querySelector(".ant-tabs-top")).not.toBeNull();
    expect(container.querySelector(".ant-tabs-left")).toBeNull();
  });

  it("默认屏宽下 tabPosition 为 left（ant-tabs-left）", async () => {
    const { container } = renderLight(<SettingsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "业务字典" });
    expect(container.querySelector(".ant-tabs-left")).not.toBeNull();
    expect(container.querySelector(".ant-tabs-top")).toBeNull();
  });


  it("切换 Tab 仅挂载激活面板：配置中心内点资金账户触发 PoolsPanel 挂载（poolsApi.list 被调用）", async () => {
    renderLight(<SettingsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "业务字典" });
    await openConfigCenter();
    // 惰性挂载的证据是「面板内容不在 DOM」。
    expect(screen.queryByText("托管池")).toBeNull();
    await ui.click(screen.getByTestId("center-nav-pools"));
    await waitFor(() => expect(vi.mocked(poolsApi.list)).toHaveBeenCalled());
    // 资金账户内容可见（托管池）
    expect(await screen.findByText("托管池")).toBeInTheDocument();
  });

  it("配置中心内可遍历业务类型与游戏类型，设置页仍可打开外观", async () => {
    // AppearancePanel 依赖 GlassProvider，需走 renderApp（含 AllProviders）。
    renderApp(<SettingsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "业务字典" });

    await openConfigCenter();
    await ui.click(screen.getByTestId("center-nav-order-types"));
    expect(await screen.findByText("HS")).toBeInTheDocument();

    await ui.click(screen.getByTestId("center-nav-game-types"));
    await waitFor(() => expect(vi.mocked(gameTypesApi.list)).toHaveBeenCalled());

    await ui.click(screen.getByRole("tab", { name: "外观" }));
    expect(await screen.findByText("玻璃材质透明度")).toBeInTheDocument();
  });
});
