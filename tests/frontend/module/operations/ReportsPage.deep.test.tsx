import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { ReportsPage } from "@/reporting/ReportsPage";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";
import { appMessage } from "@/shared/ui/appFeedback";

import { ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { reportsApi } from "@/shared/api/reports.api";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

// 报表 DataTable 重型，替换为轻量实现（与 ReportsPage.test.tsx 一致），
// MoneyText / StatusTag / StatRow / ErrorBanner 仍用真实组件。
vi.mock("@/shared/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { LightweightDataTable } = await import("@fixtures/LightweightDataTable");
  return { ...actual, DataTable: LightweightDataTable };
});


beforeEach(() => {
  vi.clearAllMocks();
  resolveMock(vi.mocked(reportsApi.monthlyPnl), { items: [], total: {} });
  resolveMock(vi.mocked(reportsApi.commission), {
    order_groups: [],
    total: { order_count: 0, profit_base: "0", payable: "0", paid: "0", difference: "0" },
  });
  vi.mocked(employeesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(reportsApi.businessPnl), { items: [], total: {} });
  resolveMock(vi.mocked(reportsApi.orderProfit), {
    items: [],
    total: { income: "0", cost: "0", rebate: "0", net_profit: "0" },
  });
  resolveMock(vi.mocked(reportsApi.exportCsv), new Blob(["csv"]));
  // 数据中心面板（同页挂载）：空池空单——本文件只关心报表 Tab，桩位兜底即可。
  vi.mocked(poolsApi.list).mockResolvedValue([]);
  // 空池 → 批量余额返回空 items 与零汇总（服务端聚合）。
  resolveMock(vi.mocked(poolsApi.balances), {
    items: [],
    totals: { pool_count: 0, cash_balance: "0.00", available: "0.00", deposit_held: "0.00", owned_cash_balance: "0.00" },
  });
  vi.mocked(ordersApi.list).mockResolvedValue([]);
});

async function gotoTab(label: string) {
  await ui.click(screen.getByRole("tab", { name: label }));
}

