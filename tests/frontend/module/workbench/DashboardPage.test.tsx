import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DashboardPage } from "@/app/DashboardPage";
import { dashboardApi } from "@/shared/api/dashboard.api";
import { notificationsApi } from "@/shared/api/misc.api";
import { ordersApi } from "@/shared/api/orders.api";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { dashboardSummary, pageResponse } from "@fixtures/api-responses";
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
it("工作台展示业务总览指标和业务提醒", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      orders: { total_count: 2, completed_count: 1, active_count: 1 },
      inventory: { account_count: 1, aging_count: 1, overdue_count: 1 },
      installments: { total_count: 1, overdue_count: 1 },
      notifications: { pending_profit_count: 1, allocated_profit_count: 1 },
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
      expect(within(card!).getByText(value)).toBeInTheDocument();
    }
    const alerts = await screen.findByRole("region", { name: "我的消息" });
    expect(within(alerts).getByText("库存订单入库超过 7 天 1 个")).toBeInTheDocument();
    expect(within(alerts).getByText("分润待配置 1 条")).toBeInTheDocument();
    expect(within(alerts).getByText("获得分润通知 1 条")).toBeInTheDocument();
  });

it("点击获得分润通知展示订单金额、分润配置人和库存回收信息", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      notifications: { pending_profit_count: 0, allocated_profit_count: 1 },
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
      }],
      total: 1,
      unread_total: 1,
    });
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([{
      id: 42,
      order_no: "TH0001",
      order_type: "TH",
      trade_date: "2026-11-17",
      status: "COMPLETED",
      sale_amount: "300.00",
      account_id: 7,
      stock_no: "KU0007",
    }]));
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: {
        id: 7,
        stock_no: "KU0007",
        inventory_entry_at: "2026-11-10T08:00:00",
      },
      orders: [],
      finance_summary: {
        cashflow_income: "300.00",
        rebate_income: "0.00",
        total_income: "300.00",
        total_expense: "100.00",
        net_amount: "200.00",
      },
      detail_view: {
        execution_rows: [],
        finance_rows: [],
        operation_rows: [],
        lifecycle: {
          sold_at: "2026-11-17T10:00:00",
          removed_at: "2026-11-17T12:30:00",
          removed_platform: "平台A",
          recovery_platform: "平台A",
          sale_platform: "平台A",
        },
        order_notes: "",
        parties: [],
        extras: [],
      },
    } as never);
    renderLight(<DashboardPage />, { user: "admin" });

    fireEvent.click(await screen.findByRole("button", { name: "获得分润通知 1 条" }));
    expect(await screen.findByText("订单分润通知详情")).toBeInTheDocument();
    expect(screen.getByText("TH0001")).toBeInTheDocument();
    expect(screen.getByText("300.00")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("KU0007")).toBeInTheDocument();
    expect(screen.getByText("库存入库时间")).toBeInTheDocument();
    expect(screen.getByText("库存移出时间")).toBeInTheDocument();
    expect(screen.getByText("2026-11-17 12:30")).toBeInTheDocument();
  });

it("点击分润待配置通知跳转到对应订单的分润配置入口", async () => {
    const onDashboardNavigate = vi.fn();
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      notifications: { pending_profit_count: 1, allocated_profit_count: 0 },
    }));
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [{
        id: 2,
        notification_no: "NTF0002",
        recipient_user_id: 2,
        notification_type: "PROFIT_PENDING",
        title: "订单分润待配置",
        message: "订单 TH0002 已售出完成，请前往配置分润。",
        entity_type: "order",
        entity_id: "TH0002",
        created_by: "system",
        read_at: null,
      }],
      total: 1,
      unread_total: 1,
    });
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([{
      id: 43,
      order_no: "TH0002",
      order_type: "TH",
      trade_date: "2026-11-17",
      status: "COMPLETED",
      account_id: 8,
    }]));

    renderLight(<DashboardPage onDashboardNavigate={onDashboardNavigate} />, { user: "admin" });

    fireEvent.click(await screen.findByRole("button", { name: "分润待配置 1 条" }));
    await waitFor(() => expect(onDashboardNavigate).toHaveBeenCalledWith("/business/ledger?allocation_order_id=43"));
  });

it("工作台按业务提醒配置计算库存阈值并控制提醒开关", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      inventory: { account_count: 1, aging_count: 0, overdue_count: 0 },
      installments: { total_count: 1, overdue_count: 1 },
      notifications: { pending_profit_count: 0, allocated_profit_count: 1 },
      reminders: { inventory_aging_days: 14, profit_notifications_enabled: false, overdue_installments_enabled: false },
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
      orders: { total_count: 0, completed_count: 0, active_count: 0 },
      personal_orders: 0,
      personal_customers: 0,
      personal_earnings: "0.00",
      inventory: { account_count: 0, aging_count: 0, overdue_count: 0 },
      installments: { total_count: 0, overdue_count: 0 },
      notifications: { pending_profit_count: 0, allocated_profit_count: 0 },
      reminders: { inventory_aging_days: 7, profit_notifications_enabled: true, overdue_installments_enabled: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      consoleError.mock.calls.some((args) => args.join(" ").includes("not wrapped in act")),
    ).toBe(false);
    consoleError.mockRestore();
  });

});
