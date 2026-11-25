import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { setAntdDateRange } from "@fixtures/antdRange";
import { WorkbenchPage } from "@/workbench/WorkbenchPage";
import { workbenchApi } from "@/shared/api/workbench.api";
import { notificationsApi } from "@/shared/api/notifications.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { currentReportPeriod } from "@/shared/lib/reportPeriod";
import { workbenchSummary } from "@fixtures/api-responses";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { ordersApi, orderTypesApi } from "@/shared/api/orders.api";
import { gameTypesApi } from "@/shared/api/misc.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";

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

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(optionSetsApi.get).mockResolvedValue(undefined as never);
  vi.mocked(workbenchApi.summary).mockImplementation(async (period) =>
    workbenchSummary({ period: period === undefined ? currentReportPeriod() : period }));
  vi.mocked(notificationsApi.list).mockResolvedValue({ items: [], next_cursor: null });
  vi.mocked(notificationsApi.syncReminders).mockResolvedValue({ created: 0 });
  vi.mocked(notificationsApi.profitDetails).mockResolvedValue([]);
});

describe("WorkbenchPage.deep：失败路径/计数/未覆盖入口", () => {
  it("快捷入口建单成功后关闭弹窗并刷新业务总览", async () => {
    seedOptionSets();
    seedOrderFormFields();
    vi.mocked(orderTypesApi.list).mockResolvedValue([{ id: 1, code: "HS", name: "回收", is_active: true }]);
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 1, name: "主账户", code: "MAIN", status: "ACTIVE" }] as never);
    vi.mocked(gameTypesApi.list).mockResolvedValue([{ id: 1, value: "game_01", name: "王者荣耀", sort_order: 10, is_active: true, is_default: true,
      channel_regions: [{ value: "channel_01", label: "安卓一区" }] }]);
    vi.mocked(employeesApi.list).mockResolvedValue([{ id: 1, username: "admin", display_name: "系统管理员", is_active: true }] as never);
    vi.mocked(ordersApi.create).mockResolvedValue({ id: 31, order_no: "HS0031", status: "ACTIVE" } as never);
    vi.mocked(workbenchApi.summary)
      .mockResolvedValueOnce(workbenchSummary({ period: currentReportPeriod(), orders: { total_count: 1 } }))
      .mockResolvedValue(workbenchSummary({ period: currentReportPeriod(), orders: { total_count: 2 } }));

    renderLight(<WorkbenchPage />, { user: "admin" });
    const total = screen.getByTestId("workbench-orders");
    expect(await within(total).findByText("1")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /自营·回收/ }));
    expect(await screen.findByText("新建回收订单", {}, { timeout: 10_000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("游戏类型")).toBeEnabled());
    await ui.click(screen.getByLabelText("游戏类型"));
    await ui.click(await screen.findByText("王者荣耀", { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("游戏账号"), "recovery-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.click(screen.getByLabelText("渠道／区服"));
    await ui.click(await screen.findByText("安卓一区", { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("客户昵称"), "张三");
    await ui.type(screen.getByPlaceholderText("请输入金额"), "1000");
    const pool = screen.getByText("请选择资金账户", { exact: true });
    await ui.click(pool.closest(".ant-select")!.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));

    await waitFor(() => expect(ordersApi.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText("新建回收订单")).not.toBeInTheDocument());
    expect(await within(total).findByText("2")).toBeInTheDocument();
    expect(workbenchApi.summary).toHaveBeenCalledTimes(2);
  });

  it("加载失败展示错误横幅", async () => {
    vi.mocked(workbenchApi.summary).mockRejectedValue(new Error("workbench down"));
    renderLight(<WorkbenchPage />, { user: "admin" });
    expect((await screen.findAllByText(/workbench down/)).length).toBeGreaterThan(0);
    const alerts = screen.getByRole("region", { name: "我的消息" });
    expect(await within(alerts).findByText("暂无消息")).toBeInTheDocument();
  });

  it("没有订单权限时个人订单和客户数显示占位且不可跳转", async () => {
    const navigate = vi.fn();
    vi.mocked(workbenchApi.summary).mockResolvedValue(workbenchSummary({ period: currentReportPeriod(), orders: null, personal_orders: null, personal_customers: null, inventory: null, installments: null }));
    renderLight(<WorkbenchPage onWorkbenchNavigate={navigate} />, { user: "admin" });
    await screen.findByRole("tab", { name: "最新消息" });
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("region", { name: "我的业务总览" })).toHaveAttribute("aria-busy", "false"));
    for (const id of ["workbench-personal-orders", "workbench-personal-customers"]) {
      const card = screen.getByTestId(id);
      await waitFor(() => expect(within(card).getByText("-")).toBeInTheDocument());
      expect(card).not.toHaveAttribute("role", "button");
    }
  });

  it("错误横幅重试：点「重新加载」再次请求订单汇总", async () => {
    vi.mocked(workbenchApi.summary).mockRejectedValue(new Error("workbench down"));
    renderLight(<WorkbenchPage />, { user: "admin" });
    expect(await screen.findAllByText(/workbench down/)).toBeTruthy();
    await ui.click(screen.getAllByRole("button", { name: /重新加载/ })[0]);
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenCalledTimes(2));
  });

  it("我的当期卡片展示当前登录用户的订单数与分润收益", async () => {
    vi.mocked(workbenchApi.summary).mockResolvedValue(workbenchSummary({
      period: currentReportPeriod(),
      orders: { total_count: 3 },
      personal_orders: 2,
      personal_customers: 2,
      personal_earnings: "123.45",
    }));
    renderLight(<WorkbenchPage />, { user: "operator" });

    await waitFor(() => expect(workbenchApi.summary).toHaveBeenCalledTimes(1));
    const orderCard = (await screen.findByText("我的当期订单")).closest(".ui-stat") as HTMLElement;
    const totalCard = (await screen.findByText("订单总量")).closest(".ui-stat") as HTMLElement;
    const customerCard = (await screen.findByText("我的当期客户数")).closest(".ui-stat") as HTMLElement;
    const earningsCard = screen.getByText("我的当期收益").closest(".ui-stat") as HTMLElement;
    expect(await within(orderCard).findByText("2")).toBeInTheDocument();
    expect(within(totalCard).getByText("3")).toBeInTheDocument();
    expect(within(customerCard).getByText("2")).toBeInTheDocument();
    expect(within(earningsCard).getByText("123.45")).toBeInTheDocument();
    expect(within(earningsCard).getByText("当期 · 本人分润基数")).toBeInTheDocument();
    expect(within(earningsCard).queryByText("999.99")).toBeNull();
  });

  it("业务总览卡片跳转到对应明细并携带当前周期与状态", async () => {
    const onWorkbenchNavigate = vi.fn();
    renderLight(<WorkbenchPage onWorkbenchNavigate={onWorkbenchNavigate} />, { user: "admin" });

    await waitFor(() => expect(screen.getAllByLabelText("当期日期区间")[0]).toBeEnabled());
    await setAntdDateRange(document.body, ui, "2026-11-01", "2026-11-16");
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenLastCalledWith({ from: "2026-11-01", to: "2026-11-16" }));
    await waitFor(() => expect(screen.getByTestId("workbench-personal-orders")).toHaveAttribute("role", "button"));
    await ui.click((await screen.findByText("我的当期订单")).closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("我的当期收益").closest(".ui-stat") as HTMLElement);
    await ui.click((await screen.findByText("在库账号")).closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("订单总量").closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("我的当期客户数").closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("分期合约").closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("逾期合约").closest(".ui-stat") as HTMLElement);
    await ui.click(screen.getByText("在库超期账号").closest(".ui-stat") as HTMLElement);

    expect(onWorkbenchNavigate.mock.calls).toEqual([
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
    vi.mocked(workbenchApi.summary).mockRejectedValue(new Error("workbench down"));
    renderLight(<WorkbenchPage />, { user: "admin" });
    const totalCard = (await screen.findByText("订单总量")).closest(".ui-stat") as HTMLElement;
    const customerCard = (await screen.findByText("我的当期客户数")).closest(".ui-stat") as HTMLElement;
    expect(within(totalCard).getByText("-")).toBeInTheDocument();
    expect(within(customerCard).getByText("-")).toBeInTheDocument();
    // 反证：失败态绝不允许回落到 0 计数（改回 String(...length) 本例会红）
    expect(within(totalCard).queryByText("0")).toBeNull();
    expect(within(customerCard).queryByText("0")).toBeNull();
  });
});
