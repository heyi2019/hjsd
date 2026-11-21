import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DashboardPage } from "@/app/DashboardPage";
import { BusinessAlerts } from "@/app/workbench/notifications/BusinessAlerts";
import { ProfitNotificationModal } from "@/app/workbench/notifications/ProfitNotificationModal";
import { OrderDetailDialog } from "@/business/OrderDetailView/OrderDetailDialog";
import { dashboardApi } from "@/shared/api/dashboard.api";
import { notificationsApi } from "@/shared/api/notifications.api";
import { ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { reportsApi } from "@/shared/api/reports.api";
import { appMessage } from "@/shared/ui/appFeedback";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { dashboardSummary } from "@fixtures/api-responses";

vi.mock("@/business/OrderDetailView/OrderDetail", () => ({ OrderDetail: ({ contextOrderId, onPartyClick }: { contextOrderId: number; onPartyClick?: (party: { entityType: "customer" | "counterparty"; id: number }) => void }) => <div>台账订单详情 {contextOrderId}<button onClick={() => onPartyClick?.({ entityType: "customer", id: 7 })}>客户详情</button><button onClick={() => onPartyClick?.({ entityType: "counterparty", id: 8 })}>合作方详情</button></div> }));
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
  vi.mocked(notificationsApi.syncReminders).mockResolvedValue({ created: 0 });
  vi.mocked(notificationsApi.profitDetails).mockResolvedValue([]);
  vi.mocked(notificationsApi.markReadBatch).mockImplementation(async (ids) => ({ read_ids: ids, read_at: "2026-11-21T10:00:00", next_read_id: null }));
});

describe("工作台消息", () => {
it("离开工作台时关闭已打开的消息弹窗", async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [{ id: 1, title: "提醒详情", message: "消息内容", entity_type: "other", entity_id: "1", read_at: "2026-11-21" }], next_cursor: null });
    const view = renderLight(<BusinessAlerts active />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: /消息内容/ }));
    expect(await screen.findByText("提醒详情")).toBeInTheDocument();
    view.rerender(<BusinessAlerts active={false} />);
    await waitFor(() => expect(screen.queryByText("提醒详情")).not.toBeInTheDocument());
  });

it("消息分类展示最新、售出和库存", async () => {
    const view = renderLight(<BusinessAlerts />, { user: "admin" });
    await screen.findByText("暂无消息");
    for (const label of ["最新消息", "售出消息", "库存消息", "合约消息"]) expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "售出消息" }));
    await waitFor(() => expect(notificationsApi.list).toHaveBeenCalledWith(expect.objectContaining({ category: "sale" })));
    fireEvent.click(screen.getByRole("tab", { name: "库存消息" }));
    await waitFor(() => expect(notificationsApi.list).toHaveBeenCalledWith(expect.objectContaining({ category: "inventory" })));
    fireEvent.click(screen.getByRole("tab", { name: "合约消息" }));
    await waitFor(() => expect(notificationsApi.list).toHaveBeenCalledWith(expect.objectContaining({ category: "contract" })));
    expect(notificationsApi.syncReminders).toHaveBeenCalledTimes(1);
    view.unmount();
    vi.mocked(notificationsApi.syncReminders).mockClear().mockRejectedValueOnce(new Error("网络不可用"));
    renderLight(<BusinessAlerts />, { user: "admin" });
    expect(await screen.findByText("提醒同步失败。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByText("提醒同步失败。")).not.toBeInTheDocument());
    expect(notificationsApi.syncReminders).toHaveBeenCalledTimes(2);
  });
it("合约提醒可查看并标记已读", async () => {
    vi.mocked(notificationsApi.list).mockImplementation(async ({ category }) => ({ items: category === "contract" ? [{ id: 12, notification_type: "INSTALLMENT_OVERDUE", title: "分期逾期提醒", message: "订单 HS12 第 1 期已逾期", entity_type: "installment_schedule", entity_id: "12", created_at: "2026-11-21T09:30:00", read_at: null }] : [], next_cursor: null }));
    vi.mocked(notificationsApi.markReadBatch).mockResolvedValue({ read_ids: [12], read_at: "2026-11-21T10:00:00", next_read_id: null });
    renderLight(<BusinessAlerts />, { user: "admin" });
    fireEvent.click(screen.getByRole("tab", { name: "合约消息" }));
    const item = await screen.findByRole("button", { name: /订单 HS12/ });
    expect(within(item).getByText("未读")).toBeInTheDocument();
    fireEvent.click(item);
    expect(await screen.findByText("分期逾期提醒")).toBeInTheDocument();
    expect(notificationsApi.markReadBatch).toHaveBeenCalledWith([12], "contract");
    expect(within(item).getByText("已读")).toBeInTheDocument();
  });

