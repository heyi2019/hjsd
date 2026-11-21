import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DashboardPage } from "@/app/DashboardPage";
import { BusinessAlerts } from "@/app/BusinessOverview";
import { dashboardApi } from "@/shared/api/dashboard.api";
import { notificationsApi } from "@/shared/api/misc.api";
import { ordersApi } from "@/shared/api/orders.api";
import { appMessage } from "@/shared/ui/appFeedback";
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
  vi.mocked(notificationsApi.list).mockResolvedValue({ items: [], total: 0, unread_total: 0 });
  vi.mocked(notificationsApi.profitDetails).mockResolvedValue([]);
  vi.mocked(notificationsApi.markReadBatch).mockImplementation(async (ids) => ({ read_ids: ids }));
});

describe("DashboardPage：动作入口（数据已迁数据中心）", () => {
it("消息分类展示最新、售出和库存", async () => {
    renderLight(<BusinessAlerts />, { user: "admin" });
    await screen.findByText("暂无消息");
    for (const label of ["最新消息", "售出消息", "库存消息"]) expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "售出消息" }));
    await waitFor(() => expect(notificationsApi.list).toHaveBeenCalledWith(expect.objectContaining({ category: "sale" })));
    fireEvent.click(screen.getByRole("tab", { name: "库存消息" }));
    await waitFor(() => expect(notificationsApi.list).toHaveBeenCalledWith(expect.objectContaining({ category: "inventory" })));
  });
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

it("未读消息逐页滚动加载且不自动标已读", async () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ id: 11 - i, notification_type: "OTHER", title: "提醒", message: `通知 ${11 - i}`, entity_type: "other", entity_id: String(i), created_at: "2026-11-21T09:30:00", read_at: null }));
    vi.mocked(notificationsApi.list).mockImplementation(async (params) => ({ items: params.before_id ? items.slice(10) : items.slice(0, 10), total: 11, unread_total: 11 }));
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /通知 11/ });
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalled();
    const scroll = document.querySelector(".business-alerts__scroll")!;
    fireEvent.scroll(scroll);
    expect(await screen.findByRole("button", { name: /^通知 1 未读.*通知时间/ })).toBeInTheDocument();
    expect(notificationsApi.list).toHaveBeenCalledWith(expect.objectContaining({ before_id: 2, unread_only: true }));
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalled();
  });

it("点击分润通知只标记当前消息并展示详情", async () => {
    const items = [1, 2].map((id) => ({ id, notification_type: "PROFIT_ALLOCATED", title: "分润", message: `订单 HS${id} 分润`, entity_type: "order", entity_id: `HS${id}`, created_at: "2026-11-20T08:30:00", read_at: null }));
    vi.mocked(notificationsApi.list).mockResolvedValue({ items, total: 2, unread_total: 2 });
    vi.mocked(notificationsApi.profitDetails).mockImplementation(async (ids) => ids.map((id) => ({ notification_id: id, order_no: `HS${id}`, order_type: "HS", sale_amount: "300.00", stock_no: "KU0007", inventory_entry_at: "2026-11-10", removed_at: null, recovery_operator: "回收人员" })));
    renderLight(<DashboardPage />, { user: "admin" });
    const button = await screen.findByRole("button", { name: /订单 HS1 分润/ });
    expect(within(button).getByText(/2026-11-20 08:30/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText("订单分润通知详情")).toBeInTheDocument();
    expect(notificationsApi.markReadBatch).toHaveBeenCalledWith([1]);
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalledWith([2]);
    expect(await screen.findByText("KU0007")).toBeInTheDocument();
  });

it("标记已读失败时保留未读并可重试", async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [{ id: 1, title: "提醒", message: "测试消息", entity_type: "other", entity_id: "x", read_at: null }], total: 1, unread_total: 1 });
    vi.mocked(notificationsApi.markReadBatch).mockRejectedValueOnce(new Error("网络不可用"));
    renderLight(<DashboardPage />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: /测试消息/ }));
    expect(await screen.findByText("标记已读失败，请重试。")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /测试消息/ })).getByText("未读")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(notificationsApi.markReadBatch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: /测试消息/ })).toBeNull());
  });

