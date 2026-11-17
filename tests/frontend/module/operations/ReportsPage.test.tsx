import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import dayjs from "dayjs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { ReportsPage } from "@/reporting/ReportsPage";
import { currentReportPeriod, previousReportPeriod } from "@/reporting/reportPeriod";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";
import { appMessage } from "@/shared/ui/appFeedback";
import { commissionResponse, dataCenterSummary, orderLedgerSummary, poolBalancesResponse, reportResponse } from "@fixtures/api-responses";

import { ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { reportsApi } from "@/shared/api/reports.api";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

// jsdom 不执行真实下载跳转；屏蔽 anchor.click，避免导出测试留下 navigation 定时器拖住全量单测。
// 同时 jsdom 未实现 URL.createObjectURL/revokeObjectURL，导出成功分支依赖它，置为安全桩。
// 必须在「每个用例」的 beforeEach 内（clearAllMocks 之后）重新挂桩：setup.ts 的 afterEach 会
// resetAllMocks，清空 beforeAll 桩的 mockReturnValue；若是文件内后续用例（如「导出成功后」）
// 会读到真实 jsdom Blob 而抛 "cannot read the bytes of a jsdom Blob"，误入错误分支。
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
vi.mock("@/shared/api/stocks.api");

vi.mock("@/shared/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { LightweightDataTable } = await import("@fixtures/LightweightDataTable");
  return { ...actual, DataTable: LightweightDataTable };
});

beforeEach(() => {
  vi.clearAllMocks();
  // 每个用例重新挂桩，覆盖上一份用例 afterEach(resetAllMocks) 对桩实现的清空。
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  resolveMock(vi.mocked(reportsApi.monthlyPnl), reportResponse([], {}));
  resolveMock(vi.mocked(reportsApi.commission), commissionResponse([], { order_count: 0, profit_base: "0" }));
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 7, username: "operator", display_name: "业务同事", is_active: true },
    { id: 8, username: "finance", display_name: "财务同事", is_active: true },
  ]);
  resolveMock(vi.mocked(reportsApi.businessPnl), reportResponse([], {}));
  resolveMock(vi.mocked(reportsApi.dataCenter), dataCenterSummary());
  resolveMock(vi.mocked(reportsApi.orderProfit), reportResponse([], { income: "0", cost: "0", rebate: "0", net_profit: "0" }));
  resolveMock(vi.mocked(reportsApi.exportCsv), new Blob(["csv"]));
  vi.mocked(ordersApi.ledgerSummary).mockResolvedValue(orderLedgerSummary({ total_count: 2, status_counts: { ACTIVE: 1 } }));
  // 数据中心面板（同页挂载）：空池空单——本文件只关心报表 Tab，桩位兜底即可。
  vi.mocked(poolsApi.list).mockResolvedValue([]);
  // 空池 → 批量余额返回空 items 与零汇总（服务端聚合）。
  resolveMock(vi.mocked(poolsApi.balances), poolBalancesResponse([], { pool_count: 0, cash_balance: "0.00", available: "0.00", deposit_held: "0.00", owned_cash_balance: "0.00" }));
});

async function gotoTab(label: string) {
  await ui.click(screen.getByRole("tab", { name: label }));
}