it("未读消息逐页滚动加载且不自动标已读", async () => {
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    const items = Array.from({ length: 11 }, (_, i) => ({ id: 11 - i, notification_type: "OTHER", title: "提醒", message: `通知 ${11 - i}`, entity_type: "other", entity_id: String(i), created_at: "2026-11-21T09:30:00", read_at: null }));
    vi.mocked(notificationsApi.list).mockImplementation(async (params) => ({ items: params.cursor ? items.slice(10) : items.slice(0, 10), next_cursor: params.cursor ? null : "page-2" }));
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /通知 11/ });
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalled();
    const scroll = document.querySelector(".business-alerts__scroll")!;
    scroll.scrollTop = 400;
    fireEvent.scroll(scroll);
    expect(await screen.findByRole("button", { name: /^通知 1 未读.*通知时间/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    expect(notificationsApi.list).toHaveBeenCalledWith(expect.objectContaining({ cursor: "page-2", category: "latest" }));
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalled();
    height.mockRestore();
    clientHeight.mockRestore();
  });

it("点击分润通知只标记当前消息并展示详情", async () => {
    const items = [1, 2].map((id) => ({ id, notification_type: "PROFIT_ALLOCATED", title: "分润", message: `订单 HS${id} 分润`, entity_type: "order", entity_id: `HS${id}`, created_at: "2026-11-20T08:30:00", read_at: null }));
    vi.mocked(notificationsApi.list).mockResolvedValue({ items, next_cursor: null });
    vi.mocked(notificationsApi.profitDetails).mockImplementation(async (ids) => ids.map((id) => ({ notification_id: id, order_no: `HS${id}`, sale_amount: "300.00", cost_amount: "100.00", allocatable_profit: "150.00" })));
    vi.mocked(reportsApi.commission).mockResolvedValue({ order_groups: [{ order_id: 1, order_no: "HS1", inventory_date: "2026-11-10", outbound_date: "2026-11-20", profit_base: "300.00", personnel_profit_base: "180.00", orders: [{ user_id: 1, user_name: "何一", order_id: 1, order_no: "HS1", profit_base: "180.00", rate: "60.00" }, { user_id: null, user_name: "公司", order_id: 1, order_no: "HS1", profit_base: "120.00", rate: "40.00" }] }], people: [], total: { order_count: 1, profit_base: "300.00" } });
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: { id: 7 }, orders: [] } as never);
    vi.mocked(employeesApi.list).mockResolvedValue([]);
    const navigate = vi.fn();
    renderLight(<DashboardPage onDashboardNavigate={navigate} />, { user: "admin" });
    const button = await screen.findByRole("button", { name: /订单 HS1 分润/ });
    expect(within(button).getByText(/2026-11-20 08:30/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText("订单分润通知详情")).toBeInTheDocument();
    expect(notificationsApi.markReadBatch).toHaveBeenCalledWith([1], "latest");
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalledWith([2], "latest");
    expect(await screen.findByText("分润明细")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "比例" })).toBeInTheDocument();
    expect(screen.getByText("60.00%")).toBeInTheDocument();
    expect(reportsApi.commission).toHaveBeenCalledWith({ notification_id: 1 });
    expect(screen.getByText("出库日期")).toBeInTheDocument();
    expect(screen.getByText("售出金额")).toBeInTheDocument();
    expect(screen.getByText("成本")).toBeInTheDocument();
    expect(screen.getByText("可分配利润")).toBeInTheDocument();
    expect(screen.getByText("150.00")).toBeInTheDocument();
    expect(screen.getByText("可见人员分润合计")).toBeInTheDocument();
    expect(screen.getByText("何一")).toBeInTheDocument();
    expect(screen.queryByText("公司")).not.toBeInTheDocument();
    expect(screen.getAllByText("180.00")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "查看订单详情" }));
    expect(await screen.findByText("台账订单详情 1")).toBeInTheDocument();
    expect(ordersApi.executionDetail).toHaveBeenCalledWith(1, { fresh: true, imagePreviews: true });
    fireEvent.click(screen.getByRole("button", { name: "客户详情" }));
    expect(navigate).toHaveBeenCalledWith("/customers?customer_id=7");
  });

