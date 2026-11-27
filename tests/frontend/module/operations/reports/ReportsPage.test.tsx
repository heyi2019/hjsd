import { act, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import dayjs from "dayjs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { ReportsPage } from "@/operations/ReportsPage";
import { DataCenterPanel } from "@/operations/DataCenterPanel";
import { Commission } from "@/operations/reports/CommissionReport";
import { MonthlyPnl } from "@/operations/reports/MonthlyPnlReport";
import { BusinessPnl } from "@/operations/reports/BusinessPnlReport";
import { OrderProfit } from "@/operations/reports/OrderProfitReport";
import { currentReportPeriod, previousReportPeriod } from "@/shared/lib/reportPeriod";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";
import { antdRangeValues, setAntdDateRange } from "@fixtures/antdRange";
import { appMessage } from "@/shared/ui/appFeedback";
import { commissionResponse, dataCenterSummary, orderLedgerSummary, poolBalancesResponse, reportResponse } from "@fixtures/api-responses";

import { ordersApi } from "@/shared/api/orders.api";
import { updateListColumnScope } from "@/shared/lib/listColumns";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { reportsApi } from "@/shared/api/reports.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { useBusinessPeriod } from "@/shared/state/businessPeriod";
import { useReport } from "@/operations/reports/shared";
let ui: ReturnType<typeof userEvent.setup>;
const firstReportPage = { limit: 10, offset: 0, sort_desc: true };

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
vi.mock("@/shared/api/profitAllocation.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");

vi.mock("@/shared/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { LightweightDataTable } = await import("@fixtures/LightweightDataTable");
  const DataTable = (props: Parameters<typeof LightweightDataTable>[0] & { emptyText?: string }) => <>
    <LightweightDataTable {...props} />
    {!props.loading && props.rows.length === 0 && <div>{props.emptyText ?? "暂无数据"}</div>}
  </>;
  return { ...actual, DataTable };
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
  resolveMock(vi.mocked(poolsApi.balances), poolBalancesResponse([], { pool_count: 0, cash_balance: "0.00", available: "0.00", deposit_held: "0.00" }));
});

async function gotoTab(label: string) {
  await ui.click(screen.getByRole("tab", { name: label }));
}

