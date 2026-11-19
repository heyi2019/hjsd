import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gameTypesApi, sequencesApi } from "@/shared/api/misc.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { listColumnsApi, orderTypesApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";
import type { OrderType } from "@/shared/api/types/orders";
import { optionSet, optionSetList } from "@fixtures/api-responses";
vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/profitAllocation.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;
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
import { ConfigCenterPanel } from "@/settings/panels/ConfigCenterPanel";

const orderTypes = [
  { id: 1, code: "HS", name: "回收", is_active: true },
] as unknown as import("@/shared/api/types/orders").OrderType[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(orderTypesApi.list).mockResolvedValue(orderTypes);
  vi.mocked(poolsApi.list).mockResolvedValue([
    { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", status: "ACTIVE" },
  ] as never);
  vi.mocked(gameTypesApi.list).mockResolvedValue([] as never);
  vi.mocked(optionSetsApi.list).mockResolvedValue(optionSetList() as never);
  vi.mocked(optionSetsApi.get).mockResolvedValue(optionSet() as never);
  vi.mocked(listColumnsApi.all).mockResolvedValue([] as never);
  vi.mocked(sequencesApi.list).mockResolvedValue([] as never);
  vi.mocked(client.api).get.mockResolvedValue({ data: [] });
});

describe("ConfigCenterPanel", () => {
  it("顶部渲染字段配置、业务主数据与编号管理，默认显示业务类型页面", async () => {
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    // 仅展示配置中心纳入的四组标题
    expect(await screen.findByText("字段配置")).toBeInTheDocument();
    expect(screen.getByText("业务主数据")).toBeInTheDocument();
    expect(screen.getByText("业务规则")).toBeInTheDocument();
    expect(screen.queryByText("数据治理")).toBeNull();
    expect(screen.queryByText("组织与权限")).toBeNull();
    expect(screen.queryByText("作业与外观")).toBeNull();
    expect(screen.getByText("编号管理")).toBeInTheDocument();
    // 默认选中业务类型（无权限门槛），渲染其现有页面（mock 数据 HS）
    expect(await screen.findByText("HS")).toBeInTheDocument();
    // 三组导航项均存在
    expect(screen.getByTestId("center-nav-form-fields")).toBeInTheDocument();
    expect(screen.getByTestId("center-nav-order-types")).toBeInTheDocument();
    expect(screen.getByTestId("center-nav-business-reminders")).toBeInTheDocument();
    expect(screen.getByTestId("center-nav-sequences")).toBeInTheDocument();
  });

  it("点击编号序列后显示只读编号页面", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    await ui.click(screen.getByTestId("center-nav-sequences"));

    expect(screen.getByText(/序列编号由后端按域独立发放/)).toBeInTheDocument();
    expect(screen.getByText("库存编号")).toBeInTheDocument();
  });

  it("点击业务提醒后展示库存阈值和提醒开关", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    await ui.click(screen.getByTestId("center-nav-business-reminders"));

    expect(await screen.findByText("库存订单超过多少天提醒")).toBeInTheDocument();
    expect(screen.getByText("新的分润通知")).toBeInTheDocument();
    expect(screen.getByText("逾期合约提醒")).toBeInTheDocument();
  });

  it("业务提醒面板复用配置中心容器，不嵌套重复卡片标题", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    await ui.click(screen.getByTestId("center-nav-business-reminders"));

    const content = screen.getByTestId("center-content");
    expect(content.querySelectorAll(".ant-card")).toHaveLength(1);
    expect(within(content).getAllByText("业务提醒")).toHaveLength(1);
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
