import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { DashboardPage } from "./DashboardPage";

/** 2026-10-13：工作台数据总览（资金池/统计/入口卡）已迁至「经营中心 · 数据中心」
 *  （用例见 reporting/DataCenterPanel.test.tsx）。本文件只覆盖瘦身后的工作台：
 *  纯动作入口——新建业务卡 + 登记弹窗，以及「数据已迁走」的回归断言。 */
const ordersList = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  ordersApi: { list: (...a: unknown[]) => ordersList(...a) },
  // 新建业务弹窗自加载的选项数据：给空列表即可（弹窗自身用例在 CreateOrderModal.test.tsx）。
  orderTypesApi: { list: vi.fn().mockResolvedValue([]) },
  customersApi: { list: vi.fn().mockResolvedValue([]) },
  counterpartiesApi: { list: vi.fn().mockResolvedValue([]) },
  accountsApi: { list: vi.fn().mockResolvedValue([]) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  ordersList.mockResolvedValue([]);
});

describe("DashboardPage：动作入口（数据已迁数据中心）", () => {
  it("admin 渲染新建业务动作卡", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    expect(await screen.findByRole("button", { name: /新建业务/ })).toBeInTheDocument();
  });

  it("viewer 无 order.create → 看不到新建业务卡", async () => {
    renderApp(<DashboardPage />, { user: "viewer" });
    // 无卡可点：给一帧让权限门控渲染完再断言（sync 渲染，无需 waitFor 数据）。
    expect(screen.queryByRole("button", { name: /新建业务/ })).toBeNull();
  });

  it("点击新建业务卡直接打开登记弹窗（不跳转页面）", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await userEvent.click(await screen.findByRole("button", { name: /新建业务/ }));
    const modal = await screen.findByText("业务类型");
    expect(modal.closest(".ant-modal-content")).toBeTruthy();
  });

  it("数据总览已迁走：不再渲染资金池表格/统计/订单入口卡", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /新建业务/ });
    expect(screen.queryByText("资金池概览")).toBeNull();
    expect(screen.queryByText("可用余额合计")).toBeNull();
    expect(screen.queryByText("资金池数量")).toBeNull();
    expect(screen.queryByText("订单总数")).toBeNull();
    expect(screen.queryByText(/POOL-A/)).toBeNull();
  });
});
