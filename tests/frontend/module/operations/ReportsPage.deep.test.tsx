import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { ReportsPage } from "@/reporting/ReportsPage";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";
import { appMessage } from "@/shared/ui/appFeedback";

import * as catalog from "@/shared/api/catalog";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

vi.mock("@/shared/api/catalog");

// 报表 DataTable 重型，替换为轻量实现（与 ReportsPage.test.tsx 一致），
// MoneyText / StatusTag / StatRow / ErrorBanner 仍用真实组件。
vi.mock("@/shared/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { LightweightDataTable } = await import("@fixtures/LightweightDataTable");
  return { ...actual, DataTable: LightweightDataTable };
});

const emptyHealth = { generated_on: "2026-10-01", total_cost: "0.00", items: [] };

beforeEach(() => {
  vi.clearAllMocks();
  resolveMock(vi.mocked(catalog.reportsApi.inventoryHealth), emptyHealth);
  resolveMock(vi.mocked(catalog.reportsApi.monthlyPnl), { items: [], total: {} });
  resolveMock(vi.mocked(catalog.reportsApi.commission), {
    items: [],
    total: { order_count: 0, payable: "0", paid: "0", difference: "0" },
  });
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(catalog.reportsApi.dailyFunds), { date: "2026-10-01", total: {}, items: [] });
  resolveMock(vi.mocked(catalog.reportsApi.businessPnl), { items: [], total: {} });
  resolveMock(vi.mocked(catalog.reportsApi.orderProfit), {
    items: [],
    total: { income: "0", direct_cost: "0", rebate: "0", net_profit: "0" },
  });
  resolveMock(vi.mocked(catalog.reportsApi.exportCsv), new Blob(["csv"]));
});

async function gotoTab(label: string) {
  await ui.click(screen.getByRole("tab", { name: label }));
}

