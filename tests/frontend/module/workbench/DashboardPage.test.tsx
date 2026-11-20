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
});

describe("DashboardPage：动作入口（数据已迁数据中心）", () => {
it("提醒动作由类型决定，修改文案不影响点击", () => {
    const openPending = vi.fn();
    renderLight(<BusinessAlerts alerts={[{ type: "pending_profit", message: "需要设置分润" }]} loading={false} onPendingProfitNotificationsClick={openPending} />, { user: "admin" });
    fireEvent.click(screen.getByRole("button", { name: "需要设置分润" }));
    expect(openPending).toHaveBeenCalledTimes(1);
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
    expect(within(alerts).getByText("库存订单入库超过 7 天 1 个")).toBeInTheDocument();
    expect(within(alerts).getByText("分润待配置 1 条")).toBeInTheDocument();
    expect(within(alerts).getByText("获得分润通知 1 条")).toBeInTheDocument();
  });

it("获得分润通知只请求订单来源的消息", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({ alerts: [{ type: "allocated_profit", message: "获得分润通知 1 条" }] }));
    const last = { id: 201, notification_no: "N201", recipient_user_id: 2, notification_type: "PROFIT_ALLOCATED", title: "分润", entity_type: "order", entity_id: "HS0201", message: "末尾通知", created_by: "admin", read_at: null };
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [last], total: 1, unread_total: 201 });
    vi.mocked(notificationsApi.profitDetails).mockResolvedValue([{ notification_id: 201, order_no: "HS0201", order_type: "HS", sale_amount: "10.00", stock_no: "KU0007", inventory_entry_at: "2026-11-10T08:00:00", removed_at: null, recovery_operator: null }]);
    vi.mocked(notificationsApi.markReadBatch).mockResolvedValue({ read_ids: [201] });
    renderLight(<DashboardPage />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: "获得分润通知 1 条" }));
    expect(await screen.findByText("末尾通知")).toBeInTheDocument();
    expect(notificationsApi.list).toHaveBeenCalledWith({ limit: 10, unread_only: true, notification_type: "PROFIT_ALLOCATED", entity_type: "order" });
  });

it("分润通知逐页加载，已读前页后仍可查看后页", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({ alerts: [{ type: "allocated_profit", message: "获得分润通知 11 条" }] }));
    const notifications = Array.from({ length: 11 }, (_, index) => ({ id: 11 - index, notification_no: `N${index}`, recipient_user_id: 2, notification_type: "PROFIT_ALLOCATED", title: "分润", message: `通知 ${11 - index}`, entity_type: "order", entity_id: `HS${11 - index}`, created_by: "admin", read_at: null }));
    vi.mocked(notificationsApi.list).mockImplementation(async (params) => params.before_id
      ? { items: notifications.slice(10), total: 1, unread_total: 1 }
      : { items: notifications.slice(0, 10), total: 11, unread_total: 11 });
    vi.mocked(notificationsApi.profitDetails).mockImplementation(async (ids) => ids.map((id) => ({ notification_id: id, order_no: `HS${id}`, order_type: "HS", sale_amount: "10.00", stock_no: null, inventory_entry_at: "2026-11-10T08:00:00", removed_at: null, recovery_operator: null })));
    vi.mocked(notificationsApi.markReadBatch).mockImplementation(async (ids) => ({ read_ids: ids }));
    renderLight(<DashboardPage />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: "获得分润通知 11 条" }));
    expect(await screen.findByText("通知 11")).toBeInTheDocument();
    await waitFor(() => expect(notificationsApi.markReadBatch).toHaveBeenCalledWith([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]));
    expect(notificationsApi.list).toHaveBeenCalledTimes(1);
    expect(notificationsApi.profitDetails).toHaveBeenCalledTimes(1);
    expect(notificationsApi.markReadBatch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("listitem", { name: "2" }));
    expect(await screen.findByText("通知 1")).toBeInTheDocument();
    await waitFor(() => expect(notificationsApi.markReadBatch).toHaveBeenCalledWith([1]));
    expect(notificationsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ before_id: 2 }));
    fireEvent.click(screen.getByRole("listitem", { name: "1" }));
    expect(await screen.findByText("通知 11")).toBeInTheDocument();
    expect(notificationsApi.list).toHaveBeenCalledTimes(2);
    expect(notificationsApi.profitDetails).toHaveBeenCalledTimes(2);
  });

