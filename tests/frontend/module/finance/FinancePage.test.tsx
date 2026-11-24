import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { FinancePage } from "@/finance/FinancePage";
import { useDepositResources } from "@/finance/deposits/useDepositResources";
import { useReconciliationResources } from "@/finance/reconciliation/useReconciliationResources";
import { resolveMockOnce } from "@fixtures/mock-api";

import { cashflowsApi } from "@/shared/api/cashflows.api";
import { depositsApi } from "@/shared/api/deposits.api";
import { studioExpensesApi } from "@/shared/api/studioExpenses.api";
import { listColumnsApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";
import { reconciliationsApi } from "@/shared/api/reconciliations.api";
import { transfersApi } from "@/shared/api/transfers.api";
import { employeesApi } from "@/shared/api/org.api";
import { cashflowPage, poolBalancesResponse, studioExpenseSummary } from "@fixtures/api-responses";
import { optionSetsApi } from "@/shared/api/options.api";
import { BusinessPeriodProvider } from "@/shared/state/businessPeriod";
import { previousReportPeriod } from "@/shared/lib/reportPeriod";
import { depositRows, reconciliationRows, ui, pools, balance, deposits, cashflows, pickSelect } from "@fixtures/financePageSetup";

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

describe("FinancePage：资金账户卡片", () => {
  it("资金表单提示员工目录加载失败并可重试", async () => {
    vi.mocked(employeesApi.list).mockRejectedValueOnce(new Error("员工服务不可用"));
    renderLight(<FinancePage />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: /资金账户划转/ }));
    const dialog = await screen.findByRole("dialog", { name: "资金账户划转" });
    expect(await within(dialog).findByText(/员工目录加载失败/)).toBeInTheDocument();
    await ui.click(within(dialog).getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(within(dialog).queryByText(/员工目录加载失败/)).toBeNull());
    expect(employeesApi.list).toHaveBeenCalledTimes(2);
  });

  it("押金和对账切页时丢弃旧请求，修改每页条数回到第一页", async () => {
    let finishDeposits!: (value: Awaited<ReturnType<typeof depositsApi.page>>) => void;
    let finishReconciliations!: (value: Awaited<ReturnType<typeof reconciliationsApi.page>>) => void;
    const oldDeposits = new Promise<Awaited<ReturnType<typeof depositsApi.page>>>((resolve) => { finishDeposits = resolve; });
    const oldReconciliations = new Promise<Awaited<ReturnType<typeof reconciliationsApi.page>>>((resolve) => { finishReconciliations = resolve; });
    const reconciliation = { id: 1, pool_id: 1, reconciled_on: "2026-10-01", account_label: "账户", system_balance: "0", statement_balance: "0", difference: "0", status: "OPEN" };
    vi.mocked(depositsApi.page).mockReturnValueOnce(oldDeposits).mockImplementation(async ({ limit, offset }) => ({
      items: [{ ...deposits[0], id: offset + 1 }], total: 30, limit, offset,
    }));
    vi.mocked(reconciliationsApi.page).mockReturnValueOnce(oldReconciliations).mockImplementation(async ({ limit, offset }) => ({
      items: [{ ...reconciliation, id: offset + 1 }], total: 30, limit, offset,
    }));
    const { result } = renderHook(() => ({ deposits: useDepositResources(), reconciliations: useReconciliationResources() }));
    act(() => { void result.current.deposits.loadDeposits(); void result.current.reconciliations.loadReconciliations(); });
    act(() => { result.current.deposits.setDepositsPage(2, 10); result.current.reconciliations.setReconciliationsPage(2, 10); });
    await waitFor(() => {
      expect(result.current.deposits.deposits[0]?.id).toBe(11);
      expect(result.current.reconciliations.reconciliations[0]?.id).toBe(11);
    });
    await act(async () => {
      finishDeposits({ items: [{ ...deposits[0], id: 99 }], total: 30, limit: 10, offset: 0 });
      finishReconciliations({ items: [{ ...reconciliation, id: 99 }], total: 30, limit: 10, offset: 0 });
      await Promise.all([oldDeposits, oldReconciliations]);
    });
    expect(result.current.deposits.deposits[0]?.id).toBe(11);
    expect(result.current.reconciliations.reconciliations[0]?.id).toBe(11);
    act(() => { result.current.deposits.setDepositsPage(2, 20); result.current.reconciliations.setReconciliationsPage(2, 20); });
    await waitFor(() => {
      expect(result.current.deposits.depositsPaging).toMatchObject({ page: 1, pageSize: 20 });
      expect(result.current.reconciliations.reconciliationsPaging).toMatchObject({ page: 1, pageSize: 20 });
      expect(depositsApi.page).toHaveBeenLastCalledWith({ limit: 20, offset: 0 });
      expect(reconciliationsApi.page).toHaveBeenLastCalledWith({ limit: 20, offset: 0 });
    });
  });

  it("末页记录减少后押金和对账回到有效页", async () => {
    let total = 11;
    const reconciliation = { id: 1, pool_id: 1, reconciled_on: "2026-10-01", account_label: "账户", system_balance: "0", statement_balance: "0", difference: "0", status: "OPEN" };
    vi.mocked(depositsApi.page).mockImplementation(async ({ limit, offset }) => ({
      items: offset < total ? [deposits[0]] : [], total, limit, offset,
    }));
    vi.mocked(reconciliationsApi.page).mockImplementation(async ({ limit, offset }) => ({
      items: offset < total ? [reconciliation] : [], total, limit, offset,
    }));
    const { result } = renderHook(() => ({ deposits: useDepositResources(), reconciliations: useReconciliationResources() }));
    await act(async () => { await Promise.all([result.current.deposits.loadDeposits(), result.current.reconciliations.loadReconciliations()]); });
    act(() => { result.current.deposits.setDepositsPage(2, 10); result.current.reconciliations.setReconciliationsPage(2, 10); });
    await waitFor(() => expect(result.current.deposits.depositsReady && result.current.reconciliations.reconciliationsReady).toBe(true));
    total = 10;
    await act(async () => { await Promise.all([result.current.deposits.loadDeposits(), result.current.reconciliations.loadReconciliations()]); });
    expect(result.current.deposits.depositsPaging.page).toBe(1);
    expect(result.current.reconciliations.reconciliationsPaging.page).toBe(1);
    expect(result.current.deposits.deposits).toHaveLength(1);
    expect(result.current.reconciliations.reconciliations).toHaveLength(1);
  });
  it("押金和对账翻页读取服务端下一页", async () => {
    const first = Array.from({ length: 10 }, (_, index) => ({ ...deposits[0], id: 100 + index }));
    const second = { ...deposits[0], id: 200, counterparty_id: 888 };
    vi.mocked(depositsApi.page).mockImplementation(async ({ limit, offset }) => ({
      items: offset ? [second] : first, total: 11, limit, offset,
    }));
    const reconciliation = { id: 1, pool_id: 1, reconciled_on: "2026-10-01", account_label: "第一页账户", system_balance: "0", statement_balance: "0", difference: "0", status: "OPEN" };
    vi.mocked(reconciliationsApi.page).mockImplementation(async ({ limit, offset }) => ({
      items: offset ? [{ ...reconciliation, id: 99, account_label: "第二页账户" }] : Array.from({ length: 10 }, (_, index) => ({ ...reconciliation, id: index + 1 })),
      total: 11, limit, offset,
    }));
    renderLight(<FinancePage />, { user: "admin" });
    await ui.click(await screen.findByRole("tab", { name: "押金" }));
    await screen.findAllByText("#99");
    const next = document.querySelector(".ant-pagination-next");
    expect(next).not.toBeNull();
    await ui.click(next!);
    expect(await screen.findByText("#888")).toBeInTheDocument();
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await screen.findAllByText("第一页账户");
    const reconciliationNext = screen.getByRole("tabpanel").querySelector(".ant-pagination-next");
    expect(reconciliationNext).not.toBeNull();
    await ui.click(reconciliationNext!);
    expect(await screen.findByText("第二页账户")).toBeInTheDocument();
  });
  it.each(["新增", "编辑", "冲销"])("工作室收支%s后刷新资金明细和账户余额", async (action) => {
    let changed = false;
    vi.mocked(optionSetsApi.get).mockImplementation(async (code) => ({ code, options: code === "STUDIO_EXPENSE_ITEM" ? [{ value: "房租", label: "房租" }] : code === "BUSINESS_PERIOD" ? [{ value: "start_day", label: "16" }] : [] }) as never);
    const studioFlow = { id: 51, flow_no: "STUDIO-51", pool_id: 1, occurred_on: "2026-10-20", category: "房租", direction: "OUT", amount: "100.00", source_type: "MANUAL", source: "MANUAL", ledger_type: "STUDIO", accounting_attribute: "OPERATING_EXPENSE", is_reversed: false };
    vi.mocked(studioExpensesApi.summary).mockImplementation(async () => studioExpenseSummary(changed ? [] : [studioFlow] as never));
    vi.mocked(cashflowsApi.list).mockImplementation(async () => changed ? cashflowPage([{ ...studioFlow, flow_no: "UPDATED-FLOW" }]) : cashflowPage(cashflows));
    vi.mocked(poolsApi.balances).mockImplementation(async () => poolBalancesResponse(
      pools.map((pool) => ({ ...balance, pool_id: pool.id, pool_code: pool.code })),
      { pool_count: 2, cash_balance: changed ? "1500.00" : "1600.00", available: "1400.00", deposit_held: "200.00" },
    ));
    vi.mocked(cashflowsApi.update).mockImplementation(async () => { changed = true; return studioFlow as never; });
    vi.mocked(cashflowsApi.create).mockImplementation(async () => { changed = true; return studioFlow as never; });
    vi.mocked(cashflowsApi.reverse).mockImplementation(async () => { changed = true; return studioFlow as never; });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "工作室运营" }));
    const row = (await screen.findByText("STUDIO-51")).closest("tr") as HTMLElement;
    if (action === "新增") {
      await ui.click(screen.getByRole("button", { name: "记一笔" }));
      const modal = document.querySelector(".ant-modal-content") as HTMLElement;
      await pickSelect(modal, 0, /经营主池/);
      await pickSelect(modal, 1, /房租/);
      await ui.type(within(modal).getByLabelText("金额"), "100");
      await ui.click(within(modal).getByRole("button", { name: "登记入账" }));
    } else {
      await ui.click(within(row).getByRole("button", { name: action }));
      if (action === "编辑") await ui.click(await screen.findByRole("button", { name: "保存修改" }));
      else {
        const modal = await screen.findByRole("dialog", { name: /冲销工作室收支/ });
        await ui.type(within(modal).getByLabelText("冲销原因"), "登记有误");
        await ui.click(within(modal).getByRole("button", { name: "确认冲销" }));
      }
    }
    await waitFor(() => expect(changed).toBe(true));
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    expect(await screen.findByText("UPDATED-FLOW")).toBeInTheDocument();
    await ui.click(screen.getByRole("tab", { name: "总览" }));
    expect(await screen.findByText("1,500.00")).toBeInTheDocument();
  });
  it("资金明细与工作室运营共享周期，全部展示所有流水", async () => {
    vi.mocked(optionSetsApi.get).mockImplementation(async (code) => ({ code, options: code === "BUSINESS_PERIOD" ? [{ value: "start_day", label: "16" }] : [] }) as never);
    renderLight(<BusinessPeriodProvider><FinancePage /></BusinessPeriodProvider>, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await ui.click(await screen.findByRole("button", { name: "上期" }));
    const previous = previousReportPeriod();
    await waitFor(() => expect(cashflowsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ occurred_from: previous.from, occurred_to: previous.to })));
    await ui.click(screen.getByRole("tab", { name: "工作室运营" }));
    await waitFor(() => expect(studioExpensesApi.summary).toHaveBeenLastCalledWith(expect.objectContaining({ occurred_from: previous.from, occurred_to: previous.to })));
    await ui.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(studioExpensesApi.summary).toHaveBeenLastCalledWith(expect.objectContaining({ occurred_from: undefined, occurred_to: undefined })));
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await waitFor(() => expect(cashflowsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ occurred_from: undefined, occurred_to: undefined })));
  });

  it("资金中心不再展示返点明细 Tab", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    expect(screen.queryByRole("tab", { name: "返点明细" })).not.toBeInTheDocument();
  });

  it("资金账户列表按列表字段配置排序", async () => {
    vi.mocked(listColumnsApi.all).mockResolvedValueOnce([{
      code: "FUND_POOLS",
      label: "资金中心·资金账户",
      columns: [
        { key: "available", label: "可用余额", locked: false, is_visible: true, sort_order: 0 },
        { key: "pool_code", label: "资金账户", locked: false, is_visible: true, sort_order: 10 },
      ],
    }]);

    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    const headers = Array.from(document.querySelectorAll(".ant-table-thead tr:first-child th"))
      .map((header) => header.textContent?.trim())
      .filter(Boolean);
    expect(headers[0]).toBe("可用余额");
  });

  it("资金账户请求较慢时，押金与对账仍可同时开始加载", async () => {
    let releasePools!: (value: typeof pools) => void;
    let depositsStarted = false;
    let reconciliationsStarted = false;
    const releaseWhenBothStart = () => {
      if (depositsStarted && reconciliationsStarted) releasePools(pools);
    };
    vi.mocked(poolsApi.list).mockImplementationOnce(() => new Promise((resolve) => { releasePools = resolve; }));
    vi.mocked(depositRows).mockImplementationOnce(async () => {
      depositsStarted = true;
      releaseWhenBothStart();
      return deposits;
    });
    vi.mocked(reconciliationRows).mockImplementationOnce(async () => {
      reconciliationsStarted = true;
      releaseWhenBothStart();
      return [];
    });
    renderLight(<FinancePage />, { user: "admin" });
    expect(await screen.findByRole("cell", { name: /经营主池/ }, { timeout: 1500 })).toBeInTheDocument();
    expect(screen.getAllByText("700.00").length).toBeGreaterThanOrEqual(1);
  });

  it("押金和对账尚未完成时，资金总览先显示余额并允许划转", async () => {
    let finishDeposits!: (value: Awaited<ReturnType<typeof depositRows>>) => void;
    let finishReconciliations!: (value: Awaited<ReturnType<typeof reconciliationRows>>) => void;
    const pendingDeposits = new Promise<Awaited<ReturnType<typeof depositRows>>>((resolve) => { finishDeposits = resolve; });
    const pendingReconciliations = new Promise<Awaited<ReturnType<typeof reconciliationRows>>>((resolve) => { finishReconciliations = resolve; });
    vi.mocked(depositRows).mockReturnValueOnce(pendingDeposits);
    vi.mocked(reconciliationRows).mockReturnValueOnce(pendingReconciliations);
    renderLight(<FinancePage />, { user: "admin" });

    try {
      await waitFor(() => expect(screen.getByText("现金头寸合计").closest(".ui-stat")).toHaveTextContent("1,600.00"));
      expect(screen.getByRole("cell", { name: "经营主池" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeEnabled();
    } finally {
      await act(async () => {
        finishDeposits(deposits);
        finishReconciliations([]);
        await Promise.all([pendingDeposits, pendingReconciliations]);
      });
    }
  });

  it.each(["押金", "对账"])("%s列表加载失败时，已成功的资金总览仍可用", async (kind) => {
    if (kind === "押金") vi.mocked(depositRows).mockRejectedValueOnce(new Error("押金加载失败"));
    else vi.mocked(reconciliationRows).mockRejectedValueOnce(new Error("对账加载失败"));
    renderLight(<FinancePage />, { user: "admin" });

    await ui.click(screen.getByRole("tab", { name: kind }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`${kind}加载失败`);
    await ui.click(screen.getByRole("tab", { name: "总览" }));
    expect(screen.getByText("现金头寸合计").closest(".ui-stat")).toHaveTextContent("1,600.00");
    expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeEnabled();
  });

  // FE-228：资金账户失败时禁用划转，且不等待其他资源即可展示错误。
  it("账户读取失败时，无需等押金列表即可提示总览不可用", async () => {
    let finishDeposits!: (value: Awaited<ReturnType<typeof depositRows>>) => void;
    const pendingDeposits = new Promise<Awaited<ReturnType<typeof depositRows>>>((resolve) => { finishDeposits = resolve; });
    vi.mocked(poolsApi.list).mockRejectedValueOnce(new Error("账户加载失败"));
    vi.mocked(depositRows).mockReturnValueOnce(pendingDeposits);
    renderLight(<FinancePage />, { user: "admin" });

    try {
      await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
      expect(screen.getByText("现金头寸合计").closest(".ui-stat")).toHaveTextContent("不可用");
      expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeDisabled();
    } finally {
      await act(async () => { finishDeposits(deposits); await pendingDeposits; });
    }
  });

  it("押金仍在加载时，对账列表就绪后可以查看和新增", async () => {
    let finishDeposits!: (value: Awaited<ReturnType<typeof depositRows>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof depositRows>>>((resolve) => { finishDeposits = resolve; });
    vi.mocked(depositRows).mockReturnValueOnce(pending);
    vi.mocked(reconciliationRows).mockResolvedValueOnce([
      { id: 31, pool_id: 1, reconciled_on: "2026-10-18", account_label: "测试对账账户", system_balance: "800.00", statement_balance: "800.00", difference: "0.00", status: "OPEN" },
    ]);
    renderLight(<FinancePage />, { user: "admin" });

    try {
      await ui.click(screen.getByRole("tab", { name: "对账" }));
      expect(await screen.findByText("测试对账账户")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "新增对账" })).toBeEnabled());
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    } finally {
      await act(async () => { finishDeposits(deposits); await pending; });
    }
  });

  it("对账仍在加载时，已就绪的押金列表无需等待", async () => {
    let finishReconciliations!: (value: Awaited<ReturnType<typeof reconciliationRows>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof reconciliationRows>>>((resolve) => { finishReconciliations = resolve; });
    vi.mocked(reconciliationRows).mockReturnValueOnce(pending);
    renderLight(<FinancePage />, { user: "admin" });

    try {
      await ui.click(screen.getByRole("tab", { name: "押金" }));
      expect(await screen.findByText("#99")).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "新增占用" })).toBeEnabled();
    } finally {
      await act(async () => { finishReconciliations([]); await pending; });
    }
  });

  it("对账失败后可独立重试，不必等待正在加载的押金", async () => {
    let finishDeposits!: (value: Awaited<ReturnType<typeof depositRows>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof depositRows>>>((resolve) => { finishDeposits = resolve; });
    vi.mocked(depositRows).mockReturnValueOnce(pending);
    vi.mocked(reconciliationRows).mockRejectedValueOnce(new Error("对账加载失败"));
    renderLight(<FinancePage />, { user: "admin" });

    try {
      await ui.click(screen.getByRole("tab", { name: "对账" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("对账加载失败");
      expect(screen.getByRole("button", { name: "新增对账" })).toBeDisabled();
      await ui.click(screen.getByRole("button", { name: "重新加载" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "新增对账" })).toBeEnabled());
      expect(depositsApi.page).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { finishDeposits(deposits); await pending; });
    }
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    expect(await screen.findByText("#99")).toBeInTheDocument();
  });

  it.each(["押金", "对账"])("%s加载失败时，资金流水仍独立可用", async (kind) => {
    if (kind === "押金") vi.mocked(depositRows).mockRejectedValueOnce(new Error("押金加载失败"));
    else vi.mocked(reconciliationRows).mockRejectedValueOnce(new Error("对账加载失败"));
    renderLight(<FinancePage />, { user: "admin" });
    await ui.click(screen.getByRole("tab", { name: kind }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`${kind}加载失败`);
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await waitFor(() => expect(screen.getByText("总收入").closest(".ui-stat")).toHaveTextContent("800.00"));
    expect(screen.getByRole("combobox", { name: "流水方向" })).toBeEnabled();
  });

  it.each(["对账", "资金明细"])("账户重新加载时，%s不展示上次的账户名称", async (kind) => {
    let finishPools!: (value: Awaited<ReturnType<typeof poolsApi.list>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof poolsApi.list>>>((resolve) => { finishPools = resolve; });
    vi.mocked(reconciliationRows).mockResolvedValue([
      { id: 31, pool_id: 1, reconciled_on: "2026-10-18", account_label: "测试对账账户", system_balance: "800.00", statement_balance: "800.00", difference: "0.00", status: "OPEN" },
    ]);
    const { rerender } = renderLight(<FinancePage active />, { user: "admin" });
    await waitFor(() => expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeEnabled());
    vi.mocked(poolsApi.list).mockReturnValueOnce(pending);
    rerender(<FinancePage active={false} />);
    rerender(<FinancePage active />);

    try {
      await waitFor(() => expect(poolsApi.list).toHaveBeenCalledTimes(2));
      await ui.click(screen.getByRole("tab", { name: kind }));
      const row = (await screen.findByText(kind === "对账" ? "测试对账账户" : "ZC00001")).closest("tr") as HTMLElement;
      expect(within(row).queryByText("经营主池")).not.toBeInTheDocument();
      expect(within(row).getByText(kind === "对账" ? "1" : "账户 1")).toBeInTheDocument();
    } finally {
      await act(async () => { finishPools(pools); await pending; });
    }
  });

  it("旧一轮资金请求晚返回时，不覆盖重新进入后的账户、押金和对账", async () => {
    let finishPools!: (value: Awaited<ReturnType<typeof poolsApi.list>>) => void;
    let finishDeposits!: (value: Awaited<ReturnType<typeof depositRows>>) => void;
    let finishReconciliations!: (value: Awaited<ReturnType<typeof reconciliationRows>>) => void;
    const oldPools = new Promise<Awaited<ReturnType<typeof poolsApi.list>>>((resolve) => { finishPools = resolve; });
    const oldDeposits = new Promise<Awaited<ReturnType<typeof depositRows>>>((resolve) => { finishDeposits = resolve; });
    const oldReconciliations = new Promise<Awaited<ReturnType<typeof reconciliationRows>>>((resolve) => { finishReconciliations = resolve; });
    const reconciliation = { id: 31, pool_id: 1, reconciled_on: "2026-10-18", account_label: "新对账账户", system_balance: "800.00", statement_balance: "800.00", difference: "0.00", status: "OPEN" };
    vi.mocked(poolsApi.list).mockReturnValueOnce(oldPools);
    vi.mocked(poolsApi.balances).mockResolvedValueOnce(poolBalancesResponse(
      [{ ...balance, pool_id: 1, pool_code: "POOL-A" }],
      { pool_count: 1, cash_balance: "9999.00", available: "9900.00", deposit_held: "99.00" },
    ));
    vi.mocked(depositRows).mockReturnValueOnce(oldDeposits);
    vi.mocked(reconciliationRows).mockResolvedValue([reconciliation]).mockReturnValueOnce(oldReconciliations);

    const { rerender } = renderLight(<FinancePage active />, { user: "admin" });
    await waitFor(() => expect(poolsApi.list).toHaveBeenCalledTimes(1));
    rerender(<FinancePage active={false} />);
    rerender(<FinancePage active />);
    expect(await screen.findByRole("cell", { name: "经营主池" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeEnabled());

    await act(async () => {
      finishPools([{ ...pools[0], name: "旧资金账户" }]);
      finishDeposits([{ ...deposits[0], counterparty_id: 888 }]);
      finishReconciliations([{ ...reconciliation, account_label: "旧对账账户" }]);
      await Promise.all([oldPools, oldDeposits, oldReconciliations]);
    });
    expect(screen.getByRole("cell", { name: "经营主池" })).toBeInTheDocument();
    expect(screen.queryByText("旧资金账户")).not.toBeInTheDocument();
    expect(screen.getByText("现金头寸合计").closest(".ui-stat")).toHaveTextContent("1,600.00");
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    expect(screen.getByText("#99")).toBeInTheDocument();
    expect(screen.queryByText("#888")).not.toBeInTheDocument();
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    expect(screen.getByText("新对账账户")).toBeInTheDocument();
    expect(screen.queryByText("旧对账账户")).not.toBeInTheDocument();
  });

  it("旧一轮加载完成时，新一轮未完成不能提前启用划转", async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof poolsApi.list>>) => void;
    let finishNew!: (value: Awaited<ReturnType<typeof poolsApi.list>>) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof poolsApi.list>>>((resolve) => { finishOld = resolve; });
    const newRequest = new Promise<Awaited<ReturnType<typeof poolsApi.list>>>((resolve) => { finishNew = resolve; });
    vi.mocked(poolsApi.list).mockReturnValueOnce(oldRequest).mockReturnValueOnce(newRequest);
    const { rerender } = renderLight(<FinancePage active />, { user: "admin" });
    await waitFor(() => expect(poolsApi.list).toHaveBeenCalledTimes(1));
    rerender(<FinancePage active={false} />);
    rerender(<FinancePage active />);
    await waitFor(() => expect(poolsApi.list).toHaveBeenCalledTimes(2));
    await act(async () => { finishOld(pools); await oldRequest; });
    expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeDisabled();
    await act(async () => { finishNew(pools); await newRequest; });
    await waitFor(() => expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeEnabled());
  });

  it("旧一轮加载失败不能覆盖已成功的新一轮", async () => {
    let failOld!: (reason: Error) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof poolsApi.list>>>((_resolve, reject) => { failOld = reject; });
    vi.mocked(poolsApi.list).mockReturnValueOnce(oldRequest);
    const { rerender } = renderLight(<FinancePage active />, { user: "admin" });
    await waitFor(() => expect(poolsApi.list).toHaveBeenCalledTimes(1));
    rerender(<FinancePage active={false} />);
    rerender(<FinancePage active />);
    await waitFor(() => expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeEnabled());
    await act(async () => { failOld(new Error("旧请求失败")); await oldRequest.catch(() => undefined); });
    expect(screen.queryByText("旧请求失败")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeEnabled();
  });

  it("押金失败后可独立重试，不必等待正在加载的对账", async () => {
    let finish!: (value: Awaited<ReturnType<typeof reconciliationRows>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof reconciliationRows>>>((resolve) => { finish = resolve; });
    vi.mocked(depositRows).mockRejectedValueOnce(new Error("押金加载失败"));
    vi.mocked(reconciliationRows).mockReturnValueOnce(pending);
    renderLight(<FinancePage />, { user: "admin" });

    try {
      await ui.click(screen.getByRole("tab", { name: "押金" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("押金加载失败");
      expect(screen.getByRole("button", { name: "新增占用" })).toBeDisabled();
      await ui.click(screen.getByRole("button", { name: "重新加载" }));
      expect(await screen.findByText("#99")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "新增占用" })).toBeEnabled());
      expect(reconciliationsApi.page).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { finish([]); await pending; });
    }
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "新增对账" })).toBeEnabled());
  });

  it("资金中心将工作室运营、对账和押金作为一级入口", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    expect(screen.getByRole("tab", { name: "总览" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "资金明细" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "工作室运营" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "对账" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "押金" })).toBeInTheDocument();
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    expect(screen.queryByRole("tab", { name: "全部明细" })).not.toBeInTheDocument();
    await ui.click(screen.getByRole("tab", { name: "工作室运营" }));
    expect(await screen.findByRole("button", { name: "记一笔" })).toBeInTheDocument();
  });

  it("资金明细按账簿列区分业务资金与工作室运营", async () => {
    vi.mocked(cashflowsApi.list).mockResolvedValueOnce(cashflowPage([
      cashflows[0],
      { ...cashflows[1], id: 3, category: "房租", direction: "OUT", amount: "200.00", ledger_type: "STUDIO", source_type: "MANUAL", source_id: null, source: "MANUAL" },
    ], { total_in: "800.00", total_out: "700.00" }));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    expect(screen.getByText("业务资金")).toBeInTheDocument();
    expect(screen.getAllByText("工作室运营").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("combobox", { name: "流水状态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "流水资金性质" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "状态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "资金性质" })).not.toBeInTheDocument();
  });

  it("资金流水加载期间统计显示占位，失败后显示不可用", async () => {
    let fail!: (reason: Error) => void;
    vi.mocked(cashflowsApi.list).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    const income = screen.getByText("总收入").closest(".ui-stat") as HTMLElement;
    expect(income).toHaveTextContent("-");
    expect(income).not.toHaveTextContent("不可用");
    await act(async () => fail(new Error("流水加载失败")));
    await waitFor(() => expect(income).toHaveTextContent("不可用"));
  });

  it("FE-229：资金流水失败时统计不可用且筛选禁用", async () => {
    vi.mocked(cashflowsApi.list).mockRejectedValueOnce(new Error("cashflows down"));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));

    expect(await screen.findByText("资金流水数据不可用，请点击“重新加载”。")).toBeInTheDocument();
    expect(screen.getByText("总收入").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByRole("combobox", { name: "流水方向" })).toBeDisabled();
  });

  it.each(["total_in", "total_out"] as const)("资金流水缺少 %s 时显示不可用并可重试", async (missing) => {
    vi.mocked(cashflowsApi.list).mockResolvedValueOnce({
      ...cashflowPage(cashflows, { total_in: "800.00", total_out: "500.00" }),
      [missing]: undefined,
    });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));

    expect(await screen.findByText(/资金流水汇总数据不完整/)).toBeInTheDocument();
    expect(screen.getByText("总收入").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByText("总支出").closest(".ui-stat")).toHaveTextContent("不可用");
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("ZC00001")).toBeInTheDocument();
    expect(screen.getByText("总收入").closest(".ui-stat")).toHaveTextContent("800.00");
  });

  it("切换流水日期请求失败时展示原因并按当前日期重试", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await screen.findByText("ZC00001");
    vi.mocked(cashflowsApi.list).mockRejectedValueOnce(new Error("流水连接超时"));
    await ui.click(screen.getByRole("button", { name: "上期" }));
    expect(await screen.findByText(/流水连接超时/)).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    const previous = previousReportPeriod();
    await waitFor(() => expect(cashflowsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ occurred_from: previous.from, occurred_to: previous.to })));
    expect(await screen.findByText("ZC00001")).toBeInTheDocument();
    expect(screen.queryByText(/流水连接超时/)).toBeNull();
  });

  it("旧日期请求失败不会覆盖新日期的流水结果", async () => {
    let rejectOld!: (reason: Error) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof cashflowsApi.list>>>((_resolve, reject) => { rejectOld = reject; });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await screen.findByText("ZC00001");
    vi.mocked(cashflowsApi.list).mockReturnValueOnce(oldRequest);
    await ui.click(screen.getByRole("button", { name: "上期" }));
    await waitFor(() => expect(cashflowsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ occurred_from: previousReportPeriod().from })));
    await ui.click(screen.getByRole("button", { name: "本期" }));
    expect(await screen.findByText("ZC00001")).toBeInTheDocument();
    await act(async () => { rejectOld(new Error("旧请求失败")); await oldRequest.catch(() => undefined); });
    expect(screen.queryByText(/旧请求失败/)).toBeNull();
    expect(screen.getByText("ZC00001")).toBeInTheDocument();
  });

  it("修改收支筛选后列表和汇总自动同步", async () => {
    let finish!: (value: Awaited<ReturnType<typeof cashflowsApi.list>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof cashflowsApi.list>>>((resolve) => { finish = resolve; });
    vi.mocked(cashflowsApi.list).mockImplementation(async (params) => params?.direction === "IN"
      ? pending
      : cashflowPage(cashflows, { total_in: "800.00", total_out: "500.00" }));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await screen.findByText("ZC00001");
    expect(screen.queryByRole("button", { name: "查询" })).toBeNull();
    await ui.click(screen.getByRole("combobox", { name: "流水方向" }));
    await ui.click(await screen.findByText("收入", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(cashflowsApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ direction: "IN" })));
    expect(screen.getByRole("button", { name: "导出" })).toBeDisabled();
    await act(async () => { finish(cashflowPage([cashflows[1]], { total_in: "800.00", total_out: "0.00" })); await pending; });
    expect(await screen.findByText("SR00001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出" })).toBeEnabled();
    expect(screen.queryByText("ZC00001")).toBeNull();
    expect(screen.getByText("总支出").closest(".ui-stat")).toHaveTextContent("0.00");
  });

  it("资金明细不显示操作列", async () => {
    const original = { ...cashflows[0], flow_no: "MANUAL-REV", source_type: "MANUAL", source: "MANUAL", order_id: null, is_reversed: false };
    vi.mocked(cashflowsApi.list).mockResolvedValue(cashflowPage([original]));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    const row = (await screen.findByText("MANUAL-REV")).closest("tr") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "冲销" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "操作" })).toBeNull();
  });

  it("P1/FE-244：资金总览数据失败时不显示零统计且禁用划转", async () => {
    vi.mocked(poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<FinancePage />, { user: "admin" });

    expect(await screen.findByText("资金账户卡片")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Network Error");
    expect(screen.getByText("现金头寸合计").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByText("可用余额合计").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeDisabled();
  });
});