describe("ReportsPage：其余报表 Tab 渲染与导出成功分支", () => {
  it("R3 提成对账：渲染人员/订单/费率/应付与差异统计", async () => {
    resolveMockOnce(vi.mocked(catalog.reportsApi.commission), {
      items: [
        { user_id: 1, order_no: "HS-2026-0010", profit_base: "100.00", rate: "0.10", payable: "10.00", paid: "5.00", difference: "5.00" },
      ],
      total: { order_count: 1, payable: "10.00", paid: "5.00", difference: "5.00" },
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("提成对账 R3");
    await screen.findByText("HS-2026-0010");
    expect(screen.getByText("0.10")).toBeInTheDocument(); // 费率列
    expect(screen.getByText("应付合计")).toBeInTheDocument(); // StatRow label
    expect(screen.getAllByText("差异").length).toBeGreaterThanOrEqual(1); // StatRow + 列标题
  });

  it("R4 资金日报：渲染资金池/期初/收支/余额与标题日期", async () => {
    resolveMockOnce(vi.mocked(catalog.reportsApi.dailyFunds), {
      date: "2026-10-08",
      total: { cash_balance: "80.00", deposit_held: "10.00", available: "70.00" },
      items: [
        { pool_name: "POOL-A", opening: "100.00", income: "50.00", expense: "20.00", deposit_held: "10.00", cash_balance: "80.00", available: "70.00" },
      ],
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("资金报表·日报");
    expect(await screen.findAllByText("POOL-A")).toHaveLength(1);
    expect(screen.queryByRole("columnheader", { name: "名称" })).not.toBeInTheDocument();
    expect(screen.getByText(/2026-10-08/)).toBeInTheDocument(); // 标题含日期
    expect(screen.getAllByText("现金余额").length).toBeGreaterThanOrEqual(1); // StatRow + 列标题
    expect(screen.getAllByText("可用余额").length).toBeGreaterThanOrEqual(1); // StatRow + 列标题
  });

  it("R4 资金日报：切换日期带 on 参数重新拉取（#56）", async () => {
    vi.mocked(catalog.reportsApi.dailyFunds).mockClear();
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("资金报表·日报");
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.dailyFunds)).toHaveBeenCalled());
    const dateInput = screen.getByLabelText("资金日报日期");
    fireEvent.change(dateInput, { target: { value: "2026-10-08" } });
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.dailyFunds)).toHaveBeenLastCalledWith({ on: "2026-10-08" }));
  });

  it("FE-051：共享日期区间传递到 R2/R3/R5 和订单利润", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    const setFrom = async (label: RegExp) => {
      await gotoTab(label.source.includes("R2") ? "月度损益 R2" : label.source.includes("R3") ? "提成对账 R3" : label.source.includes("R5") ? "业务损益 R5" : "订单利润");
      const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
      fireEvent.change(pane.querySelector<HTMLInputElement>(".ui-control-width-date")!, { target: { value: "2026-10-01" } });
    };
    await setFrom(/R2/);
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.monthlyPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
    await setFrom(/R3/);
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.commission)).toHaveBeenLastCalledWith({ from: "2026-10-01", all_people: true }));
    await setFrom(/R5/);
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.businessPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
    await setFrom(/订单利润/);
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.orderProfit)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
  });

  it("R1 持有天数多分支：绿/橙/红/空", async () => {
    resolveMockOnce(vi.mocked(catalog.reportsApi.inventoryHealth), {
      generated_on: "2026-10-01",
      total_cost: "0.00",
      items: [
        { game_account: "a1", platform: "P", status: "IN_STOCK", buy_amount: "1", extra_cost: "0", total_cost: "1", holding_days: 5 },
        { game_account: "a2", platform: "P", status: "IN_STOCK", buy_amount: "1", extra_cost: "0", total_cost: "1", holding_days: 15 },
        { game_account: "a3", platform: "P", status: "IN_STOCK", buy_amount: "1", extra_cost: "0", total_cost: "1", holding_days: 45 },
        { game_account: "a4", platform: "P", status: "IN_STOCK", buy_amount: "1", extra_cost: "0", total_cost: "1", holding_days: null },
      ],
    });
    renderLight(<ReportsPage />, { user: "admin" });
    expect(await screen.findByText("a1")).toBeInTheDocument();
    expect(screen.getByText("5天")).toBeInTheDocument();
    expect(screen.getByText("15天")).toBeInTheDocument();
    expect(screen.getByText("45天")).toBeInTheDocument();
    // holding_days 为 null → 渲染 "-"
    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(1);
  });

  it("FE-053：页内导出成功后创建下载锚点并显示结果反馈", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const successSpy = vi.spyOn(appMessage, "success").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "库存 R1" });
    await ui.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.exportCsv)).toHaveBeenCalledWith("inventory-health", { from: undefined, to: undefined }));
    expect(createUrl).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith("已导出 inventory-health.csv");
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
    expect(vi.mocked(catalog.reportsApi.exportCsv)).not.toHaveBeenCalled();
  });

  it("统计周期变更触发报表重新请求（R2 月度损益）", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("月度损益 R2");
    await screen.findAllByText("销售收入"); // MonthlyPnl StatRow + 列标题一定渲染
    // 父级提升的日期输入无 label，按激活 Tab 面板内的 class 定位（避开导出区的日期输入）
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const dateInputs = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    await ui.type(dateInputs[0], "2026-01-01");
    // 区间变化 → monthlyPnl 重新请求（deps 含 params.from）
    await waitFor(() =>
      expect(vi.mocked(catalog.reportsApi.monthlyPnl)).toHaveBeenCalledWith({ from: "2026-01-01", to: undefined }),
    );
  });

  it("FE-270：R2 和 R5 历史空区间清空旧明细", async () => {
    vi.mocked(catalog.reportsApi.monthlyPnl).mockImplementation((params) => Promise.resolve(
      params?.from ? { items: [], total: { sales_income: "0", operating_profit: "0" } } : {
        items: [{ month: "2026-11", sales_income: "100", account_direct_cost: "50", operating_expense: "0", rebate_income: "0", operating_profit: "50" }],
        total: { sales_income: "100", operating_profit: "50" },
      },
    ) as never);
    vi.mocked(catalog.reportsApi.businessPnl).mockImplementation((params) => Promise.resolve(
      params?.from ? { items: [], total: { main_profit: "0" } } : {
        items: [{ order_type: "HS", business_mode: "SELF", main_income: "100", main_cost: "50", main_profit: "50" }],
        total: { main_profit: "50" },
      },
    ) as never);
    renderLight(<ReportsPage />, { user: "admin" });

    await gotoTab("月度损益 R2");
    await screen.findByText("2026-11");
    let pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const r2Dates = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    fireEvent.change(r2Dates[0], { target: { value: "2026-10-01" } });
    fireEvent.change(r2Dates[1], { target: { value: "2026-10-31" } });
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.monthlyPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31" }));
    await waitFor(() => expect(screen.queryByText("2026-11")).not.toBeInTheDocument());

    await gotoTab("业务损益 R5");
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.businessPnl)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31" }));
  });


  it("FE-272：订单利润历史空区间清空收入成本和净利明细", async () => {
    vi.mocked(catalog.reportsApi.orderProfit).mockImplementation((params) => Promise.resolve(
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
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.orderProfit)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31" }));
    await waitFor(() => expect(screen.queryByText("HS-FE272")).not.toBeInTheDocument());
  });

  it("FE-273：R3 和 R4 日期筛选切换到历史空态", async () => {
    vi.mocked(catalog.reportsApi.commission).mockImplementation((params) => Promise.resolve(
      params?.from ? { items: [], total: { order_count: 0, payable: "0", paid: "0", difference: "0" } } : {
        items: [{ user_id: 1, order_no: "HS-FE273", profit_base: "10", rate: "0.1", payable: "1", paid: "0", difference: "1" }],
        total: { order_count: 1, payable: "1", paid: "0", difference: "1" },
      },
    ) as never);
    vi.mocked(catalog.reportsApi.dailyFunds).mockImplementation((params) => Promise.resolve(
      params?.on === "2026-10-01" ? { date: "2026-10-01", total: {}, items: [] } : {
        date: "2026-11-01",
        total: { cash_balance: "10", deposit_held: "0", available: "10" },
        items: [{ pool_name: "POOL-FE273", opening: "10", income: "0", expense: "0", deposit_held: "0", cash_balance: "10", available: "10" }],
      },
    ) as never);
    renderLight(<ReportsPage />, { user: "admin" });

    await gotoTab("提成对账 R3");
    await screen.findByText("HS-FE273");
    let pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const r3Dates = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    fireEvent.change(r3Dates[0], { target: { value: "2026-10-01" } });
    fireEvent.change(r3Dates[1], { target: { value: "2026-10-31" } });
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.commission)).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31", all_people: true }));
    await waitFor(() => expect(screen.queryByText("HS-FE273")).not.toBeInTheDocument());

    await gotoTab("资金报表·日报");
    await screen.findByLabelText("资金日报日期");
    fireEvent.change(screen.getByLabelText("资金日报日期"), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.dailyFunds)).toHaveBeenLastCalledWith({ on: "2026-10-01" }));
    await waitFor(() => expect(screen.queryByText("POOL-FE273")).not.toBeInTheDocument());
  });

  it("R3 加载失败显示错误条，点「重新加载」可重试成功", async () => {
    vi.mocked(catalog.reportsApi.commission).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" } as unknown as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("提成对账 R3");
    await waitFor(() => expect(document.querySelector(".ui-error-banner")).toBeTruthy());
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await screen.findByText("应付合计"); // 重试成功后渲染 Commission StatRow
  });
});
