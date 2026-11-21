import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DashboardPage } from "@/app/DashboardPage";
import { dashboardApi } from "@/shared/api/dashboard.api";
import { notificationsApi } from "@/shared/api/misc.api";
import { dashboardSummary } from "@fixtures/api-responses";

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
vi.mock("@/shared/api/stocks.api");;

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary());
  vi.mocked(notificationsApi.list).mockResolvedValue({ items: [], total: 0, unread_total: 0 });
  vi.mocked(notificationsApi.profitDetails).mockResolvedValue([]);
});

describe("DashboardPage.deep：失败路径/计数/未覆盖入口", () => {
  it("加载失败展示错误横幅", async () => {
    vi.mocked(dashboardApi.summary).mockRejectedValue(new Error("dashboard down"));
    renderLight(<DashboardPage />, { user: "admin" });
    expect((await screen.findAllByText(/dashboard down/)).length).toBeGreaterThan(0);
    const alerts = screen.getByRole("region", { name: "我的消息" });
    expect(await within(alerts).findByText("暂无消息")).toBeInTheDocument();
  });

  it("没有订单权限时个人订单和客户数显示占位且不可跳转", async () => {
    const navigate = vi.fn();
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({ orders: null, personal_orders: null, personal_customers: null, inventory: null, installments: null, alerts: [{ type: "pending_profit", message: "分润待配置 7 条" }] }));
    renderLight(<DashboardPage onDashboardNavigate={navigate} />, { user: "admin" });
    await screen.findByRole("tab", { name: "最新消息" });
    await waitFor(() => expect(dashboardApi.summary).toHaveBeenCalled());
    for (const id of ["dashboard-personal-orders", "dashboard-personal-customers"]) {
      const card = screen.getByTestId(id);
      await waitFor(() => expect(within(card).getByText("-")).toBeInTheDocument());
      expect(card).not.toHaveAttribute("role", "button");
    }
  });

  it("错误横幅重试：点「重新加载」再次请求订单汇总", async () => {
    vi.mocked(dashboardApi.summary).mockRejectedValue(new Error("dashboard down"));
    renderLight(<DashboardPage />, { user: "admin" });
    expect(await screen.findAllByText(/dashboard down/)).toBeTruthy();
    await ui.click(screen.getAllByRole("button", { name: /重新加载/ })[0]);
    await waitFor(() => expect(dashboardApi.summary).toHaveBeenCalledTimes(2));
  });

  it("业务总览计数：订单总量与我的当期客户数", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      orders: { total_count: 3 },
      personal_customers: 2,
    }));
    renderLight(<DashboardPage />, { user: "admin" });
    const totalCard = (await screen.findByText("订单总量")).closest(".ui-stat") as HTMLElement;
    const customerCard = (await screen.findByText("我的当期客户数")).closest(".ui-stat") as HTMLElement;
    expect(await within(totalCard).findByText("3")).toBeInTheDocument();
    expect(await within(customerCard).findByText("2")).toBeInTheDocument();
  });

  it("我的当期卡片展示当前登录用户的订单数与分润收益", async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      orders: { total_count: 3 },
      personal_orders: 2,
      personal_customers: 2,
      personal_earnings: "123.45",
    }));
    renderLight(<DashboardPage />, { user: "operator" });

    await waitFor(() => expect(dashboardApi.summary).toHaveBeenCalledTimes(1));
    const orderCard = (await screen.findByText("我的当期订单")).closest(".ui-stat") as HTMLElement;
    const totalCard = (await screen.findByText("订单总量")).closest(".ui-stat") as HTMLElement;
    const earningsCard = screen.getByText("我的当期收益").closest(".ui-stat") as HTMLElement;
    expect(within(orderCard).getByText("2")).toBeInTheDocument();
    expect(within(totalCard).getByText("3")).toBeInTheDocument();
    expect(within(earningsCard).getByText("123.45")).toBeInTheDocument();
    expect(within(earningsCard).getByText("当期 · 本人分润基数")).toBeInTheDocument();
    expect(within(earningsCard).queryByText("999.99")).toBeNull();
  });

  it("业务总览卡片跳转到对应明细并携带当前周期与状态", async () => {
    const onDashboardNavigate = vi.fn();
    vi.mocked(dashboardApi.summary).mockResolvedValue(dashboardSummary({
      period: { from: "2026-11-01", to: "2026-11-16" },
    }));
    renderLight(<DashboardPage onDashboardNavigate={onDashboardNavigate} />, { user: "admin" });

    await waitFor(() => expect(screen.getByTestId("dashboard-personal-orders")).toHaveAttribute("role", "button"));
    await ui.click((await screen.findByText("我的当期订单")).closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("我的当期收益").closest(".ui-stat") as HTMLElement);
    await ui.click((await screen.findByText("在库账号")).closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("订单总量").closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("我的当期客户数").closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("分期合约").closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("逾期合约").closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("在库超期账号").closest(".ui-stat") as HTMLElement);

    expect(onDashboardNavigate.mock.calls).toEqual([
      ["/business/ledger?mine=true&trade_date_from=2026-11-01&trade_date_to=2026-11-16"],
      ["/operations?tab=my-earnings&from=2026-11-01&to=2026-11-16"],
      ["/business/inventory"],
      ["/business/ledger?trade_date_from=2026-11-01&trade_date_to=2026-11-16"],
      ["/customers?mine_orders=true&trade_date_from=2026-11-01&trade_date_to=2026-11-16"],
      ["/business/collections"],
      ["/business/collections?status=OVERDUE"],
      ["/business/inventory?age_gt_days=30"],
    ]);
  });

  it("订单汇总接口失败时业务总览显示占位「-」而非 0", async () => {
    // 经营场景里「0」有确定业务含义；接口失败若渲染成 0，用户会误判为「今天没有业务」。
    vi.mocked(dashboardApi.summary).mockRejectedValue(new Error("dashboard down"));
    renderLight(<DashboardPage />, { user: "admin" });
    const totalCard = (await screen.findByText("订单总量")).closest(".ui-stat") as HTMLElement;
    const customerCard = (await screen.findByText("我的当期客户数")).closest(".ui-stat") as HTMLElement;
    expect(within(totalCard).getByText("-")).toBeInTheDocument();
    expect(within(customerCard).getByText("-")).toBeInTheDocument();
    // 反证：失败态绝不允许回落到 0 计数（改回 String(...length) 本例会红）
    expect(within(totalCard).queryByText("0")).toBeNull();
    expect(within(customerCard).queryByText("0")).toBeNull();
  });

  it("点「代挂」卡打开代挂登记弹窗", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: "代挂" });
    await ui.click(screen.getByRole("button", { name: "代挂" }));
    expect(await screen.findByText("新建代挂订单")).toBeInTheDocument();
  });
});