describe("ReportsPage：其余报表 Tab 渲染与导出成功分支", () => {
  it("分润对账：按订单汇总并展开查看每个人的分润明细", async () => {
    vi.mocked(employeesApi.list).mockResolvedValueOnce([
      { id: 1, username: "zhang", display_name: "张三", is_active: true },
      { id: 2, username: "li", display_name: "李四", is_active: true },
    ]);
    resolveMockOnce(vi.mocked(reportsApi.commission), {
      order_groups: [{
        order_id: 10,
        order_no: "HS-2026-0010",
        inventory_date: "2026-10-02",
        outbound_date: "2026-10-04",
        profit_base: "200.00",
        orders: [
          { user_id: 1, order_id: 10, order_no: "HS-2026-0010", profit_base: "100.00", rate: "0.10" },
          { user_id: 2, order_id: 10, order_no: "HS-2026-0010", profit_base: "100.00", rate: "0.10" },
        ],
      }],
      total: { order_count: 1, profit_base: "200.00", payable: "20.00", paid: "10.00", difference: "10.00" },
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("分润对账");
    await screen.findAllByText("HS-2026-0010");
    expect(screen.getAllByText("HS-2026-0010")).toHaveLength(1);
    expect(screen.getByText("入库日期")).toBeInTheDocument();
    expect(screen.getByText("出库日期")).toBeInTheDocument();
    expect(screen.getByText("2026-10-02")).toBeInTheDocument();
    expect(screen.getByText("2026-10-04")).toBeInTheDocument();
    expect(screen.queryByText("分润基数")).toBeNull();
    await ui.click(screen.getByRole("button", { name: /展开.*HS-2026-0010/ }));
    expect(await screen.findByText("分润基数")).toBeInTheDocument();
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("李四")).toBeInTheDocument();
    expect(screen.getAllByText("0.10")).toHaveLength(2); // 展开明细的费率列
    expect(screen.getAllByText("分润合计")).toHaveLength(2); // StatRow label + table header
    expect(screen.queryByText("应付合计")).toBeNull();
    expect(screen.queryByText("已付合计")).toBeNull();
    expect(screen.queryByText("差异")).toBeNull();
  });

  it("分润对账：只消费订单分组契约，不回退旧明细", async () => {
    resolveMockOnce(vi.mocked(reportsApi.commission), {
      order_groups: [],
      total: { order_count: 0, profit_base: "0.00", payable: "0.00", paid: "0.00", difference: "0.00" },
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("分润对账");
    await waitFor(() => expect(screen.queryByText("LEGACY-001")).not.toBeInTheDocument());
  });

  it("资金日报已下线，经营中心不再重复展示资金日报", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    expect(screen.queryByRole("tab", { name: "资金日报" })).toBeNull();
  });

  it("FE-051：共享日期区间传递到经营报表和订单利润", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    const setFrom = async (report: "operating" | "commission" | "profit") => {
      const labels = {
        operating: "经营损益",
        commission: "分润对账",
        profit: "订单利润",
      } as const;
      await gotoTab(labels[report]);
      const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
      const input = pane.querySelector<HTMLInputElement>(".ui-control-width-date")!;
      await ui.clear(input);
      await ui.type(input, "2026-10-01");
    };
    await setFrom("operating");
    await waitFor(() => expect(vi.mocked(reportsApi.monthlyPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
    await waitFor(() => expect(vi.mocked(reportsApi.businessPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
    await setFrom("commission");
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith({ from: "2026-10-01", all_people: true }));
    await setFrom("profit");
    await waitFor(() => expect(vi.mocked(reportsApi.orderProfit)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
  });

  it("FE-053：页内导出成功后创建下载锚点并显示结果反馈", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const successSpy = vi.spyOn(appMessage, "success").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("经营损益");
    const monthlyCard = screen.getByText("月度经营损益").closest(".ant-card") as HTMLElement;
    await ui.click(within(monthlyCard).getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => expect(vi.mocked(reportsApi.exportCsv)).toHaveBeenCalledWith("monthly-pnl", { from: undefined, to: undefined }));
    expect(createUrl).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith("已导出 monthly-pnl.csv");
    createUrl.mockRestore();
    revokeUrl.mockRestore();
  });

  it("导出日期反向时阻止请求并提示范围错误", async () => {
    const errorSpy = vi.spyOn(appMessage, "error").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const dateInputs = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    await ui.type(dateInputs[0], "2026-10-31");
    await ui.type(dateInputs[1], "2026-10-01");
    await ui.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("导出开始日期不能晚于结束日期"));
    expect(vi.mocked(reportsApi.exportCsv)).not.toHaveBeenCalled();
  });

  it("统计周期变更同时触发月度与业务损益重新请求", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("经营损益");
    await screen.findAllByText("销售收入"); // MonthlyPnl StatRow + 列标题一定渲染
    // 父级提升的日期输入无 label，按激活 Tab 面板内的 class 定位（避开导出区的日期输入）
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const dateInputs = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    await ui.type(dateInputs[0], "2026-01-01");
    // 区间变化 → monthlyPnl 重新请求（deps 含 params.from）
    await waitFor(() =>
      expect(vi.mocked(reportsApi.monthlyPnl)).toHaveBeenCalledWith({ from: "2026-01-01", to: undefined }),
    );
    await waitFor(() =>
      expect(vi.mocked(reportsApi.businessPnl)).toHaveBeenCalledWith({ from: "2026-01-01", to: undefined }),
    );
  });

  it("FE-270：月度损益和业务损益历史空区间清空旧明细", async () => {
    vi.mocked(reportsApi.monthlyPnl).mockImplementation((params) => Promise.resolve(
      params?.from ? { items: [], total: { sales_income: "0", operating_profit: "0" } } : {
        items: [{ month: "2026-11", sales_income: "100", cost: "50", operating_expense: "0", rebate_income: "0", operating_profit: "50" }],
        total: { sales_income: "100", operating_profit: "50" },
      },
    ) as never);
    vi.mocked(reportsApi.businessPnl).mockImplementation((params) => Promise.resolve(
      params?.from ? { items: [], total: { main_profit: "0" } } : {
        items: [{ order_type: "HS", business_mode: "SELF", main_income: "100", cost: "50", main_profit: "50" }],
        total: { main_profit: "50" },
      },
    ) as never);
    renderLight(<ReportsPage />, { user: "admin" });

    await gotoTab("经营损益");
    await screen.findByText("2026-11");
    let pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const r2Dates = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    await ui.clear(r2Dates[0]);
    await ui.type(r2Dates[0], "2026-10-01");
    await ui.clear(r2Dates[1]);
    await ui.type(r2Dates[1], "2026-10-31");
    await waitFor(() => expect(vi.mocked(reportsApi.monthlyPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31" }));
    await waitFor(() => expect(vi.mocked(reportsApi.businessPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31" }));
    await waitFor(() => expect(screen.queryByText("2026-11")).not.toBeInTheDocument());
  });

  it("FE-272：订单利润历史空区间清空收入成本和净利明细", async () => {
    vi.mocked(reportsApi.orderProfit).mockImplementation((params) => Promise.resolve(
      params?.from ? { items: [], total: { income: "0", cost: "0", rebate: "0", net_profit: "0" } } : {
        items: [{ order_no: "HS-FE272", order_type: "HS", trade_date: "2026-11-01", status: "DONE", income: "100", cost: "60", rebate: "0", net_profit: "40" }],
        total: { income: "100", cost: "60", rebate: "0", net_profit: "40" },
      },
    ) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");
    await screen.findByText("HS-FE272");
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const dates = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    await ui.clear(dates[0]);
    await ui.type(dates[0], "2026-10-01");
    await ui.clear(dates[1]);
    await ui.type(dates[1], "2026-10-31");
    await waitFor(() => expect(vi.mocked(reportsApi.orderProfit)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31" }));
    await waitFor(() => expect(screen.queryByText("HS-FE272")).not.toBeInTheDocument());
  });

  it("FE-273：分润对账日期筛选切换到历史空态", async () => {
    vi.mocked(reportsApi.commission).mockImplementation((params) => Promise.resolve(
      params?.from ? { order_groups: [], total: { order_count: 0, profit_base: "0", payable: "0", paid: "0", difference: "0" } } : {
        order_groups: [{ order_id: 273, order_no: "HS-FE273", profit_base: "10", orders: [{ user_id: 1, order_id: 273, order_no: "HS-FE273", profit_base: "10", rate: "0.1" }] }],
        total: { order_count: 1, profit_base: "10", payable: "1", paid: "0", difference: "1" },
      },
    ) as never);
    renderLight(<ReportsPage />, { user: "admin" });

    await gotoTab("分润对账");
    await screen.findByText("HS-FE273");
    let pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const r3Dates = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    await ui.clear(r3Dates[0]);
    await ui.type(r3Dates[0], "2026-10-01");
    await ui.clear(r3Dates[1]);
    await ui.type(r3Dates[1], "2026-10-31");
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31", all_people: true }));
    await waitFor(() => expect(screen.queryByText("HS-FE273")).not.toBeInTheDocument());

  });

  it("分润对账加载失败显示错误条，点「重新加载」可重试成功", async () => {
    vi.mocked(reportsApi.commission).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" } as unknown as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("分润对账");
    await waitFor(() => expect(document.querySelector(".ui-error-banner")).toBeTruthy());
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await screen.findAllByText("分润合计"); // 重试成功后渲染 Commission StatRow + table header
  });
});
