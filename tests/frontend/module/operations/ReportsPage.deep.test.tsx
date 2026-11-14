import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
vi.mock("@/shared/api/quality.api");
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
    items: [],
    total: { order_count: 0, payable: "0", paid: "0", difference: "0" },
  });
  vi.mocked(employeesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(reportsApi.dailyFunds), { date: "2026-10-01", total: {}, items: [] });
  resolveMock(vi.mocked(reportsApi.businessPnl), { items: [], total: {} });
  resolveMock(vi.mocked(reportsApi.orderProfit), {
    items: [],
    total: { income: "0", direct_cost: "0", rebate: "0", net_profit: "0" },
  });
  resolveMock(vi.mocked(reportsApi.exportCsv), new Blob(["csv"]));
  // 数据中心面板（同页挂载）：空池空单——本文件只关心报表 Tab，桩位兜底即可。
  vi.mocked(poolsApi.list).mockResolvedValue([]);
  // 空池 → 批量余额返回空 items 与零汇总（服务端聚合）。
  resolveMock(vi.mocked(poolsApi.balances), {
    items: [],
    totals: { cash_balance: "0.00", available: "0.00", deposit_held: "0.00", owned_cash_balance: "0.00" },
  });
  vi.mocked(ordersApi.list).mockResolvedValue([]);
});

async function gotoTab(label: string) {
  await ui.click(screen.getByRole("tab", { name: label }));
}