describe("ReportsPage：经营中心报表", () => {
  it.each([
    ["月度损益", MonthlyPnl, "monthly-pnl"],
    ["订单利润", OrderProfit, "order-profit"],
    ["分润对账", Commission, "commission"],
  ] as const)("%s 导出跟随当前时序", async (_label, Component, name) => {
    renderLight(<Component range={{ params: {}, picker: null }} />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(reportsApi.exportCsv)).toHaveBeenLastCalledWith(name, expect.objectContaining({ sort_desc: true })));
    await ui.click(screen.getByRole("button", { name: "最旧在前" }));
    await ui.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(reportsApi.exportCsv)).toHaveBeenLastCalledWith(name, expect.objectContaining({ sort_desc: false })));
  });
  it.each([
    ["月度经营损益", MonthlyPnl, "monthlyPnl", "所选区间无数据"],
    ["业务级损益", BusinessPnl, "businessPnl", "所选区间无业务数据"],
    ["订单利润", OrderProfit, "orderProfit", "所选区间无订单"],
  ] as const)("%s 区分请求失败和空数据", async (_title, Component, apiName, emptyText) => {
    vi.mocked(reportsApi[apiName]).mockRejectedValueOnce(new Error("请求失败"));
    renderLight(<Component range={{ params: {}, picker: null }} />, { user: "admin" });
    expect(await screen.findByText("报表数据不可用，请点击重新加载")).toBeInTheDocument();
    expect(screen.queryByText(emptyText)).not.toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    expect(await screen.findByText(emptyText)).toBeInTheDocument();
  });

  it("分润对账加载和失败时订单数不显示为零", async () => {
    let fail!: (reason: Error) => void;
    vi.mocked(reportsApi.commission).mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    renderLight(<Commission range={{ params: {}, picker: null }} />, { user: "admin" });
    const orderCount = screen.getByText("订单数").closest(".ui-stat") as HTMLElement;
    expect(orderCount).toHaveTextContent("-");
    await act(async () => fail(new Error("分润加载失败")));
    await screen.findByText(/分润加载失败/);
    expect(orderCount).toHaveTextContent("-");
    expect(screen.getByText("分润数据不可用，请点击重新加载")).toBeInTheDocument();
  });

  it("数据中心加载中不显示数据不可用，失败后才显示不可用", async () => {
    let fail!: (reason: Error) => void;
    vi.mocked(reportsApi.dataCenter).mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    renderLight(<DataCenterPanel />, { user: "admin" });
    const card = screen.getByRole("button", { name: /订单总数/ });
    expect(card).toHaveTextContent("加载中");
    expect(card).toHaveAttribute("aria-disabled", "true");
    await act(async () => fail(new Error("数据加载失败")));
    await waitFor(() => expect(card).toHaveTextContent("不可用"));
  });

  it("切换日期后旧报表请求晚返回时不会覆盖新结果", async () => {
    let finishOld!: (value: string) => void;
    let finishNew!: (value: string) => void;
    const oldRequest = new Promise<string>((resolve) => { finishOld = resolve; });
    const newRequest = new Promise<string>((resolve) => { finishNew = resolve; });
    const { result, rerender } = renderHook(({ period }) => useReport(
      () => period === "old" ? oldRequest : period === "new" ? newRequest : Promise.reject(new Error("报表加载失败")),
      [period],
    ), { initialProps: { period: "old" } });
    rerender({ period: "new" });
    await act(async () => { finishNew("新周期数据"); await newRequest; });
    expect(result.current.data).toBe("新周期数据");
    await act(async () => { finishOld("旧周期数据"); await oldRequest; });
    expect(result.current.data).toBe("新周期数据");
    expect(result.current.loading).toBe(false);
    rerender({ period: "failed" });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeNull();
  });

  it("跳转传入本期日期后跨月仍自动滚期", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 20, 12));
      vi.mocked(optionSetsApi.get).mockResolvedValue({ options: [{ value: "start_day", label: "16" }] } as never);
      const { result, unmount } = renderHook(() => useBusinessPeriod());
      await act(async () => { await Promise.resolve(); });
      act(() => result.current.setPeriod({ from: "2026-11-16", to: "2026-12-15" }));
      vi.setSystemTime(new Date(2026, 11, 16, 12));
      await act(async () => { window.dispatchEvent(new Event("focus")); await Promise.resolve(); });
      expect(result.current.period).toEqual({ from: "2026-12-16", to: "2027-01-15" });
      act(() => result.current.setPeriod({ from: "2026-10-16", to: "2026-11-15" }));
      vi.setSystemTime(new Date(2027, 0, 16, 12));
      await act(async () => { window.dispatchEvent(new Event("focus")); await Promise.resolve(); });
      expect(result.current.period).toEqual({ from: "2026-10-16", to: "2026-11-15" });
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("只加载当前入口的报表，切回我的收益时不重拉原标签", async () => {
    const { rerender } = renderLight(<ReportsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "经营损益" });
    await waitFor(() => expect(vi.mocked(reportsApi.monthlyPnl)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(reportsApi.businessPnl)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportsApi.commission)).not.toHaveBeenCalled();
    expect(vi.mocked(reportsApi.orderProfit)).not.toHaveBeenCalled();
    expect(vi.mocked(poolsApi.list)).not.toHaveBeenCalled();
    rerender(<ReportsPage active={false} />);
    vi.mocked(reportsApi.monthlyPnl).mockClear();
    vi.mocked(reportsApi.businessPnl).mockClear();
    rerender(<ReportsPage active initialReportTab="my-earnings" initialReportFrom="2020-01-01" initialReportTo="2020-01-31" />);
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenCalledWith({
      from: "2020-01-01", to: "2020-01-31", mine: true, ...firstReportPage,
    }));
    expect(vi.mocked(reportsApi.monthlyPnl)).not.toHaveBeenCalled();
    expect(vi.mocked(reportsApi.businessPnl)).not.toHaveBeenCalled();
  });

  it("日期筛选提供本期和上期快捷入口，账期按每月16日至次月15日计算", async () => {
    expect(currentReportPeriod(dayjs("2026-11-16"))).toEqual({ from: "2026-11-16", to: "2026-12-15" });
    expect(previousReportPeriod(dayjs("2026-11-16"))).toEqual({ from: "2026-10-16", to: "2026-11-15" });
    expect(currentReportPeriod(dayjs("2026-11-20"), 10)).toEqual({ from: "2026-11-10", to: "2026-12-09" });
    expect(currentReportPeriod(dayjs("2028-02-28"), 31)).toEqual({ from: "2028-01-31", to: "2028-02-28" });
    expect(currentReportPeriod(dayjs("2028-02-29"), 31)).toEqual({ from: "2028-02-29", to: "2028-03-30" });
    expect(previousReportPeriod(dayjs("2028-02-29"), 31)).toEqual({ from: "2028-01-31", to: "2028-02-28" });
    renderLight(<ReportsPage />, { user: "admin" });
    expect(await screen.findByRole("button", { name: "本期" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上期" })).toBeInTheDocument();
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    expect(pane.querySelectorAll(".ant-picker-input")).toHaveLength(2);
    await ui.click(screen.getByRole("button", { name: "本期" }));
    expect(antdRangeValues(pane)).toEqual([currentReportPeriod(dayjs()).from, currentReportPeriod(dayjs()).to]);
  });

  it("我的收益只加载当前登录用户的分润记录", async () => {
    renderLight(<ReportsPage initialReportTab="my-earnings" />, { user: "admin" });
    const commissionTab = await screen.findByRole("tab", { name: "分润对账" });
    expect(commissionTab).toHaveAttribute("aria-selected", "true");
    expect((await screen.findAllByText("我的收益")).length).toBeGreaterThan(0);
    expect(vi.mocked(reportsApi.commission)).toHaveBeenCalledWith(expect.objectContaining({ mine: true, ...currentReportPeriod() }));
    expect(vi.mocked(reportsApi.monthlyPnl)).not.toHaveBeenCalled();
  });

  it("有报表权限时可在我的收益和全员分润间切换，导出与当前视图一致", async () => {
    renderLight(<ReportsPage initialReportTab="my-earnings" />, { user: "admin" });
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith(expect.objectContaining({ mine: true })));
    await ui.click(screen.getByText("全员分润", { selector: ".ant-segmented-item-label" }));
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith(expect.objectContaining({ all_people: true })));
    const commissionCalls = vi.mocked(reportsApi.commission).mock.calls;
    expect(commissionCalls[commissionCalls.length - 1]?.[0]).not.toHaveProperty("mine");
    await ui.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(reportsApi.exportCsv)).toHaveBeenLastCalledWith("commission", expect.objectContaining({ all_people: true })));
    await ui.click(screen.getByText("我的收益", { selector: ".ant-segmented-item-label" }));
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith(expect.objectContaining({ mine: true })));
  });

  it("分润员工目录失败时可单独重试，不重拉报表", async () => {
    vi.mocked(employeesApi.list).mockRejectedValueOnce(new Error("员工目录不可用"));
    renderLight(<ReportsPage initialReportTab="commission" />, { user: "admin" });
    const alert = (await screen.findByText(/员工目录加载失败/)).closest('[role="alert"]') as HTMLElement;
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenCalledTimes(1));
    await ui.click(within(alert).getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.queryByText(/员工目录加载失败/)).not.toBeInTheDocument());
    expect(vi.mocked(reportsApi.commission)).toHaveBeenCalledTimes(1);
  });

  it("列表配置隐藏分润人员时同步隐藏分润表对应列", async () => {
    renderLight(<Commission range={{ params: {}, picker: null }} />, { user: "admin" });
    act(() => updateListColumnScope({ code: "RPT_COMMISSION", label: "分润对账", columns: [{ key: "user_name", label: "分润人员", locked: false, is_visible: false, sort_order: 1 }] }));
    await waitFor(() => expect(screen.queryByRole("columnheader", { name: "分润人员" })).not.toBeInTheDocument());
    expect(screen.getByRole("columnheader", { name: "订单号" })).toBeInTheDocument();
  });

  it("分润列配置同步作用于展开的人员明细", async () => {
    act(() => updateListColumnScope({ code: "RPT_COMMISSION", label: "分润对账", columns: [] }));
    resolveMockOnce(vi.mocked(reportsApi.commission), commissionResponse([{
      order_id: 10, order_no: "HS0001", inventory_date: "2026-10-02", outbound_date: "2026-10-04",
      profit_base: "100.00", orders: [{ user_id: 1, user_name: "张三", order_id: 10, order_no: "HS0001", profit_base: "100.00", rate: "10.00" }],
    }], { order_count: 1, profit_base: "100.00" }));
    renderLight(<Commission range={{ params: {}, picker: null }} />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: /展开.*HS0001/ }));
    const detail = document.querySelector(".commission-detail-table") as HTMLElement;
    expect(within(detail).getByText("张三")).toBeInTheDocument();
    expect(within(detail).getByText("10.00%")).toBeInTheDocument();

    act(() => updateListColumnScope({
      code: "RPT_COMMISSION", label: "分润对账", columns: [
        { key: "user_name", label: "分润人员", locked: false, is_visible: false, sort_order: 0 },
        { key: "profit_base", label: "分润基数", locked: false, is_visible: true, sort_order: 10 },
        { key: "rate", label: "费率", locked: false, is_visible: false, sort_order: 20 },
      ],
    }));
    expect(within(detail).queryByText("张三")).not.toBeInTheDocument();
    expect(within(detail).queryByText("10.00%")).not.toBeInTheDocument();
    expect(within(detail).getByText("100.00")).toBeInTheDocument();
    act(() => updateListColumnScope({ code: "RPT_COMMISSION", label: "分润对账", columns: [] }));
  });

  it("从历史周期进入我的收益时首次请求就使用指定周期", async () => {
    renderLight(
      <ReportsPage initialReportTab="my-earnings" initialReportFrom="2020-01-01" initialReportTo="2020-01-31" />,
      { user: "admin" },
    );

    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenCalled());
    expect(vi.mocked(reportsApi.commission).mock.calls).toEqual([
      [{ from: "2020-01-01", to: "2020-01-31", mine: true, ...firstReportPage }],
    ]);
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    await setAntdDateRange(pane, ui, "2020-02-01", "2020-02-29");
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith({
      from: "2020-02-01", to: "2020-02-29", mine: true, ...firstReportPage,
    }));
    vi.mocked(optionSetsApi.get).mockRejectedValueOnce(new Error("配置加载失败"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByText("当期配置读取失败，请重试")).toBeVisible();
    vi.mocked(reportsApi.commission).mockClear();
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenCalled());
    expect(vi.mocked(reportsApi.commission).mock.calls).toEqual([
      [{ from: "2020-02-01", to: "2020-02-29", mine: true, ...firstReportPage }],
    ]);
  });

  it("切回我的收益时不按上次的全员口径或周期请求", async () => {
    const { rerender } = renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("分润对账");
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenCalled());
    rerender(<ReportsPage active={false} />);
    vi.mocked(reportsApi.commission).mockClear();

    rerender(<ReportsPage active initialReportTab="my-earnings" initialReportFrom="2020-01-01" initialReportTo="2020-01-31" />);
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenCalled());
    expect(vi.mocked(reportsApi.commission).mock.calls).toEqual([
      [{ from: "2020-01-01", to: "2020-01-31", mine: true, ...firstReportPage }],
    ]);
    rerender(<ReportsPage active={false} />);
    vi.mocked(reportsApi.commission).mockClear();
    rerender(<ReportsPage active />);
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenCalled());
    expect(vi.mocked(reportsApi.commission).mock.calls).toEqual([
      [{ from: "2020-01-01", to: "2020-01-31", all_people: true, ...firstReportPage }],
    ]);
  });

  it("周期配置失败时不显示尚未请求的报表空态", async () => {
    vi.mocked(optionSetsApi.get).mockRejectedValueOnce(new Error("配置加载失败"));
    renderLight(<ReportsPage />, { user: "admin" });

    expect(await screen.findByText("当期配置读取失败，请重试")).toBeVisible();
    expect(screen.getByText("所选区间无数据")).not.toBeVisible();
    expect(screen.getByText("所选区间无业务数据")).not.toBeVisible();
    expect(vi.mocked(reportsApi.monthlyPnl)).not.toHaveBeenCalled();
    expect(vi.mocked(reportsApi.businessPnl)).not.toHaveBeenCalled();
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
    resolveMock(vi.mocked(reportsApi.commission), {
      ...commissionResponse([], { order_count: 0, profit_base: "0" }),
      people: [{ user_id: 9, user_name: "离职同事", is_active: false }],
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await ui.click(screen.getByRole("tab", { name: "分润对账" }));
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith(expect.objectContaining({ all_people: true, ...currentReportPeriod() })));
    await waitFor(() => expect(vi.mocked(employeesApi.list)).toHaveBeenCalled());
    const personComboboxes = await screen.findAllByRole("combobox");
    const personFilter = personComboboxes[personComboboxes.length - 1] as HTMLElement;
    await ui.click(personFilter);
    expect(await screen.findByText("全部", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    await ui.click(await screen.findByText("业务同事", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith(expect.objectContaining({ all_people: true, user_id: 7, ...currentReportPeriod() })));
    await ui.click(personFilter);
    await ui.click(await screen.findByText("离职同事（已停用）", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith(expect.objectContaining({ all_people: true, user_id: 9, ...currentReportPeriod() })));
    resolveMock(vi.mocked(reportsApi.commission), {
      ...commissionResponse([], { order_count: 0, profit_base: "0" }), people: [],
    });
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    await setAntdDateRange(pane, ui, "2026-01-01", "2026-01-31");
    expect(screen.getByRole("button", { name: "导出" }).closest(".ui-filter-bar")).not.toBeNull();
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: 9, from: "2026-01-01", to: "2026-01-31" })));
    expect(await within(pane).findByTitle("离职同事（已停用）")).toBeInTheDocument();
  });

  it("指定员工导出带 user_id，与列表同口径", async () => {
    vi.spyOn(appMessage, "success").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await ui.click(screen.getByRole("tab", { name: "分润对账" }));
    await waitFor(() => expect(vi.mocked(employeesApi.list)).toHaveBeenCalled());
    const personComboboxes = await screen.findAllByRole("combobox");
    await ui.click(personComboboxes[personComboboxes.length - 1] as HTMLElement);
    await ui.click(await screen.findByText("业务同事", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenLastCalledWith(expect.objectContaining({ all_people: true, user_id: 7, ...currentReportPeriod() })));
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
    expect(document.querySelectorAll(".ant-tabs-tabpane-active .ant-picker-input")).toHaveLength(2);
    await ui.click(screen.getByRole("button", { name: /订单总数/ }));
    const period = currentReportPeriod();
    expect(onNavigate).toHaveBeenCalledWith(`business/ledger?trade_date_from=${period.from}&trade_date_to=${period.to}`);
  });

  it("订单利润页内导出按钮按统计周期导出", async () => {
    vi.spyOn(appMessage, "success").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");
    // 报表统计周期 picker：激活 Tab 面板内的合并区间选择器（父级提升、无独立 label）
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    await setAntdDateRange(pane, ui, "2026-01-01", "2026-01-31");
    await ui.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(reportsApi.exportCsv)).toHaveBeenCalledWith("order-profit", { from: "2026-01-01", to: "2026-01-31", sort_desc: true }));
  });

  it("报表页内导出按钮无筛选也能导出并给出成功反馈", async () => {
    const successSpy = vi.spyOn(appMessage, "success").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("经营损益");
    const monthlyCard = screen.getByText("月度经营损益").closest(".ant-card") as HTMLElement;
    await ui.click(within(monthlyCard).getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(reportsApi.exportCsv)).toHaveBeenCalledWith("monthly-pnl", { ...currentReportPeriod(), sort_desc: true }));
    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("报表已导出"));
  });

  it("反向选择日期时 RangePicker 自动换序为升序（导出拦截仅剩防御意义）", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    await setAntdDateRange(pane, ui, "2026-12-31", "2026-01-01");
    // antd RangePicker 强制 start ≤ end：内部自动交换，UI 层不再产生反向区间。
    expect(antdRangeValues(pane)).toEqual(["2026-01-01", "2026-12-31"]);
    await ui.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(reportsApi.exportCsv)).toHaveBeenCalledWith("order-profit", { from: "2026-01-01", to: "2026-12-31", sort_desc: true }));
  });
});

