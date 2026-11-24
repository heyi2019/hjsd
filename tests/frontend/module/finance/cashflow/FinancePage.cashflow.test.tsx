import { act, renderHook, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { cashflowPage } from "@fixtures/api-responses";
import { cashflows, PeriodReadyProbe, ui } from "@fixtures/financePageSetup";
import { FinancePage } from "@/finance/FinancePage";
import { useFinanceResources } from "@/finance/useFinanceResources";
import { cashflowsApi } from "@/shared/api/cashflows.api";
import { previousReportPeriod } from "@/shared/lib/reportPeriod";
import { BusinessPeriodProvider } from "@/shared/state/businessPeriod";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/deposits.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/profitAllocation.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/reconciliations.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;
vi.mock("@/shared/api/transfers.api");
vi.mock("@/shared/api/studioExpenses.api");

describe("FinancePage：资金流水", () => {
  it("进入总览不请求流水，打开资金明细后才加载", async () => {
    renderLight(<BusinessPeriodProvider><PeriodReadyProbe /><FinancePage /></BusinessPeriodProvider>, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await screen.findByText("周期已就绪");
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
    expect(cashflowsApi.list).not.toHaveBeenCalled();

    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    expect(await screen.findByText("ZC00001")).toBeInTheDocument();
    expect(cashflowsApi.list).toHaveBeenCalled();
  });

  it("离开明细时未完成的旧请求不能覆盖重新进入后的流水", async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof cashflowsApi.list>>) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof cashflowsApi.list>>>((resolve) => { finishOld = resolve; });
    vi.mocked(cashflowsApi.list).mockReturnValueOnce(oldRequest).mockResolvedValueOnce(
      cashflowPage([{ ...cashflows[1], flow_no: "FLOW-LATEST" }]),
    );
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    try {
      await ui.click(screen.getByRole("tab", { name: "资金明细" }));
      await waitFor(() => expect(cashflowsApi.list).toHaveBeenCalledTimes(1));
      await ui.click(screen.getByRole("tab", { name: "总览" }));
      await ui.click(screen.getByRole("tab", { name: "资金明细" }));
      expect(await screen.findByText("FLOW-LATEST")).toBeInTheDocument();
    } finally {
      await act(async () => { finishOld(cashflowPage(cashflows)); await oldRequest; });
    }
    expect(screen.getByText("FLOW-LATEST")).toBeInTheDocument();
    expect(screen.queryByText("ZC00001")).not.toBeInTheDocument();
  });

  it("再次进入明细时保留筛选并刷新流水", async () => {
    vi.mocked(cashflowsApi.list).mockResolvedValue(cashflowPage([cashflows[1]]));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await screen.findByText("SR00001");
    await ui.click(screen.getByRole("combobox", { name: "流水方向" }));
    await ui.click(await screen.findByText("收入", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(cashflowsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ direction: "IN" })));
    vi.mocked(cashflowsApi.list).mockResolvedValueOnce(cashflowPage([{ ...cashflows[1], flow_no: "SR-LATEST" }]));

    await ui.click(screen.getByRole("tab", { name: "总览" }));
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    expect(await screen.findByText("SR-LATEST")).toBeInTheDocument();
    expect(cashflowsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ direction: "IN" }));
  });

  it("写入期间打开明细，完成后仍刷新当前流水", async () => {
    const period = {
      period: null, startDay: 16, ready: true, error: null,
      retry: () => undefined, setPeriod: () => undefined, useCurrentPeriod: () => undefined,
      usePreviousPeriod: () => undefined, useAllPeriods: () => undefined,
    };
    const { result, rerender } = renderHook(
      ({ visible }) => useFinanceResources(true, period, visible),
      { initialProps: { visible: false } },
    );
    const refreshAfterWrite = result.current.load;
    rerender({ visible: true });
    await waitFor(() => expect(result.current.cashflowsReady).toBe(true));
    vi.mocked(cashflowsApi.list).mockResolvedValueOnce(cashflowPage([{ ...cashflows[1], flow_no: "AFTER-WRITE" }]));

    await act(async () => { await refreshAfterWrite(); });
    expect(result.current.cashflows[0]?.flow_no).toBe("AFTER-WRITE");
  });

  it("资金明细显示每笔流水的资金账户", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    const row = (await screen.findByText("ZC00001")).closest("tr") as HTMLElement;
    expect(screen.getByRole("columnheader", { name: "资金账户" })).toBeInTheDocument();
    expect(within(row).getByText("经营主池")).toBeInTheDocument();
  });
  it("资金明细按页读取全部流水，筛选变化后回到第一页", async () => {
    vi.mocked(cashflowsApi.list).mockImplementation(async (params) => {
      const row = params?.offset === 10 ? { ...cashflows[1], flow_no: "FLOW-PAGE-2" } : cashflows[0];
      return cashflowPage([row], { total: 2001, total_in: "5000.00", total_out: "100.00" });
    });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await screen.findByText("ZC00001");
    await ui.click(screen.getByTitle("2"));
    expect(await screen.findByText("FLOW-PAGE-2")).toBeInTheDocument();
    expect(cashflowsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 10, offset: 10 }));
    expect(screen.getByText("总收入").closest(".ui-stat")).toHaveTextContent("5,000.00");
    await ui.click(screen.getByRole("combobox", { name: "流水方向" }));
    await ui.click(await screen.findByText("收入", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(cashflowsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ direction: "IN", offset: 0 })));
    expect(await screen.findByText("ZC00001")).toBeInTheDocument();
  });
  it("资金明细不提供新增流水入口", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await screen.findByText("ZC00001");
    expect(screen.queryByRole("button", { name: "新增流水" })).toBeNull();
  });
  it("资金流水日期筛选使用日期范围控件（与工作室经营一致）", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));

    const rangeInputs = screen.getAllByLabelText("流水日期区间");
    expect(rangeInputs).toHaveLength(2);
    const rangePicker = rangeInputs[0]!.closest(".ant-picker");
    expect(rangePicker).toBeInTheDocument();
    expect(rangePicker!.querySelectorAll(".ant-picker-input")).toHaveLength(2);
  });

  it("展示订单号、收支明细及总收入/总支出", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    expect(screen.getByText("ZC00001")).toBeInTheDocument();
    expect(screen.getAllByText("HS0001").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("总收入")).toBeInTheDocument();
    expect(screen.getByText("总支出")).toBeInTheDocument();
    expect(screen.getByText("回收成本")).toBeInTheDocument();
    expect(screen.getByText("回收收入")).toBeInTheDocument();
    expect(screen.getAllByText("800.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("500.00").length).toBeGreaterThanOrEqual(1);
  });

  it("总收入/总支出取服务端合计，不再对当页明细求和", async () => {
    // 明细只回当页（limit 上限 2000），合计必须来自服务端聚合：
    // 故意让合计与两条明细之和（IN 800 / OUT 500）不同，证明卡片没在本地累加。
    vi.mocked(cashflowsApi.list).mockResolvedValue(cashflowPage(cashflows, {
      total: 5000,
      total_in: "123456.78",
      total_out: "87654.32",
    }));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));

    await waitFor(() => expect(screen.getByText("总收入").closest(".ui-stat")).toHaveTextContent("123,456.78"));
    expect(screen.getByText("总支出").closest(".ui-stat")).toHaveTextContent("87,654.32");
  });

  it("流水支持按订单号、流水号或备注关键词筛选", async () => {
    vi.mocked(cashflowsApi.list).mockImplementation(async (params) => cashflowPage(
      params?.keyword
        ? cashflows.filter((row) => `${row.order_no ?? ""} ${row.flow_no} ${row.category}`.includes(params.keyword!))
        : cashflows,
      { total: params?.keyword ? 1 : cashflows.length, total_in: "800.00", total_out: "1000.00" },
    ));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    const search = screen.getByLabelText("流水搜索");
    await ui.type(search, "SELL");
    await waitFor(() => expect(vi.mocked(cashflowsApi.list)).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "SELL" })));
    expect(screen.getByText("SR00001")).toBeInTheDocument();
    expect(screen.queryByText("ZC00001")).not.toBeInTheDocument();
    vi.mocked(cashflowsApi.list).mockClear();
    await ui.click(screen.getByRole("button", { name: "搜索流水" }));
    await waitFor(() => expect(cashflowsApi.list).toHaveBeenCalledWith(expect.objectContaining({ keyword: "SELL" })));
  });

  it("资金流水导出使用当前日期和搜索条件", async () => {
    // 修复 #2：旧实现 exportCsv 漏传 keyword，筛关键词后导出的是全量。
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:flow");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.mocked(cashflowsApi.exportCsv).mockResolvedValue(new Blob(["csv"]));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await ui.click(screen.getByRole("button", { name: "上期" }));
    const previous = previousReportPeriod();
    await ui.type(screen.getByLabelText("流水搜索"), "SELL");
    await ui.click(screen.getByRole("button", { name: "最旧在前" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导出" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "导出" })).toHaveClass("ui-export-button");
    await ui.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(cashflowsApi.exportCsv)).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: "SELL", occurred_from: previous.from, occurred_to: previous.to, sort_desc: false }),
    ));
  });

  it("流水分页时关键词筛选的合计取服务端全量汇总", async () => {
    // 当前页只有部分流水，关键词筛选后仍应使用服务端汇总而不是当页求和。
    vi.mocked(cashflowsApi.list).mockImplementation(async (params) => cashflowPage(
      params?.keyword ? [cashflows[1]] : cashflows,
      { total: 5000, total_in: "123456.78", total_out: "87654.32" },
    ));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await ui.type(screen.getByLabelText("流水搜索"), "SELL");
    await waitFor(() => expect(vi.mocked(cashflowsApi.list)).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "SELL" })));
    // 本地已收窄到只剩 SELL 一条，但合计不得跟着塌成这一条的 800.00。
    expect(screen.queryByText("ZC00001")).not.toBeInTheDocument();
    expect((await screen.findByText("总收入")).closest(".ui-stat")).toHaveTextContent("123,456.78");
    expect(screen.getByText("总支出").closest(".ui-stat")).toHaveTextContent("87,654.32");
  });

  it("流水合计完全由服务端汇总，不按本地收窄重算", async () => {
    // 1.005 + 0.005 的展示口径由服务端 Decimal 汇总决定；前端不再按当前已加载行二次运算。
    const rows = [
      { ...cashflows[1], id: 21, amount: "1.005", order_no: "SE-A", direction: "IN", accounting_attribute: "SELF_REVENUE" },
      { ...cashflows[1], id: 22, amount: "0.005", order_no: "SE-B", direction: "IN", accounting_attribute: "SELF_REVENUE" },
      { ...cashflows[0], id: 23, amount: "9.00", order_no: "BUY-C", direction: "OUT", accounting_attribute: "SELF_DIRECT_COST" },
    ];
    vi.mocked(cashflowsApi.list).mockResolvedValue(cashflowPage(rows, { total_in: "1.01", total_out: "9.00" }));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    // 关键词 "SE" 本地收窄出两条 IN（SE-A / SE-B），排除 BUY-C；
    // 即便当前页面已加载全部 3 条，合计仍使用服务端返回的 1.01。
    vi.mocked(cashflowsApi.list).mockImplementation(async (params) => cashflowPage(
      params?.keyword ? rows.filter((row) => `${row.order_no} ${row.flow_no}`.includes(params.keyword!)) : rows,
      { total: rows.length, total_in: "1.01", total_out: "9.00" },
    ));
    await ui.type(screen.getByLabelText("流水搜索"), "SE");
    await waitFor(() => expect(vi.mocked(cashflowsApi.list)).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "SE" })));
    expect(screen.queryByText("BUY-C")).not.toBeInTheDocument();
    expect((await screen.findByText("总收入")).closest(".ui-stat")).toHaveTextContent("1.01");
  });
});
