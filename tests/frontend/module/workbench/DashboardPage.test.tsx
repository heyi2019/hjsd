import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DashboardPage } from "@/app/DashboardPage";
import { dashboardApi } from "@/shared/api/dashboard.api";
import { notificationsApi } from "@/shared/api/notifications.api";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { dashboardSummary } from "@fixtures/api-responses";
import { currentReportPeriod, previousReportPeriod } from "@/reporting/reportPeriod";
/** 2026-10-13：工作台数据总览（资金账户/统计/入口卡）已迁至「经营中心 · 数据中心」
 *  （用例见 reporting/DataCenterPanel.test.tsx）。本文件只覆盖瘦身后的工作台：
 *  纯动作入口——新建业务卡 + 登记弹窗，以及「数据已迁走」的回归断言。 */

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/dashboard.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/notifications.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/profitAllocation.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields();
  vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary());
  vi.mocked(notificationsApi.list).mockResolvedValue({ items: [], next_cursor: null });
  vi.mocked(notificationsApi.profitDetails).mockResolvedValue([]);
  vi.mocked(notificationsApi.markReadBatch).mockImplementation(async (ids) => ({ read_ids: ids }));
});

describe("DashboardPage：动作入口（数据已迁数据中心）", () => {
it("切换周期加载期间隐藏旧统计并暂停旧周期跳转", async () => {
    let finish!: (value: Awaited<ReturnType<typeof dashboardApi.summary>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof dashboardApi.summary>>>((resolve) => { finish = resolve; });
    vi.mocked(dashboardApi.summary)
      .mockResolvedValueOnce(dashboardSummary({ period: currentReportPeriod(), personal_orders: 7, personal_customers: 3, personal_earnings: "88.00" }))
      .mockReturnValueOnce(pending);
    const navigate = vi.fn();
    renderLight(<DashboardPage onDashboardNavigate={navigate} />, { user: "admin" });
    const orders = screen.getByTestId("dashboard-personal-orders");
    const earnings = screen.getByTestId("dashboard-personal-earnings");
    const customers = screen.getByTestId("dashboard-personal-customers");
    await within(orders).findByText("7");
    fireEvent.click(screen.getByRole("button", { name: "上期" }));
    await waitFor(() => expect(dashboardApi.summary).toHaveBeenLastCalledWith(previousReportPeriod()));
    for (const card of [orders, earnings, customers]) {
      expect(within(card).getByText("-")).toBeInTheDocument();
      expect(card).not.toHaveAttribute("role", "button");
      fireEvent.click(card);
    }
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { finish(dashboardSummary({ period: previousReportPeriod(), personal_orders: 2 })); await pending; });
    expect(within(orders).getByText("2")).toBeInTheDocument();
    fireEvent.click(orders);
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining(`trade_date_from=${previousReportPeriod().from}`));
  });

it("工作台展示业务总览指标和业务提醒", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      orders: { total_count: 2 },
      inventory: { account_count: 1, aging_count: 1, overdue_count: 1 },
      installments: { total_count: 1, overdue_count: 1 },
      alerts: [
        { type: "inventory_aging", message: "库存订单入库超过 7 天 1 个" },
        { type: "pending_profit", message: "分润待配置 1 条" },
        { type: "allocated_profit", message: "获得分润通知 1 条" },
      ],
    }));

    renderLight(<DashboardPage />, { user: "admin" });

    const overview = await screen.findByRole("region", { name: "我的业务总览" });
    for (const [label, value] of [
      ["在库账号", "1"],
      ["订单总量", "2"],
      ["我的当期客户数", "0"],
      ["分期合约", "1"],
      ["逾期合约", "1"],
      ["在库超期账号", "1"],
    ]) {
      const card = within(overview).getByText(label).closest(".ui-stat") as HTMLElement | null;
      expect(card).not.toBeNull();
      expect(await within(card!).findByText(value)).toBeInTheDocument();
    }
    const alerts = await screen.findByRole("region", { name: "我的消息" });
    expect(within(alerts).getByRole("tab", { name: "库存消息" })).toBeInTheDocument();
  });

// —— 以下 6 条原在 DashboardPage.interactions.test.tsx ——
// 同一页面、同一份 mock 契约，拆两个文件等于让同样的 jsdom+antd 启动付两遍。
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

it("订单请求完成时不产生未包裹 act 的异步更新警告", async () => {
    let resolveSummary!: (value: Awaited<ReturnType<typeof dashboardApi.summary>>) => void;
    vi.mocked(dashboardApi.summary).mockReturnValueOnce(new Promise((resolve) => {
      resolveSummary = resolve;
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderLight(<DashboardPage />, { user: "admin" });

    view.unmount();
    resolveSummary({
      period: { from: "2026-11-01", to: "2026-11-16" },
      orders: { total_count: 0 },
      personal_orders: 0,
      personal_customers: 0,
      personal_earnings: "0.00",
      inventory: { account_count: 0, aging_count: 0, overdue_count: 0 },
      installments: { total_count: 0, overdue_count: 0 },
      alerts: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      consoleError.mock.calls.some((args) => args.join(" ").includes("not wrapped in act")),
    ).toBe(false);
    consoleError.mockRestore();
  });

});
