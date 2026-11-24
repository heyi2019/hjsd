import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { WorkbenchPage } from "@/workbench/WorkbenchPage";
import * as sessionApi from "@/shared/api/client";
import { workbenchApi } from "@/shared/api/workbench.api";
import { notificationsApi } from "@/shared/api/notifications.api";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { workbenchSummary } from "@fixtures/api-responses";
import { currentReportPeriod, previousReportPeriod } from "@/shared/lib/reportPeriod";
/** 工作台页面组合、业务总览及消息交互；快捷入口功能由 QuickAccess.test.tsx 覆盖。 */

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/workbench.api");
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
  vi.mocked(workbenchApi.summary).mockResolvedValue(workbenchSummary());
  vi.mocked(notificationsApi.list).mockResolvedValue({ items: [], next_cursor: null });
  vi.mocked(notificationsApi.syncReminders).mockResolvedValue({ created: 0 });
  vi.mocked(notificationsApi.profitDetails).mockResolvedValue([]);
  vi.mocked(notificationsApi.markReadBatch).mockImplementation(async (ids) => ({ read_ids: ids, read_at: "2026-11-21T10:00:00", next_read_id: null }));
});

describe("WorkbenchPage：动作入口（数据已迁数据中心）", () => {
it("旧周期汇总晚返回时不覆盖新周期的数据", async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof workbenchApi.summary>>) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof workbenchApi.summary>>>((resolve) => { finishOld = resolve; });
    vi.mocked(workbenchApi.summary)
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce(workbenchSummary({ period: previousReportPeriod(), personal_orders: 2 }));

    renderLight(<WorkbenchPage />, { user: "admin" });
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "上期" }));
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenLastCalledWith(previousReportPeriod()));
    const orders = screen.getByTestId("workbench-personal-orders");
    expect(await within(orders).findByText("2")).toBeInTheDocument();

    await act(async () => { finishOld(workbenchSummary({ period: currentReportPeriod(), personal_orders: 99 })); await oldRequest; });
    expect(within(orders).getByText("2")).toBeInTheDocument();
    expect(within(orders).queryByText("99")).not.toBeInTheDocument();
  });

it("切换周期加载期间隐藏旧统计并暂停旧周期跳转", async () => {
    let finish!: (value: Awaited<ReturnType<typeof workbenchApi.summary>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof workbenchApi.summary>>>((resolve) => { finish = resolve; });
    vi.mocked(workbenchApi.summary)
      .mockResolvedValueOnce(workbenchSummary({ period: currentReportPeriod(), personal_orders: 7, personal_customers: 3, personal_earnings: "88.00" }))
      .mockReturnValueOnce(pending);
    const navigate = vi.fn();
    renderLight(<WorkbenchPage onWorkbenchNavigate={navigate} />, { user: "admin" });
    const orders = screen.getByTestId("workbench-personal-orders");
    const earnings = screen.getByTestId("workbench-personal-earnings");
    const customers = screen.getByTestId("workbench-personal-customers");
    const businessCards = ["workbench-inventory", "workbench-installments", "workbench-overdue-installments", "workbench-inventory-overdue"].map((id) => screen.getByTestId(id));
    await within(orders).findByText("7");
    fireEvent.click(screen.getByRole("button", { name: "上期" }));
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenLastCalledWith(previousReportPeriod()));
    for (const card of [orders, earnings, customers, ...businessCards]) {
      expect(within(card).getByText("-")).toBeInTheDocument();
      expect(card).not.toHaveAttribute("role", "button");
      fireEvent.click(card);
    }
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { finish(workbenchSummary({ period: previousReportPeriod(), personal_orders: 2 })); await pending; });
    expect(within(orders).getByText("2")).toBeInTheDocument();
    fireEvent.click(orders);
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining(`trade_date_from=${previousReportPeriod().from}`));
  });

it("工作台展示业务总览指标和业务提醒", async () => {
    vi.mocked(workbenchApi.summary).mockResolvedValue(workbenchSummary({
      orders: { total_count: 2 },
      inventory: { account_count: 1, aging_count: 1, overdue_count: 1 },
      installments: { total_count: 1, overdue_count: 1 },
    }));

    const profile = vi.spyOn(sessionApi, "currentUser").mockResolvedValue({ id: 1, username: "admin", role: "admin", display_name: "张三" });
    vi.setSystemTime(new Date(2026, 10, 25, 9));
    try {
      renderLight(<WorkbenchPage />, { user: "admin", syncDevUser: true });
      expect(await screen.findByRole("heading", { name: "上午好，张三" })).toBeInTheDocument();
      for (const [hour, greeting] of [[11, "中午好"], [18, "晚上好"], [0, "凌晨好"]] as const) {
        vi.setSystemTime(new Date(2026, 10, 25, hour));
        fireEvent(window, new Event("focus"));
        expect(screen.getByRole("heading", { name: `${greeting}，张三` })).toBeInTheDocument();
      }
    } finally {
      vi.useRealTimers();
      profile.mockRestore();
    }

    expect(screen.getByRole("button", { name: /售出库存账号/ })).toBeInTheDocument();
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

it("查看消息标记已读时不重复加载业务总览", async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [
      { id: 1, notification_type: "PROFIT_PENDING", title: "分润提醒", message: "订单 HS1 待分润", entity_type: "order", entity_id: "HS1", created_at: "2026-11-20T08:30:00", read_at: null },
      { id: 2, notification_type: "INVENTORY_AGING", title: "库存提醒", message: "库存已超期", entity_type: "account", entity_id: "2", created_at: "2026-11-20T08:30:00", read_at: null },
    ], next_cursor: null });
    renderLight(<WorkbenchPage />, { user: "admin" });
    await screen.findByRole("button", { name: /订单 HS1 待分润/ });
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /订单 HS1 待分润/ }));
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /库存已超期/ }));
    expect(await screen.findByText("库存提醒")).toBeInTheDocument();
    expect(notificationsApi.markReadBatch).toHaveBeenCalledWith([2], "latest");
    expect(workbenchApi.summary).toHaveBeenCalledTimes(1);
  });

it("订单请求完成时不产生未包裹 act 的异步更新警告", async () => {
    let resolveSummary!: (value: Awaited<ReturnType<typeof workbenchApi.summary>>) => void;
    vi.mocked(workbenchApi.summary).mockReturnValueOnce(new Promise((resolve) => {
      resolveSummary = resolve;
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderLight(<WorkbenchPage />, { user: "admin" });

    view.unmount();
    resolveSummary({
      period: { from: "2026-11-01", to: "2026-11-16" },
      orders: { total_count: 0 },
      personal_orders: 0,
      personal_customers: 0,
      personal_earnings: "0.00",
      inventory: { account_count: 0, aging_count: 0, overdue_count: 0 },
      installments: { total_count: 0, overdue_count: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      consoleError.mock.calls.some((args) => args.join(" ").includes("not wrapped in act")),
    ).toBe(false);
    consoleError.mockRestore();
  });

});