it("点击获得分润通知展示订单金额、分润配置人和库存回收信息", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      alerts: [{ type: "allocated_profit", message: "获得分润通知 3 条" }],
    }));
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [{
        id: 1,
        notification_no: "NTF0001",
        recipient_user_id: 2,
        notification_type: "PROFIT_ALLOCATED",
        title: "订单分润已配置",
        message: "订单 TH0001 分润配置已保存，请到收益明细查看。",
        entity_type: "order",
        entity_id: "TH0001",
        created_by: "admin",
        read_at: null,
      }, {
        id: 2, notification_no: "NTF0002", recipient_user_id: 2,
        notification_type: "PROFIT_ALLOCATED", title: "订单分润已配置", message: "订单不可见",
        entity_type: "order", entity_id: "TH-MISSING", created_by: "admin", read_at: null,
      }, {
        id: 3, notification_no: "NTF0003", recipient_user_id: 2,
        notification_type: "PROFIT_ALLOCATED", title: "订单分润已配置", message: "查询失败",
        entity_type: "order", entity_id: "TH-ERROR", created_by: "admin", read_at: null,
      }],
      total: 3,
      unread_total: 3,
    });
    vi.mocked(notificationsApi.markReadBatch).mockRejectedValueOnce(new Error("网络不可用"));
    vi.mocked(notificationsApi.profitDetails).mockResolvedValue([{ notification_id: 1, order_no: "TH0001", order_type: "TH", sale_amount: "300.00", stock_no: "KU0007", inventory_entry_at: "2026-11-10T08:00:00", removed_at: "2026-11-17T12:30:00", recovery_operator: "回收人员" }]);
    renderLight(<DashboardPage />, { user: "admin" });

    fireEvent.click(await screen.findByRole("button", { name: "获得分润通知 3 条" }));
    expect(await screen.findByText("订单分润通知详情")).toBeInTheDocument();
    expect(notificationsApi.list).toHaveBeenCalledWith({ limit: 10, unread_only: true, notification_type: "PROFIT_ALLOCATED", entity_type: "order" });
    expect(screen.getByText("TH0001")).toBeInTheDocument();
    expect(screen.getByText("300.00")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("KU0007")).toBeInTheDocument();
    expect(screen.getByText("库存入库时间")).toBeInTheDocument();
    expect(screen.getByText("库存移出时间")).toBeInTheDocument();
    expect(screen.getByText("回收人员")).toBeInTheDocument();
    expect(screen.queryByText("售出人员")).not.toBeInTheDocument();
    expect(screen.getByText("2026-11-17 12:30")).toBeInTheDocument();
    expect(screen.getByText(/2 条通知暂时无法查看/)).toBeInTheDocument();
    await waitFor(() => expect(notificationsApi.markReadBatch).toHaveBeenCalledWith([1]));
    expect(await screen.findByText(/1 条通知未能标为已读/)).toBeInTheDocument();
    expect(notificationsApi.markReadBatch).toHaveBeenCalledTimes(1);
  });

it("批量标记部分失败时保留未读并提示数量", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({ alerts: [{ type: "allocated_profit", message: "获得分润通知 2 条" }] }));
    const items = [1, 2].map((id) => ({ id, notification_no: `N${id}`, recipient_user_id: 2, notification_type: "PROFIT_ALLOCATED", title: "分润", message: `通知 ${id}`, entity_type: "order", entity_id: `HS${id}`, created_by: "admin", read_at: null }));
    vi.mocked(notificationsApi.list).mockResolvedValue({ items, total: 2, unread_total: 2 });
    vi.mocked(notificationsApi.profitDetails).mockImplementation(async (ids) => ids.map((id) => ({ notification_id: id, order_no: `HS${id}`, order_type: "HS", sale_amount: "10.00", stock_no: null, inventory_entry_at: "2026-11-10T08:00:00", removed_at: null, recovery_operator: null })));
    vi.mocked(notificationsApi.markReadBatch).mockResolvedValue({ read_ids: [1] });
    renderLight(<DashboardPage />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: "获得分润通知 2 条" }));
    expect(await screen.findByText(/1 条通知未能标为已读/)).toBeInTheDocument();
    expect(notificationsApi.markReadBatch).toHaveBeenCalledWith([1, 2]);
  });

it("点击分润待配置通知跳转到对应订单的分润配置入口", async () => {
    const onDashboardNavigate = vi.fn();
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      alerts: [{ type: "pending_profit", message: "分润待配置 1 条" }],
    }));
    vi.mocked(notificationsApi.pendingOrder).mockResolvedValue({ order_no: "TH0002", order_id: 43 });

    renderLight(<DashboardPage onDashboardNavigate={onDashboardNavigate} />, { user: "admin" });

    fireEvent.click(await screen.findByRole("button", { name: "分润待配置 1 条" }));
    await waitFor(() => expect(onDashboardNavigate).toHaveBeenCalledWith("/business/ledger?allocation_order_id=43"));
    expect(notificationsApi.pendingOrder).toHaveBeenCalledTimes(1);
    expect(ordersApi.listPage).not.toHaveBeenCalled();
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalled();
  });

it("待配置通知不存在或订单不可见时提示且不跳转", async () => {
    const navigate = vi.fn();
    const warning = vi.spyOn(appMessage, "warning").mockImplementation(() => undefined as never);
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({ alerts: [{ type: "pending_profit", message: "分润待配置 1 条" }] }));
    vi.mocked(notificationsApi.pendingOrder)
      .mockResolvedValueOnce({ order_no: null, order_id: null })
      .mockResolvedValueOnce({ order_no: "HS-MISSING", order_id: null });
    renderLight(<DashboardPage onDashboardNavigate={navigate} />, { user: "admin" });
    const button = await screen.findByRole("button", { name: "分润待配置 1 条" });
    fireEvent.click(button);
    await waitFor(() => expect(warning).toHaveBeenCalledWith("没有找到待配置分润的订单"));
    fireEvent.click(button);
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
    expect(within(alerts).getByText("暂无异常事项")).toBeInTheDocument();
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