it("消息不等待库存同步和金额摘要，并在摘要返回后更新", async () => {
    let finishSync!: (result: { created: number }) => void;
    let finishDetails!: (result: { notification_id: number; order_no: string; sale_amount: string; cost_amount: string; allocatable_profit: string }[]) => void;
    vi.mocked(notificationsApi.syncReminders).mockImplementation(() => new Promise((resolve) => { finishSync = resolve; }));
    vi.mocked(notificationsApi.profitDetails).mockImplementation(() => new Promise((resolve) => { finishDetails = resolve; }));
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [{ id: 7, notification_type: "PROFIT_PENDING", title: "分润", message: "订单 HS7", entity_type: "order", entity_id: "HS7", created_at: "2026-11-20T08:30:00", read_at: null }], next_cursor: null });
    renderLight(<BusinessAlerts />, { user: "admin" });
    expect(await screen.findByRole("button", { name: /订单 HS7/ })).toBeInTheDocument();
    await act(async () => { finishDetails([{ notification_id: 7, order_no: "HS7", sale_amount: "200", cost_amount: "100", allocatable_profit: "60" }]); finishSync({ created: 0 }); });
    expect(await screen.findByText(/成本 100.00.*售出 200.00/)).toBeInTheDocument();
  });

it("库存同步新增提醒后更新列表", async () => {
    let finishSync!: (result: { created: number }) => void;
    vi.mocked(notificationsApi.syncReminders).mockImplementation(() => new Promise((resolve) => { finishSync = resolve; }));
    vi.mocked(notificationsApi.list).mockResolvedValueOnce({ items: [], next_cursor: null }).mockResolvedValue({ items: [{ id: 9, notification_type: "INVENTORY_AGING", title: "库存提醒", message: "新库存提醒", entity_type: "account", entity_id: "9", read_at: null }], next_cursor: null });
    renderLight(<BusinessAlerts />, { user: "admin" });
    expect(await screen.findByText("暂无消息")).toBeInTheDocument();
    await act(async () => { finishSync({ created: 1 }); });
    expect(await screen.findByRole("button", { name: /新库存提醒/ })).toBeInTheDocument();
    expect(notificationsApi.syncReminders).toHaveBeenCalledTimes(1);
  });

it("订单详情失败可重试并可打开客户和合作方", async () => {
    const navigate = vi.fn();
    vi.mocked(ordersApi.executionDetail).mockRejectedValueOnce(new Error("网络不可用")).mockResolvedValueOnce({ account: { id: 7 }, orders: [] } as never);
    vi.mocked(employeesApi.list).mockResolvedValue([]);
    renderLight(<OrderDetailDialog orderId={1} onClose={() => {}} onPartyNavigate={navigate} />, { user: "admin" });
    expect(await screen.findByText("订单详情加载失败，可能没有查看权限。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("台账订单详情 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "客户详情" }));
    fireEvent.click(screen.getByRole("button", { name: "合作方详情" }));
    expect(navigate).toHaveBeenCalledWith("/customers?customer_id=7");
    expect(navigate).toHaveBeenCalledWith("/customers?counterparty_id=8");
  });

it("分润详情加载失败后可重试且不改变已读状态", async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [{ id: 7, notification_type: "PROFIT_PENDING", title: "分润", message: "订单 HS7", entity_type: "order", entity_id: "HS7", created_at: "2026-11-20T08:30:00", read_at: null }], next_cursor: null });
    vi.mocked(notificationsApi.profitDetails).mockRejectedValueOnce(new Error("网络不可用")).mockResolvedValueOnce([{ notification_id: 7, order_no: "HS7", sale_amount: "200.00", cost_amount: "100.00", allocatable_profit: "60.00" }]);
    renderLight(<BusinessAlerts />, { user: "admin" });
    expect(await screen.findByText("分润详情加载失败。")).toBeInTheDocument();
    expect(screen.getByText("未读")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试分润详情" }));
    expect(await screen.findByText(/成本 100.00.*售出 200.00.*待分配利润 60.00/)).toBeInTheDocument();
    expect(screen.queryByText("分润详情加载失败。")).not.toBeInTheDocument();
    expect(notificationsApi.markReadBatch).not.toHaveBeenCalled();
  });

