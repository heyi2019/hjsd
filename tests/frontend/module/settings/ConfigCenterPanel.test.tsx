import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "@/shared/api/catalog";
vi.mock("@/shared/api/catalog");
import * as client from "@/shared/api/client";
vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
}));
import { renderLight } from "@fixtures/render";
import { ConfigCenterPanel } from "@/field-definitions/panels/ConfigCenterPanel";

const orderTypes = [
  { id: 1, code: "HS", name: "回收", capital_type: "OWNED", is_active: true },
] as unknown as import("@/shared/api/catalog").OrderType[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(orderTypes);
  vi.mocked(catalog.orderTypesApi.routes).mockResolvedValue([] as never);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue([
    { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
  ] as never);
  vi.mocked(catalog.gameTypesApi.list).mockResolvedValue([] as never);
  vi.mocked(catalog.optionSetsApi.list).mockResolvedValue({ items: [] } as never);
  vi.mocked(catalog.optionSetsApi.get).mockResolvedValue({ options: [] } as never);
  vi.mocked(catalog.policyApi.list).mockResolvedValue({ items: [], total: 0 } as never);
  vi.mocked(catalog.listColumnsApi.all).mockResolvedValue([] as never);
  vi.mocked(client.api).get.mockResolvedValue({ data: [] });
});

describe("ConfigCenterPanel", () => {
  it("顶部渲染字段配置与业务主数据，默认显示业务类型页面", async () => {
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    // 仅展示配置中心纳入的四组标题
    expect(await screen.findByText("字段配置")).toBeInTheDocument();
    expect(screen.getByText("业务主数据")).toBeInTheDocument();
    expect(screen.getByText("业务规则")).toBeInTheDocument();
    expect(screen.queryByText("数据治理")).toBeNull();
    expect(screen.queryByText("组织与权限")).toBeNull();
    expect(screen.queryByText("作业与外观")).toBeNull();
    // 默认选中业务类型（无权限门槛），渲染其现有页面（mock 数据 HS）
    expect(await screen.findByText("HS")).toBeInTheDocument();
    // 三组导航项均存在
    expect(screen.getByTestId("center-nav-form-fields")).toBeInTheDocument();
    expect(screen.getByTestId("center-nav-order-types")).toBeInTheDocument();
    expect(screen.getByTestId("center-nav-business-reminders")).toBeInTheDocument();
    expect(screen.queryByTestId("center-nav-sequences")).toBeNull();
  });

  it("不再提供编号序列页面", async () => {
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    expect(screen.queryByTestId("center-nav-sequences")).toBeNull();
  });

  it("点击业务提醒后展示库存阈值和提醒开关", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    await ui.click(screen.getByTestId("center-nav-business-reminders"));

    expect(await screen.findByText("库存订单超过多少天提醒")).toBeInTheDocument();
    expect(screen.getByText("新的分润通知")).toBeInTheDocument();
    expect(screen.getByText("逾期合约提醒")).toBeInTheDocument();
  });

  it("点击顶部页签切换到对应现有页面（业务类型 → 列表字段）", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    await screen.findByText("HS");
    await ui.click(screen.getByTestId("center-nav-list-columns"));
    // 业务类型页面已卸载
    expect(screen.queryByText("HS")).toBeNull();
    // 选中态高亮切到列表字段
    expect(screen.getByTestId("center-nav-list-columns").className).toContain("config-center__item--active");
    expect(screen.getByTestId("center-nav-order-types").className).not.toContain("config-center__item--active");
  });

  it("viewer 隐藏有权限的字段配置项（表单字段），保留无权限项", async () => {
    renderLight(<ConfigCenterPanel />, { user: "viewer" });
    // 无权限项可见
    expect(await screen.findByTestId("center-nav-order-types")).toBeInTheDocument();
    // 有权限项被隐藏
    expect(screen.queryByTestId("center-nav-form-fields")).toBeNull();
    expect(screen.getByText("字段配置")).toBeInTheDocument();
  });
});