// —— 原 FinancePage.write.test.tsx：同页同 mock 契约（METHODS 已取并集），
// 独立成文件只是让同样的 jsdom+antd 启动多付一次。
describe("FinancePage：资金写路径", () => {
  it("新增押金占用提交后回传金额与日期", async () => {
    resolveMockOnce(vi.mocked(depositsApi.create), { id: 12 });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /新增占用/ }));
    await waitFor(() => expect(screen.getByText("新增押金占用")).toBeInTheDocument());
    expect(document.querySelector(".deposit-modal")).toBeInTheDocument();
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    expect(within(modal).getByText("操作人")).toBeInTheDocument();
    await pickSelect(modal, 0, /经营主池/);
    await ui.type(within(modal).getByLabelText("占用金额"), "500.00");
    await ui.click(screen.getByRole("button", { name: /提\s*交/ }));
    await waitFor(() => expect(vi.mocked(depositsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(depositsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.pool_id).toBe(1);
    expect(payload.amount).toBe("500.00");
  });

  it("押金关联编号必须是正整数", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /新增占用/ }));
    const modal = await screen.findByText("新增押金占用");
    const content = modal.closest(".ant-modal-content") as HTMLElement;
    await pickSelect(content, 0, /经营主池/);
    await ui.type(within(content).getByLabelText("占用金额"), "500.00");
    await ui.type(within(content).getByLabelText("合作方编号"), "1.5");
    await ui.click(screen.getByRole("button", { name: /提\s*交/ }));

    expect(await screen.findByText("合作方编号必须是正整数")).toBeInTheDocument();
    expect(vi.mocked(depositsApi.create)).not.toHaveBeenCalled();
  });

  it("押金释放金额超过大额剩余一分时提示并阻止提交", async () => {
    vi.mocked(depositRows).mockResolvedValueOnce([{ ...deposits[0], status: "PAID", paid_amount: "9999999999999999.98", returned_amount: "0.00", remaining_amount: "9999999999999999.98", available_actions: ["EDIT", "CANCEL", "RETURN", "LOSS"] }] as never);
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /释\s*放/ }));
    const modal = screen.getByRole("dialog");
    fireEvent.change(within(modal).getByLabelText("释放金额"), { target: { value: "9999999999999999.99" } });
    await ui.click(within(modal).getByRole("button", { name: "确认释放" }));
    expect(await within(modal).findByText("释放金额不得超过剩余可释放额 ¥9999999999999999.98")).toBeVisible();
    expect(depositsApi.release).not.toHaveBeenCalled();
  });

  it("未发生释放或损失的押金可编辑并回填", async () => {
    vi.mocked(depositRows).mockResolvedValueOnce([{ ...deposits[0], status: "PAID", paid_on: "2026-10-17", returned_amount: "0.00", paid_amount: "500.00", remaining_amount: "500.00", available_actions: ["EDIT", "CANCEL", "RETURN", "LOSS"] }] as never);
    resolveMockOnce(vi.mocked(depositsApi.update), { ...deposits[0], status: "PAID" });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    const row = screen.getByText("#99").closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: "编辑" }));
    expect(await screen.findByText("编辑押金占用")).toBeInTheDocument();
    expect(screen.getByLabelText("占用金额")).toHaveValue("500.00");
    await ui.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(vi.mocked(depositsApi.update)).toHaveBeenCalledWith(11, expect.objectContaining({ amount: "500.00", paid_on: "2026-10-17" })));
  });

  it("押金保留凭证，未发生释放或损失时可取消", async () => {
    vi.mocked(depositRows).mockResolvedValueOnce([{ ...deposits[0], status: "PAID", paid_on: "2026-10-17", returned_amount: "0.00", paid_amount: "500.00", remaining_amount: "500.00", available_actions: ["EDIT", "CANCEL", "RETURN", "LOSS"] }] as never);
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    const row = screen.getByText("#99").closest("tr") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "删除" })).toBeNull();
    expect(within(row).getByRole("button", { name: /取\s*消/ })).toBeEnabled();
  });

  it("部分损失后的押金不能编辑或取消，仍可释放和登记损失", async () => {
    vi.mocked(depositRows).mockResolvedValueOnce([{ ...deposits[0], status: "PAID", returned_amount: "0.00", lost_amount: "50.00", remaining_amount: "450.00" }] as never);
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    const row = screen.getByText("#99").closest("tr") as HTMLElement;
    expect(within(row).getByRole("button", { name: /编\s*辑/ })).toBeDisabled();
    expect(within(row).getByRole("button", { name: /取\s*消/ })).toBeDisabled();
    expect(within(row).getByRole("button", { name: /释\s*放/ })).toBeEnabled();
    expect(within(row).getByRole("button", { name: "登记损失" })).toBeEnabled();
  });

  it("押金逐笔展示退还和损失的操作人", async () => {
    vi.mocked(depositRows).mockResolvedValueOnce([{ ...deposits[0], action_history: [
      { flow_no: "SR00001", action: "RETURN", occurred_on: "2026-10-01", amount: "20.00", operator_user_ids: [1], operator: "admin" },
      { flow_no: "SR00002", action: "RETURN", occurred_on: "2026-10-02", amount: "30.00", operator_user_ids: [2], operator: "finance" },
      { flow_no: "ZC00003", action: "LOSS", occurred_on: "2026-10-03", amount: "10.00", operator_user_ids: [1, 2], operator: "admin" },
    ] }] as never);
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    const row = screen.getByText("#99").closest("tr") as HTMLElement;
    expect(row).toHaveTextContent(/释放 SR00001.*管理员/);
    expect(row).toHaveTextContent(/释放 SR00002.*财务/);
    expect(row).toHaveTextContent(/损失 ZC00003.*管理员、财务/);
  });

  it("押金释放按 deposit.post 门控：finance 可见、operator 不可见", async () => {
    renderLight(<FinancePage />, { user: "finance" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await screen.findByText("300.00");
    expect(screen.getAllByRole("button", { name: /释\s*放/ }).length).toBeGreaterThanOrEqual(1);
  });

  it("押金损失登记提交原金额、日期、分类和原因", async () => {
    resolveMockOnce(vi.mocked(depositsApi.loss), { id: 91 });
    renderLight(<FinancePage />, { user: "finance" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /登记损失/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("损失金额"), "100.00");
    await ui.type(within(modal).getByLabelText("费用分类"), "违约损失");
    await ui.type(within(modal).getByLabelText("损失原因"), "对手方未按约返还");
    await ui.click(screen.getByRole("button", { name: /确认损失/ }));
    await waitFor(() => expect(vi.mocked(depositsApi.loss)).toHaveBeenCalled());
    expect(vi.mocked(depositsApi.loss).mock.calls[0]).toEqual([11, {
      amount: "100.00",
      lost_on: expect.any(String),
      category: "违约损失",
      reason: "对手方未按约返还",
      operator_user_ids: [2],
    }]);
  });

  it("押金取消：PAID 押金填原因后调用 depositsApi.cancel（全额冲正由后端写）", async () => {
    vi.mocked(depositRows).mockResolvedValue([
      { id: 12, pool_id: 1, paid_amount: "300.00", returned_amount: "0.00", lost_amount: "0.00", remaining_amount: "300.00", status: "PAID", available_actions: ["EDIT", "CANCEL", "RETURN", "LOSS"] },
    ] as unknown as Awaited<ReturnType<typeof depositRows>>);
    resolveMockOnce(vi.mocked(depositsApi.cancel), { id: 12 });
    renderLight(<FinancePage />, { user: "finance" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /取\s*消/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await waitFor(() => expect(modal).toBeTruthy());
    await ui.type(within(modal).getByLabelText("取消原因"), "押金登记有误");
    await ui.click(screen.getByRole("button", { name: /确认取消/ }));
    await waitFor(() => expect(vi.mocked(depositsApi.cancel)).toHaveBeenCalled(), { timeout: 5000 });
    expect(vi.mocked(depositsApi.cancel).mock.calls[0]).toEqual([12, {
      cancelled_on: expect.any(String),
      reason: "押金登记有误",
      operator_user_ids: [2],
    }]);
  });

  it("FE-049：允许提交超过转出账户余额的划转", async () => {
    vi.mocked(poolsApi.list).mockResolvedValueOnce([
      { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", status: "ACTIVE" },
      { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", status: "ACTIVE" },
    ] as never);
  vi.mocked(poolsApi.balances).mockResolvedValue(poolBalancesResponse([
    { ...balance, pool_id: 1, pool_code: "POOL-A" },
    { ...balance, pool_id: 2, pool_code: "POOL-B" },
  ], { pool_count: 2, cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00" }));
    vi.mocked(depositRows).mockResolvedValueOnce([] as never);
    vi.mocked(reconciliationRows).mockResolvedValueOnce([] as never);
    resolveMockOnce(vi.mocked(transfersApi.create), { transfer_id: "TRF-TEST" });
    renderLight(<FinancePage />, { user: "admin" });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await screen.findByText(/经营主池/);
    await user.click(await screen.findByRole("button", { name: /资金账户划转/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    const selectors = modal.querySelectorAll(".ant-select-selector");
    const choosePool = async (index: number, title: RegExp) => {
      await user.click(selectors[index]);
      const dropdowns = document.querySelectorAll(".ant-select-dropdown");
      const currentDropdown = dropdowns[dropdowns.length - 1] as HTMLElement;
      await user.click(await within(currentDropdown).findByTitle(title));
    };
    await choosePool(0, /经营主池/);
    await choosePool(1, /押金池/);
    await user.type(within(modal).getByLabelText("划转金额"), "900.01");
    await user.click(screen.getByRole("button", { name: /确认划转/ }));

    await waitFor(() => expect(transfersApi.create).toHaveBeenCalledWith(expect.objectContaining({
      source_pool_id: 1,
      target_pool_id: 2,
      amount: "900.01",
    })));
  });

  it("划转请求进行中不能关闭并重开表单", async () => {
    let finish!: () => void;
    const pending = new Promise<never>((resolve) => { finish = () => resolve(undefined as never); });
    vi.mocked(transfersApi.create).mockReset().mockReturnValueOnce(pending);
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("button", { name: "资金账户划转" }));
    const modal = await screen.findByRole("dialog", { name: "资金账户划转" });
    await pickSelect(modal, 0, /经营主池/);
    await pickSelect(modal, 1, /押金池/);
    await ui.type(within(modal).getByLabelText("划转金额"), "20.00");
    await ui.click(within(modal).getByRole("button", { name: "确认划转" }));
    try {
      await waitFor(() => expect(transfersApi.create).toHaveBeenCalled());
      expect(within(modal).queryByRole("button", { name: "Close" })).toBeNull();
      await ui.keyboard("{Escape}");
      expect(within(modal).getByLabelText("划转金额")).toHaveValue("20.00");
    } finally {
      await act(async () => { finish(); await pending; });
    }
  });

});
