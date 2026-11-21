import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DashboardPage } from "@/app/DashboardPage";
import { BusinessAlerts } from "@/app/workbench/messages/BusinessAlerts";
import { dashboardApi } from "@/shared/api/dashboard.api";
import { notificationsApi } from "@/shared/api/notifications.api";
import { ordersApi } from "@/shared/api/orders.api";
import { appMessage } from "@/shared/ui/appFeedback";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { dashboardSummary } from "@fixtures/api-responses";

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
  vi.mocked(notificationsApi.syncInventory).mockResolvedValue({ created: 0 });
  vi.mocked(notificationsApi.profitDetails).mockResolvedValue([]);
  vi.mocked(notificationsApi.markReadBatch).mockImplementation(async (ids) => ({ read_ids: ids }));
});

describe("工作台消息", () => {
it("消息分类展示最新、售出和库存", async () => {
    const view = renderLight(<BusinessAlerts />, { user: "admin" });
    await screen.findByText("暂无消息");
    for (const label of ["最新消息", "售出消息", "库存消息"]) expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "售出消息" }));
    await waitFor(() => expect(notificationsApi.list).toHaveBeenCalledWith(expect.objectContaining({ category: "sale" })));
    fireEvent.click(screen.getByRole("tab", { name: "库存消息" }));
    await waitFor(() => expect(notificationsApi.list).toHaveBeenCalledWith(expect.objectContaining({ category: "inventory" })));
    expect(notificationsApi.syncInventory).toHaveBeenCalledTimes(1);
    view.unmount();
    vi.mocked(notificationsApi.syncInventory).mockClear().mockRejectedValueOnce(new Error("网络不可用"));
    renderLight(<BusinessAlerts />, { user: "admin" });
    expect(await screen.findByText("库存消息刷新失败。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByText("库存消息刷新失败。")).not.toBeInTheDocument());
    expect(notificationsApi.syncInventory).toHaveBeenCalledTimes(2);
  });
it("未读消息逐页滚动加载且不自动标已读", async () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ id: 11 - i, notification_type: "OTHER", title: "提醒", message: `通知 ${11 - i}`, entity_type: "other", entity_id: String(i), created_at: "2026-11-21T09:30:00", read_at: null }));
    vi.mocked(notificationsApi.list).mockImplementation(async (params) => ({ items: params.cursor ? items.slice(10) : items.slice(0, 10), next_cursor: params.cursor ? null : "page-2" }));
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /通知 11/ });
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalled();
    const scroll = document.querySelector(".business-alerts__scroll")!;
    fireEvent.scroll(scroll);
    expect(await screen.findByRole("button", { name: /^通知 1 未读.*通知时间/ })).toBeInTheDocument();
    expect(notificationsApi.list).toHaveBeenCalledWith(expect.objectContaining({ cursor: "page-2", category: "latest" }));
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalled();
  });