it("分润弹窗可重试且切换消息时不显示旧详情", async () => {
    const first = { id: 1, title: "分润", message: "订单 HS1", entity_type: "order", entity_id: "HS1" };
    const second = { ...first, id: 2, message: "订单 HS2", entity_id: "HS2" };
    const group = { order_id: 1, order_no: "HS1", inventory_date: "2026-11-10", outbound_date: "2026-11-20", profit_base: "300.00", personnel_profit_base: "300.00", orders: [{ user_id: 1, user_name: "人员一", order_id: 1, order_no: "HS1", profit_base: "300.00", rate: "100.00" }] };
    const report = { order_groups: [group], people: [], total: { order_count: 1, profit_base: "300.00" } };
    let finish!: (value: typeof report) => void;
    vi.mocked(reportsApi.commission).mockRejectedValueOnce(new Error("网络不可用")).mockResolvedValueOnce(report).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderLight(<ProfitNotificationModal selected={first} onClose={() => {}} />, { user: "admin" });
    expect(await screen.findByText("订单详情暂时无法查看。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("人员一")).toBeInTheDocument();
    view.rerender(<ProfitNotificationModal selected={second} onClose={() => {}} />);
    expect(screen.queryByText("人员一")).not.toBeInTheDocument();
    await act(async () => { finish({ ...report, order_groups: [{ ...group, order_id: 2, order_no: "HS2", orders: [{ ...group.orders[0], user_id: 2, user_name: "人员二", order_id: 2, order_no: "HS2" }] }] }); });
    expect(await screen.findByText("人员二")).toBeInTheDocument();
  });

it("连续点击消息均能打开且保持滚动位置", async () => {
    const items = [1, 2].map((id) => ({ id, notification_type: "PROFIT_PENDING", title: "分润", message: `订单 ${id}`, entity_type: "order", entity_id: `${id}`, created_at: "2026-11-20T08:30:00", read_at: null }));
    vi.mocked(notificationsApi.list).mockResolvedValue({ items, next_cursor: null });
    const pending: Record<number, (value: { read_ids: number[]; read_at: string | null; next_read_id: number | null }) => void> = {};
    vi.mocked(notificationsApi.markReadBatch).mockImplementation(([id]) => new Promise((resolve) => { pending[id] = resolve; }));
    const open = vi.fn();
    renderLight(<BusinessAlerts onPendingProfitNotificationsClick={open} />, { user: "admin" });
    fireEvent.click(screen.getByRole("tab", { name: "售出消息" }));
    const first = await screen.findByRole("button", { name: /订单 1/ });
    const second = screen.getByRole("button", { name: /订单 2/ });
    const scroll = document.querySelector(".business-alerts__scroll") as HTMLDivElement;
    scroll.scrollTop = 150;
    const listCalls = vi.mocked(notificationsApi.list).mock.calls.length;
    fireEvent.click(first);
    fireEvent.click(second);
    pending[1]({ read_ids: [1], read_at: "2026-11-21T10:00:00", next_read_id: null });
    await waitFor(() => expect(open).toHaveBeenCalledWith(1));
    pending[2]({ read_ids: [2], read_at: "2026-11-21T10:00:00", next_read_id: 1 });
    await waitFor(() => expect(open).toHaveBeenCalledWith(2));
    expect(scroll.scrollTop).toBe(150);
    await waitFor(() => expect(within(first).getByText("已读")).toBeInTheDocument());
    expect(notificationsApi.list).toHaveBeenCalledTimes(listCalls);
    expect(second.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary());
    vi.mocked(notificationsApi.pendingOrder).mockResolvedValue({ order_no: "TH0002", order_id: 43 });
    vi.mocked(notificationsApi.list).mockResolvedValue({ items: [
      { id: 2, title: "订单分润待配置", message: "订单 TH0002 待配置分润", notification_type: "PROFIT_PENDING", entity_type: "order", entity_id: "TH0002", created_at: "2026-11-21T09:30:00", read_at: null },
      { id: 3, title: "订单分润待配置", message: "订单 HS0001 待配置分润", notification_type: "PROFIT_PENDING", entity_type: "order", entity_id: "HS0001", read_at: "2026-11-20T10:00:00" },
    ], next_cursor: null });
    vi.mocked(notificationsApi.markReadBatch).mockResolvedValue({ read_ids: [2], read_at: "2026-11-21T10:00:00", next_read_id: null });
    vi.mocked(notificationsApi.profitDetails).mockResolvedValue([{ notification_id: 2, order_no: "TH0002", cost_amount: "100.00", sale_amount: "200.00", allocatable_profit: "60.00" }]);

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
    await waitFor(() => expect(onDashboardNavigate).toHaveBeenCalledWith("/business/ledger?allocation_order_id=43&keyword=TH0002"));
    expect(notificationsApi.pendingOrder).toHaveBeenCalledWith(2);
    expect(ordersApi.listPage).not.toHaveBeenCalled();
    expect(notificationsApi.markReadBatch).toHaveBeenCalledWith([2], "sale");
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

it("消息为空时显示空状态", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      inventory: { account_count: 1, aging_count: 0, overdue_count: 0 },
      installments: { total_count: 1, overdue_count: 1 },
    }));

    renderLight(<DashboardPage />, { user: "admin" });

    const alerts = await screen.findByRole("region", { name: "我的消息" });
    expect(await within(alerts).findByText("暂无消息")).toBeInTheDocument();
    expect(vi.mocked(dashboardApi.summary)).toHaveBeenCalledTimes(1);
  });

});