describe("ReportsPage：经营中心报表", () => {
  it("初始加载合并后的经营损益，不提前加载隐藏 Tab", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "经营损益" });
    expect(vi.mocked(reportsApi.monthlyPnl)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportsApi.businessPnl)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportsApi.commission)).not.toHaveBeenCalled();
    expect(vi.mocked(reportsApi.orderProfit)).not.toHaveBeenCalled();
    expect(vi.mocked(poolsApi.list)).not.toHaveBeenCalled();
  });

  it("日期筛选提供本期和上期快捷入口，账期按每月16日至次月15日计算", async () => {
    expect(currentReportPeriod(dayjs("2026-11-16"))).toEqual({ from: "2026-11-16", to: "2026-12-15" });
    expect(previousReportPeriod(dayjs("2026-11-16"))).toEqual({ from: "2026-10-16", to: "2026-11-15" });
    renderLight(<ReportsPage />, { user: "admin" });
    expect(await screen.findByRole("button", { name: "本期" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上期" })).toBeInTheDocument();
    const dateInputs = document.querySelectorAll<HTMLInputElement>(".ant-tabs-tabpane-active .ui-control-width-date");
    await ui.click(screen.getByRole("button", { name: "本期" }));
    expect(dateInputs[0]).toHaveValue(currentReportPeriod(dayjs()).from);
    expect(dateInputs[1]).toHaveValue(currentReportPeriod(dayjs()).to);
  });

  it("我的收益只加载当前登录用户的分润记录", async () => {
    renderLight(<ReportsPage initialReportTab="my-earnings" />, { user: "admin" });
    const commissionTab = await screen.findByRole("tab", { name: "分润对账" });
    expect(commissionTab).toHaveAttribute("aria-selected", "true");
    expect((await screen.findAllByText("我的收益")).length).toBeGreaterThan(0);
    expect(vi.mocked(reportsApi.commission)).toHaveBeenCalledWith({ mine: true });
    expect(vi.mocked(reportsApi.monthlyPnl)).not.toHaveBeenCalled();
  });

  it("我的收益显示分润人员的真实姓名", async () => {
    resolveMockOnce(vi.mocked(reportsApi.commission), commissionResponse([{
      order_id: 1,
      order_no: "HS-2026-0001",
      profit_base: "100.00",
      orders: [{
        user_id: 7,
        order_id: 1,
        order_no: "HS-2026-0001",
        profit_base: "100.00",
        rate: "100.00",
      }],
    }], { order_count: 1, profit_base: "100.00" }));

    renderLight(<ReportsPage initialReportTab="my-earnings" />, { user: "admin" });

    expect(await screen.findByText("业务同事")).toBeInTheDocument();
    expect(screen.queryByText("人员7")).not.toBeInTheDocument();
  });

  it("我的收益导出带 mine=true，与列表同口径", async () => {
    vi.spyOn(appMessage, "success").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage initialReportTab="my-earnings" />, { user: "admin" });
    await screen.findAllByText("我的收益");
    await ui.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(reportsApi.exportCsv)).toHaveBeenCalledWith(
      "commission",
      expect.objectContaining({ mine: true }),
    ));
    expect(vi.mocked(reportsApi.exportCsv)).not.toHaveBeenCalledWith(
      "commission",
      expect.objectContaining({ all_people: true }),
    );
  });

  it("FE-260：分润对账可以按人员筛选并传递 user_id", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await ui.click(screen.getByRole("tab", { name: "分润对账" }));
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith({ all_people: true }));
    await waitFor(() => expect(vi.mocked(employeesApi.list)).toHaveBeenCalled());
    const personComboboxes = await screen.findAllByRole("combobox");
    const personFilter = personComboboxes[personComboboxes.length - 1] as HTMLElement;
    await ui.click(personFilter);
    expect(await screen.findByText("全部", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    await ui.click(await screen.findByText("业务同事", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith({ all_people: true, user_id: 7 }));
  });

  it("指定员工导出带 user_id，与列表同口径", async () => {
    vi.spyOn(appMessage, "success").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await ui.click(screen.getByRole("tab", { name: "分润对账" }));
    await waitFor(() => expect(vi.mocked(employeesApi.list)).toHaveBeenCalled());
    const personComboboxes = await screen.findAllByRole("combobox");
    await ui.click(personComboboxes[personComboboxes.length - 1] as HTMLElement);
    await ui.click(await screen.findByText("业务同事", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith({ all_people: true, user_id: 7 }));
    await ui.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(reportsApi.exportCsv)).toHaveBeenCalledWith(
      "commission",
      expect.objectContaining({ all_people: true, user_id: 7 }),
    ));
  });

  it("四个 Tab 齐全（经营损益合并月度与业务报表）", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "经营损益" });
    expect(Array.from(screen.getAllByRole("tab")).map((tab) => tab.textContent)).toEqual([
      "数据中心",
      "订单利润",
      "分润对账",
      "经营损益",
    ]);
    for (const label of ["经营损益", "分润对账", "订单利润", "数据中心"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("tab", { name: "月度损益" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "业务损益" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "资金日报" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "审计记录" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "库存 R1" })).not.toBeInTheDocument();
  });

  it("数据中心 Tab：渲染资金统计与订单入口卡，点击入口卡跳业务中心", async () => {
    const onNavigate = vi.fn();
    renderLight(<ReportsPage onNavigate={onNavigate} />, { user: "admin" });
    await gotoTab("数据中心");
    expect(await screen.findByText("利润")).toBeInTheDocument();
    expect(document.querySelectorAll(".ant-tabs-tabpane-active .ui-control-width-date")).toHaveLength(2);
    await ui.click(screen.getByRole("button", { name: /订单总数/ }));
    expect(onNavigate).toHaveBeenCalledWith("business", "ledger");
  });

  it("订单利润页内导出按钮按统计周期导出", async () => {
    vi.spyOn(appMessage, "success").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");
    // 报表统计周期 picker：激活 Tab 面板内的两枚日期输入（父级提升、无独立 label）
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const dateInputs = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    await ui.type(dateInputs[0], "2026-01-01");
    await ui.type(dateInputs[1], "2026-01-31");
    await ui.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(reportsApi.exportCsv)).toHaveBeenCalledWith("order-profit", { from: "2026-01-01", to: "2026-01-31" }));
  });

  it("报表页内导出按钮无筛选也能导出并给出成功反馈", async () => {
    const successSpy = vi.spyOn(appMessage, "success").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("经营损益");
    const monthlyCard = screen.getByText("月度经营损益").closest(".ant-card") as HTMLElement;
    await ui.click(within(monthlyCard).getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(reportsApi.exportCsv)).toHaveBeenCalledWith("monthly-pnl", { from: undefined, to: undefined }));
    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("报表已导出"));
  });

  it("导出日期反向（开始晚于结束）时拦截并给出错误提示，不发起导出", async () => {
    const errorSpy = vi.spyOn(appMessage, "error").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const dateInputs = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    await ui.type(dateInputs[0], "2026-12-31");
    await ui.type(dateInputs[1], "2026-01-01");
    await ui.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("导出开始日期不能晚于结束日期"));
    expect(vi.mocked(reportsApi.exportCsv)).not.toHaveBeenCalled();
  });
});

