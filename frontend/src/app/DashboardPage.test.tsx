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
  // 业务创建弹窗自加载的选项数据：给空列表即可（弹窗自身用例在 CreateBusinessModal.test.tsx）。
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
  it("admin 渲染业务入口卡", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    expect(await screen.findByRole("button", { name: /自营·回收/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /售出库存账号/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提号" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代挂" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /代分期/ })).toBeInTheDocument();
  });

  it("工作台只保留标题和入口，不显示辅助描述文字", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /自营·回收/ });
    expect(screen.queryByText("先处理最重要的动作；业务数据与经营指标分别在对应中心查看。")).toBeNull();
    expect(screen.queryByText("回收 / 提号 / 代挂 库存账号的统一出售入口")).toBeNull();
    expect(screen.queryByText("从库存中心选择任意渠道（回收 / 提号 / 代挂）的账号售出")).toBeNull();
    expect(screen.queryByText("录入游戏账号、来源与回收费用，创建回收单")).toBeNull();
    expect(screen.queryByText("需要快速开始时，从一个明确动作开始。")).toBeNull();
  });

  it("业务入口按场景使用独立的卡片视觉层级", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /自营·回收/ });
    expect(document.querySelector(".dashboard-card-group--sell")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-card-group--self-owned")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-card-group--distribution")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-card-group--service")).toBeInTheDocument();
  });

  it("主入口展示短标签，强化业务转化层级", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /售出库存账号/ });
    expect(screen.getByText("主推入口")).toBeInTheDocument();
    expect(screen.getByText("高频业务")).toBeInTheDocument();
  });

  it("分销入口只显示业务名称，不重复显示分销前缀", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    expect(await screen.findByRole("button", { name: "提号" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代挂" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分销·提号" })).toBeNull();
    expect(screen.queryByRole("button", { name: "分销·代挂" })).toBeNull();
  });

  it("所有业务分组使用统一的等高卡片布局", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: "提号" });
    expect(document.querySelectorAll(".dashboard-card-group--equal-height")).toHaveLength(4);
  });

  it("viewer 无 order.create → 看不到新建业务卡", async () => {
    renderApp(<DashboardPage />, { user: "viewer" });
    // 无卡可点：给一帧让权限门控渲染完再断言（sync 渲染，无需 waitFor 数据）。
    expect(screen.queryByRole("button", { name: /自营·回收/ })).toBeNull();
  });

  it("点击回收账号卡直接打开回收登记弹窗（不跳转页面）", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await userEvent.click(await screen.findByRole("button", { name: /自营·回收/ }));
    const modal = await screen.findByText("新建回收订单");
    expect(modal.closest(".ant-modal-content")).toBeTruthy();
  });

  it("点击共同出售口进入业务中心库存页", async () => {
    const onNavigate = vi.fn();
    renderApp(<DashboardPage onNavigate={onNavigate} />, { user: "admin" });
    await userEvent.click(await screen.findByRole("button", { name: /售出库存账号/ }));
    expect(onNavigate).toHaveBeenCalledWith("business", "inventory");
  });

  it("点击提号卡直接打开提号登记弹窗（不跳转页面）", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await userEvent.click(await screen.findByRole("button", { name: "提号" }));
    const modal = await screen.findByText("新建提号订单");
    expect(modal.closest(".ant-modal-content")).toBeTruthy();
  });

  it("数据总览已迁走：不再渲染资金池表格/统计/订单入口卡", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /自营·回收/ });
    expect(screen.queryByText("资金池概览")).toBeNull();
    expect(screen.queryByText("可用余额合计")).toBeNull();
    expect(screen.queryByText("资金池数量")).toBeNull();
    expect(screen.queryByText("订单总数")).toBeNull();
    expect(screen.queryByText(/POOL-A/)).toBeNull();
  });
});
