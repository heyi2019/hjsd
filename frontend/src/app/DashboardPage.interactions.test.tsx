import { fireEvent, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { DashboardPage } from "./DashboardPage";

import * as catalog from "../shared/api/catalog";
import { seedOrderFormFields } from "../test/formFieldsSeed";
/** 2026-10-13：工作台数据总览（资金池/统计/入口卡）已迁至「经营中心 · 数据中心」
 *  （用例见 reporting/DataCenterPanel.test.tsx）。本文件只覆盖瘦身后的工作台：
 *  纯动作入口——新建业务卡 + 登记弹窗，以及「数据已迁走」的回归断言。 */

vi.mock("../shared/api/catalog")

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([]);
  vi.mocked(catalog.stocksApi.list).mockResolvedValue([]);
  vi.mocked(catalog.installmentsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.notificationsApi.list).mockResolvedValue({ items: [], total: 0, unread_total: 0 });
  vi.mocked(catalog.reportsApi.commission).mockResolvedValue({
    items: [],
    total: { order_count: 0, profit_base: "0.00", payable: "0.00", paid: "0.00", difference: "0.00" },
  });
});

describe("DashboardPage：动作入口（数据已迁数据中心）", () => {
it("viewer 无 order.create → 看不到新建业务卡", async () => {
    await act(async () => {
      renderLight(<DashboardPage />, { user: "viewer" });
      await Promise.resolve();
    });
    // 无卡可点：给一帧让权限门控渲染完再断言（sync 渲染，无需 waitFor 数据）。
    expect(screen.queryByRole("button", { name: /自营·回收/ })).toBeNull();
  });

it("点击回收账号卡直接打开回收登记弹窗（不跳转页面）", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: /自营·回收/ }));
    const modal = await screen.findByText("新建回收订单");
    expect(modal.closest(".ant-modal-content")).toBeTruthy();
  });

it("点击共同出售口进入业务中心库存页", async () => {
    const onNavigate = vi.fn();
    renderLight(<DashboardPage onNavigate={onNavigate} />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: /售出库存账号/ }));
    expect(onNavigate).toHaveBeenCalledWith("business", "inventory");
  });

it("点击提号卡直接打开提号登记弹窗（不跳转页面）", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: "提号" }));
    const modal = await screen.findByText("新建提号订单");
    expect(modal.closest(".ant-modal-content")).toBeTruthy();
  });

it("数据总览已迁走：不再渲染资金池表格/统计/订单入口卡", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /自营·回收/ });
    expect(screen.queryByText("资金池概览")).toBeNull();
    expect(screen.queryByText("可用余额合计")).toBeNull();
    expect(screen.queryByText("资金池数量")).toBeNull();
    expect(screen.queryByText("订单总数")).toBeNull();
    expect(screen.queryByText(/POOL-A/)).toBeNull();
  });

it("订单请求完成时不产生未包裹 act 的异步更新警告", async () => {
    let resolveOrders!: (value: never[]) => void;
    vi.mocked(catalog.ordersApi.list).mockReturnValueOnce(new Promise<never[]>((resolve) => {
      resolveOrders = resolve;
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderLight(<DashboardPage />, { user: "admin" });

    view.unmount();
    resolveOrders([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      consoleError.mock.calls.some((args) => args.join(" ").includes("not wrapped in act")),
    ).toBe(false);
    consoleError.mockRestore();
  });
});