// —— 原 ReportsPage.details.test.tsx ——
// 同一报表页与同一份接口 mock，详情断言合并到主文件以避免重复启动 jsdom+antd。
describe("ReportsPage：各报表渲染与错误态", () => {
  it("经营损益：同时渲染月度趋势与业务拆分", async () => {
    resolveMockOnce(vi.mocked(reportsApi.monthlyPnl), reportResponse([
      { month: "2026-09", sales_income: "2000.00", cost: "500.00", operating_expense: "100.00", rebate_income: "50.00", operating_profit: "1450.00" },
    ], {}));
    resolveMock(vi.mocked(reportsApi.businessPnl), reportResponse([
      { order_type: "HS", main_income: "800.00", cost: "300.00", main_profit: "500.00" },
    ], {}));
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("经营损益");
    expect(await screen.findByText("2026-09")).toBeInTheDocument();
    expect(screen.getAllByText("2,000.00").length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText(/HS/)).toBeInTheDocument();
    expect(screen.getAllByText("800.00").length).toBeGreaterThanOrEqual(1);
  });

  it("订单利润：渲染订单号与净额", async () => {
    resolveMockOnce(vi.mocked(reportsApi.orderProfit), reportResponse([
      { order_no: "HS-2026-0010", order_type: "HS", income: "600.00", cost: "450.00", rebate: "10.00", net_profit: "160.00" },
    ], { income: "0", cost: "0", rebate: "0", net_profit: "0" }));
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");
    expect(await screen.findByText("HS-2026-0010")).toBeInTheDocument();
    expect(screen.getAllByText("160.00").length).toBeGreaterThanOrEqual(1);
  });

  it("P1/FE-169：订单利润只展示统一成本口径且不展示旧口径说明", async () => {
    vi.mocked(reportsApi.orderProfit).mockResolvedValueOnce(reportResponse([{
      order_id: 11, order_no: "HS-2026-0011", order_type: "HS", trade_date: "2026-11-01", status: "COMPLETED", income: "600.00", cost: "450.00", rebate: "10.00", net_profit: "160.00",
    }], { income: "600.00", cost: "450.00", rebate: "10.00", net_profit: "160.00" }) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await ui.click(await screen.findByRole("tab", { name: /订单利润/ }));
    expect(await screen.findByText("HS-2026-0011")).toBeInTheDocument();
    expect(screen.getAllByText("成本").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("账号采购成本")).not.toBeInTheDocument();
    expect(screen.queryByText("直接成本")).not.toBeInTheDocument();
    expect(screen.queryByText(/净利 = 所有收入 − 所有支出/)).not.toBeInTheDocument();
    expect(screen.getAllByText("450.00").length).toBeGreaterThanOrEqual(1);
  });
});