describe("ReportsPage：其余报表 Tab 渲染与导出成功分支", () => {
  it("分润对账：渲染人员/订单/费率/应付与差异统计", async () => {
    resolveMockOnce(vi.mocked(reportsApi.commission), {
      items: [
        { user_id: 1, order_no: "HS-2026-0010", profit_base: "100.00", rate: "0.10", payable: "10.00", paid: "5.00", difference: "5.00" },
      ],
      total: { order_count: 1, payable: "10.00", paid: "5.00", difference: "5.00" },
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("分润对账");
    await screen.findByText("HS-2026-0010");
    expect(screen.getByText("0.10")).toBeInTheDocument(); // 费率列
    expect(screen.getByText("应付合计")).toBeInTheDocument(); // StatRow label
    expect(screen.getAllByText("差异").length).toBeGreaterThanOrEqual(1); // StatRow + 列标题
  });

  it("资金日报：渲染资金池/期初/收支/余额与标题日期", async () => {
    resolveMockOnce(vi.mocked(reportsApi.dailyFunds), {
      date: "2026-10-08",
      total: { cash_balance: "80.00", deposit_held: "10.00", available: "70.00" },
      items: [
        { pool_name: "POOL-A", opening: "100.00", income: "50.00", expense: "20.00", deposit_held: "10.00", cash_balance: "80.00", available: "70.00" },
      ],
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("资金日报");
    expect((await screen.findAllByText("POOL-A")).length).toBeGreaterThanOrEqual(1); // 资金池/名称两列同值
    expect(screen.getByText(/2026-10-08/)).toBeInTheDocument(); // 标题含日期
    expect(screen.getAllByText("现金余额").length).toBeGreaterThanOrEqual(1); // StatRow + 列标题
    expect(screen.getAllByText("可用余额").length).toBeGreaterThanOrEqual(1); // StatRow + 列标题
  });

  it("资金日报：切换日期带 on 参数重新拉取（#56）", async () => {
    vi.mocked(reportsApi.dailyFunds).mockClear();
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("资金日报");
    await waitFor(() => expect(vi.mocked(reportsApi.dailyFunds)).toHaveBeenCalled());
    const dateInput = screen.getByLabelText("资金日报日期");
    fireEvent.change(dateInput, { target: { value: "2026-10-08" } });
    await waitFor(() => expect(vi.mocked(reportsApi.dailyFunds)).toHaveBeenLastCalledWith({ on: "2026-10-08" }));
  });

  it("FE-051：共享日期区间传递到经营报表和订单利润", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    const setFrom = async (report: "monthly" | "commission" | "business" | "profit") => {
      const labels = {
        monthly: "月度损益",
        commission: "分润对账",
        business: "业务损益",
        profit: "订单利润",
      } as const;
      await gotoTab(labels[report]);
      const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
      fireEvent.change(pane.querySelector<HTMLInputElement>(".ui-control-width-date")!, { target: { value: "2026-10-01" } });
    };
    await setFrom("monthly");
    await waitFor(() => expect(vi.mocked(reportsApi.monthlyPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
    await setFrom("commission");
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith({ from: "2026-10-01", all_people: true }));
    await setFrom("business");
    await waitFor(() => expect(vi.mocked(reportsApi.businessPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
    await setFrom("profit");
    await waitFor(() => expect(vi.mocked(reportsApi.orderProfit)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
  });

  it("FE-053：页内导出成功后创建下载锚点并显示结果反馈", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const successSpy = vi.spyOn(appMessage, "success").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("月度损益");
    await ui.click(screen.getByRole("button", { name: "导出 CSV" }));
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

  it("统计周期变更触发月度损益重新请求", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("月度损益");
    await screen.findAllByText("销售收入"); // MonthlyPnl StatRow + 列标题一定渲染
    // 父级提升的日期输入无 label，按激活 Tab 面板内的 class 定位（避开导出区的日期输入）
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const dateInputs = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    await ui.type(dateInputs[0], "2026-01-01");
    // 区间变化 → monthlyPnl 重新请求（deps 含 params.from）
    await waitFor(() =>
      expect(vi.mocked(reportsApi.monthlyPnl)).toHaveBeenCalledWith({ from: "2026-01-01", to: undefined }),
    );
  });

  it("FE-270：月度损益和业务损益历史空区间清空旧明细", async () => {
    vi.mocked(reportsApi.monthlyPnl).mockImplementation((params) => Promise.resolve(
      params?.from ? { items: [], total: { sales_income: "0", operating_profit: "0" } } : {
        items: [{ month: "2026-11", sales_income: "100", account_direct_cost: "50", operating_expense: "0", rebate_income: "0", operating_profit: "50" }],
        total: { sales_income: "100", operating_profit: "50" },
      },
    ) as never);
    vi.mocked(reportsApi.businessPnl).mockImplementation((params) => Promise.resolve(
      params?.from ? { items: [], total: { main_profit: "0" } } : {
        items: [{ order_type: "HS", business_mode: "SELF", main_income: "100", main_cost: "50", main_profit: "50" }],
        total: { main_profit: "50" },
      },
    ) as never);
    renderLight(<ReportsPage />, { user: "admin" });

    await gotoTab("月度损益");
    await screen.findByText("2026-11");
    let pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const r2Dates = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    fireEvent.change(r2Dates[0], { target: { value: "2026-10-01" } });
    fireEvent.change(r2Dates[1], { target: { value: "2026-10-31" } });
    await waitFor(() => expect(vi.mocked(reportsApi.monthlyPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31" }));
    await waitFor(() => expect(screen.queryByText("2026-11")).not.toBeInTheDocument());

    await gotoTab("业务损益");
    await waitFor(() => expect(vi.mocked(reportsApi.businessPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31" }));
  });

  it("FE-272：订单利润历史空区间清空收入成本和净利明细", async () => {
    vi.mocked(reportsApi.orderProfit).mockImplementation((params) => Promise.resolve(
      params?.from ? { items: [], total: { income: "0", buy_amount: "0", direct_cost: "0", rebate: "0", net_profit: "0" } } : {
        items: [{ order_no: "HS-FE272", order_type: "HS", trade_date: "2026-11-01", status: "DONE", income: "100", buy_amount: "50", direct_cost: "10", rebate: "0", net_profit: "40" }],
        total: { income: "100", buy_amount: "50", direct_cost: "10", rebate: "0", net_profit: "40" },
      },
    ) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");
    await screen.findByText("HS-FE272");
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const dates = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    fireEvent.change(dates[0], { target: { value: "2026-10-01" } });
    fireEvent.change(dates[1], { target: { value: "2026-10-31" } });
    await waitFor(() => expect(vi.mocked(reportsApi.orderProfit)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31" }));
    await waitFor(() => expect(screen.queryByText("HS-FE272")).not.toBeInTheDocument());
  });

  it("FE-273：分润对账和资金日报日期筛选切换到历史空态", async () => {
    vi.mocked(reportsApi.commission).mockImplementation((params) => Promise.resolve(
      params?.from ? { items: [], total: { order_count: 0, payable: "0", paid: "0", difference: "0" } } : {
        items: [{ user_id: 1, order_no: "HS-FE273", profit_base: "10", rate: "0.1", payable: "1", paid: "0", difference: "1" }],
        total: { order_count: 1, payable: "1", paid: "0", difference: "1" },
      },
    ) as never);
    vi.mocked(reportsApi.dailyFunds).mockImplementation((params) => Promise.resolve(
      params?.on === "2026-10-01" ? { date: "2026-10-01", total: {}, items: [] } : {
        date: "2026-11-01",
        total: { cash_balance: "10", deposit_held: "0", available: "10" },
        items: [{ pool_name: "POOL-FE273", opening: "10", income: "0", expense: "0", deposit_held: "0", cash_balance: "10", available: "10" }],
      },
    ) as never);
    renderLight(<ReportsPage />, { user: "admin" });

    await gotoTab("分润对账");
    await screen.findByText("HS-FE273");
    let pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const r3Dates = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    fireEvent.change(r3Dates[0], { target: { value: "2026-10-01" } });
    fireEvent.change(r3Dates[1], { target: { value: "2026-10-31" } });
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31", all_people: true }));
    await waitFor(() => expect(screen.queryByText("HS-FE273")).not.toBeInTheDocument());

    await gotoTab("资金日报");
    await screen.findByLabelText("资金日报日期");
    fireEvent.change(screen.getByLabelText("资金日报日期"), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(vi.mocked(reportsApi.dailyFunds)).toHaveBeenLastCalledWith({ on: "2026-10-01" }));
    await waitFor(() => expect(screen.queryByText("POOL-FE273")).not.toBeInTheDocument());
  });

  it("分润对账加载失败显示错误条，点「重新加载」可重试成功", async () => {
    vi.mocked(reportsApi.commission).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" } as unknown as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("分润对账");
    await waitFor(() => expect(document.querySelector(".ui-error-banner")).toBeTruthy());
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await screen.findByText("应付合计"); // 重试成功后渲染 Commission StatRow
  });
});