it("点击分润通知只标记当前消息并展示详情", async () => {
    const items = [1, 2].map((id) => ({ id, notification_type: "PROFIT_ALLOCATED", title: "分润", message: `订单 HS${id} 分润`, entity_type: "order", entity_id: `HS${id}`, created_at: "2026-11-20T08:30:00", read_at: null }));
    vi.mocked(notificationsApi.list).mockResolvedValue({ items, next_cursor: null });
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

it("连续点击消息均能打开且保持滚动位置", async () => {
    const items = [1, 2].map((id) => ({ id, notification_type: "PROFIT_PENDING", title: "分润", message: `订单 ${id}`, entity_type: "order", entity_id: `${id}`, created_at: "2026-11-20T08:30:00", read_at: null }));
    vi.mocked(notificationsApi.list).mockResolvedValue({ items, next_cursor: null });
    const pending: Record<number, (value: { read_ids: number[] }) => void> = {};
    vi.mocked(notificationsApi.markReadBatch).mockImplementation(([id]) => new Promise((resolve) => { pending[id] = resolve; }));
    const open = vi.fn();
    renderLight(<BusinessAlerts onPendingProfitNotificationsClick={open} />, { user: "admin" });
    fireEvent.click(screen.getByRole("tab", { name: "售出消息" }));
    const first = await screen.findByRole("button", { name: /订单 1/ });
    const second = screen.getByRole("button", { name: /订单 2/ });
    const scroll = document.querySelector(".business-alerts__scroll") as HTMLDivElement;
    scroll.scrollTop = 150;
    fireEvent.click(first);
    fireEvent.click(second);
    pending[1]({ read_ids: [1] });
    await waitFor(() => expect(open).toHaveBeenCalledWith(1));
    pending[2]({ read_ids: [2] });
    await waitFor(() => expect(open).toHaveBeenCalledWith(2));
    expect(scroll.scrollTop).toBe(150);
  });

it("停留工作台时定时刷新，滚动查看期间不打断", async () => {
    const interval = vi.spyOn(window, "setInterval");
    renderLight(<BusinessAlerts />, { user: "admin" });
    await screen.findByText("暂无消息");
    const calls = () => interval.mock.calls.filter((args) => args[1] === 5 * 60_000);
    const run = async () => {
      const handlers = calls();
      const handler = handlers[handlers.length - 1]?.[0];
      expect(typeof handler).toBe("function");
      await act(async () => { (handler as () => void)(); });
    };
    const count = vi.mocked(notificationsApi.list).mock.calls.length;
    await run();
    await waitFor(() => expect(notificationsApi.list).toHaveBeenCalledTimes(count + 1));
    const scroll = document.querySelector(".business-alerts__scroll") as HTMLDivElement;
    scroll.scrollTop = 100;
    await run();
    expect(notificationsApi.list).toHaveBeenCalledTimes(count + 1);
    interval.mockRestore();
  });

it("标记已读失败时保留未读并可重试", async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [{ id: 1, title: "提醒", message: "测试消息", entity_type: "other", entity_id: "x", read_at: null }], next_cursor: null });
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
    vi.mocked(notificationsApi.list).mockImplementation(async ({ category }) => ({ items: category === "latest" ? [] : [{ id: 2, title: "提醒", message: "已读新消息", entity_type: "other", entity_id: "y", created_at: "2026-11-21T08:00:00", read_at: "2026-11-21" }, { id: 8, title: "提醒", message: "已读旧消息", entity_type: "other", entity_id: "x", created_at: "2026-11-20T08:00:00", read_at: "2026-11-20" }], next_cursor: null }));
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
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [
      { id: 2, title: "订单分润待配置", message: "订单 TH0002 待配置分润", notification_type: "PROFIT_PENDING", entity_type: "order", entity_id: "TH0002", created_at: "2026-11-21T09:30:00", read_at: null },
      { id: 3, title: "订单分润待配置", message: "订单 HS0001 待配置分润", notification_type: "PROFIT_PENDING", entity_type: "order", entity_id: "HS0001", read_at: "2026-11-20T10:00:00" },
    ], next_cursor: null });
    vi.mocked(notificationsApi.markReadBatch).mockResolvedValue({ read_ids: [2] });
    vi.mocked(notificationsApi.profitDetails).mockResolvedValue([{ notification_id: 2, order_no: "TH0002", order_type: "TH", game_type: "王者荣耀", cost_amount: "100.00", sale_amount: "200.00", allocatable_profit: "60.00", stock_no: null, inventory_entry_at: "2026-11-20", removed_at: null, recovery_operator: null }]);

    renderLight(<DashboardPage onDashboardNavigate={onDashboardNavigate} />, { user: "admin" });
    fireEvent.click(screen.getByRole("tab", { name: "售出消息" }));

    const unread = await screen.findByRole("button", { name: /订单 TH0002 待配置分润/ });
    const read = await screen.findByRole("button", { name: /订单 HS0001 待配置分润/ });
    expect(unread.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(unread).getByText("未读")).toBeInTheDocument();
    expect(within(unread).getByText(/成本 100.00.*售出 200.00.*待分配利润 60.00/)).toBeInTheDocument();
    expect(within(unread).queryByText(/王者荣耀/)).not.toBeInTheDocument();
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
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [{ id: 1, title: "待配置", message: "订单 HS-MISSING", notification_type: "PROFIT_PENDING", entity_type: "order", entity_id: "HS-MISSING", read_at: null }], next_cursor: null });
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

});