// —— 原 ReportsPage.details.test.tsx ——
// 同一报表页与同一份接口 mock，详情断言合并到主文件以避免重复启动 jsdom+antd。
describe("ReportsPage：各报表渲染与错误态", () => {
  it("业务级损益分别展示业务模式与业务类型", async () => {
    resolveMock(vi.mocked(reportsApi.businessPnl), reportResponse([
      { order_type: "TH", business_mode: "DISTRIBUTION", business_type: "PICKUP", main_income: "800.00", cost: "300.00", main_profit: "500.00" },
    ], {}));
    renderLight(<BusinessPnl range={{ params: {}, picker: null }} />, { user: "admin" });
    expect(await screen.findByText("提号（TH）")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "业务模式" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "业务类型" })).toBeInTheDocument();
    expect(screen.getByText("分销")).toBeInTheDocument();
  });

  it("经营损益：同时渲染月度趋势与业务拆分", async () => {
    resolveMockOnce(vi.mocked(reportsApi.monthlyPnl), reportResponse([
      { month: "2026-09", sales_income: "2000.00", studio_other_income: "75.00", cost: "500.00", operating_expense: "100.00", rebate_income: "50.00", operating_profit: "1475.00" },
    ], {}));
    resolveMock(vi.mocked(reportsApi.businessPnl), reportResponse([
      { order_type: "HS", main_income: "800.00", cost: "300.00", main_profit: "500.00" },
    ], {}));
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("经营损益");
    expect(await screen.findByText("2026-09")).toBeInTheDocument();
    expect(screen.getAllByText("2,000.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("工作室其他收入")).toBeInTheDocument();
    expect(screen.getByText("75.00")).toBeInTheDocument();
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