it("已读消息可再次打开而不重复标记", async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [{ id: 8, title: "提醒", message: "已读旧消息", entity_type: "other", entity_id: "x", created_at: "2026-11-20T08:00:00", read_at: "2026-11-20" }, { id: 2, title: "提醒", message: "已读新消息", entity_type: "other", entity_id: "y", created_at: "2026-11-21T08:00:00", read_at: "2026-11-21" }], total: 2, unread_total: 0 });
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByText("暂无消息");
    expect(screen.queryByRole("button", { name: /已读新消息/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "售出消息" }));
    const newer = await screen.findByRole("button", { name: /已读新消息/ });
    const older = screen.getByRole("button", { name: /已读旧消息/ });
    expect(newer.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(newer);
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalled();
  });

it("点击分润待配置通知跳转到对应订单的分润配置入口", async () => {
    const onDashboardNavigate = vi.fn();
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      alerts: [{ type: "pending_profit", message: "分润待配置 1 条" }],
    }));
    vi.mocked(notificationsApi.pendingOrder).mockResolvedValue({ order_no: "TH0002", order_id: 43 });
    vi.mocked(notificationsApi.list).mockImplementation(async (params) => ({ items: params.read_only
      ? [{ id: 3, title: "订单分润待配置", message: "订单 HS0001 待配置分润", notification_type: "PROFIT_PENDING", entity_type: "order", entity_id: "HS0001", read_at: "2026-11-20T10:00:00" }]
      : [{ id: 2, title: "订单分润待配置", message: "订单 TH0002 待配置分润", notification_type: "PROFIT_PENDING", entity_type: "order", entity_id: "TH0002", created_at: "2026-11-21T09:30:00", read_at: null }], total: 1, unread_total: 1 }));
    vi.mocked(notificationsApi.markReadBatch).mockResolvedValue({ read_ids: [2] });
    vi.mocked(notificationsApi.profitDetails).mockResolvedValue([{ notification_id: 2, order_no: "TH0002", order_type: "TH", game_type: "王者荣耀", cost_amount: "100.00", sale_amount: "200.00", allocatable_profit: "60.00", stock_no: null, inventory_entry_at: "2026-11-20", removed_at: null, recovery_operator: null }]);

    renderLight(<DashboardPage onDashboardNavigate={onDashboardNavigate} />, { user: "admin" });
    fireEvent.click(screen.getByRole("tab", { name: "售出消息" }));

    const unread = await screen.findByRole("button", { name: /订单 TH0002 待配置分润/ });
    const read = await screen.findByRole("button", { name: /订单 HS0001 待配置分润/ });
    expect(unread.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(unread).getByText("未读")).toBeInTheDocument();
    expect(within(unread).getByText(/王者荣耀.*100.00.*200.00.*60.00/)).toBeInTheDocument();
    expect(within(unread).getByText(/通知时间 2026-11-21 09:30/)).toBeInTheDocument();
    expect(within(read).getByText("已读")).toBeInTheDocument();
    fireEvent.click(unread);
    await waitFor(() => expect(onDashboardNavigate).toHaveBeenCalledWith("/business/ledger?allocation_order_id=43"));
    expect(notificationsApi.pendingOrder).toHaveBeenCalledWith(2);
    expect(ordersApi.listPage).not.toHaveBeenCalled();
    expect(notificationsApi.markReadBatch).toHaveBeenCalledWith([2]);
  });

it("待配置通知订单不可见时提示且不跳转", async () => {
    const navigate = vi.fn();
    const warning = vi.spyOn(appMessage, "warning").mockImplementation(() => undefined as never);
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [{ id: 1, title: "待配置", message: "订单 HS-MISSING", notification_type: "PROFIT_PENDING", entity_type: "order", entity_id: "HS-MISSING", read_at: null }], total: 1, unread_total: 1 });
    vi.mocked(notificationsApi.pendingOrder).mockResolvedValue({ order_no: "HS-MISSING", order_id: null });
    renderLight(<DashboardPage onDashboardNavigate={navigate} />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: /订单 HS-MISSING/ }));
    await waitFor(() => expect(warning).toHaveBeenCalledWith("未找到订单 HS-MISSING"));
    expect(navigate).not.toHaveBeenCalled();
  });

it("后端没有返回提醒时显示空状态", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      inventory: { account_count: 1, aging_count: 0, overdue_count: 0 },
      installments: { total_count: 1, overdue_count: 1 },
      alerts: [],
    }));

    renderLight(<DashboardPage />, { user: "admin" });

    const alerts = await screen.findByRole("region", { name: "我的消息" });
    expect(await within(alerts).findByText("暂无消息")).toBeInTheDocument();
    expect(vi.mocked(dashboardApi.summary)).toHaveBeenCalledTimes(1);
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
