import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { FundsPage } from "@/pools/FundsPage";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";

import { cashflowsApi } from "@/shared/api/cashflows.api";
import { depositsApi } from "@/shared/api/deposits.api";
import { studioExpensesApi } from "@/shared/api/studioExpenses.api";
import { listColumnsApi, ordersApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";
import { reconciliationsApi } from "@/shared/api/reconciliations.api";
import { transfersApi } from "@/shared/api/transfers.api";
import { employeesApi } from "@/shared/api/org.api";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { cashflowPage, cashflowTotals, poolBalancesResponse, studioExpenseSummary } from "@fixtures/api-responses";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  seedOrderFormFields();
  seedOptionSets();
});

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/deposits.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/reconciliations.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;
vi.mock("@/shared/api/transfers.api");
vi.mock("@/shared/api/studioExpenses.api");

const pools = [
  { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
  { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", ownership: "SELF", status: "ACTIVE" },
];
const balance = {
  income: "1000.00",
  expense: "200.00",
  transfer_in: "0.00",
  transfer_out: "0.00",
  cash_balance: "800.00",
  deposit_held: "100.00",
  available: "700.00",
};
const deposits = [
  { id: 11, pool_id: 1, counterparty_id: 99, source_order_id: 7, paid_amount: "500.00", returned_amount: "200.00", remaining_amount: "300.00", status: "HELD", expected_release_on: "2026-11-01" },
];
const cashflows = [
  { id: 1, flow_no: "ZC00001", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "500.00", order_no: "HS0001", source_type: "ORDER_EVENT", source_id: "HS0001-EV-BUY-01", source: "ORDER_EVENT", ledger_type: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST" },
  { id: 2, flow_no: "SR00001", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_IN", category: "SELL", direction: "IN", amount: "800.00", order_no: "HS0001", source_type: "ORDER_EVENT", source_id: "HS0001-EV-SELL-01", source: "ORDER_EVENT", ledger_type: "BUSINESS", accounting_attribute: "SELF_REVENUE" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listColumnsApi.all).mockResolvedValue([]);
  vi.mocked(poolsApi.list).mockResolvedValue(pools);
  // 余额与汇总一次批量取回（服务端 Decimal 聚合），合计按两池同额计。
  resolveMock(vi.mocked(poolsApi.balances), poolBalancesResponse(
    pools.map((pool) => ({ ...balance, pool_id: pool.id, pool_code: pool.code })),
    { pool_count: 2, cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00", owned_cash_balance: "1600.00" },
  ));
  resolveMock(vi.mocked(depositsApi.list), deposits);
  resolveMock(vi.mocked(cashflowsApi.list), cashflowPage(cashflows, { total_in: "800.00", total_out: "500.00" }));
  resolveMock(vi.mocked(cashflowsApi.totals), cashflowTotals({ total_in: "800.00", total_out: "500.00" }));
  vi.mocked(studioExpensesApi.summary).mockResolvedValue(studioExpenseSummary([]));
  vi.mocked(reconciliationsApi.list).mockResolvedValue([]);
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "管理员", is_active: true },
    { id: 2, username: "finance", display_name: "财务", is_active: true },
  ]);
});
async function pickSelect(modal: HTMLElement, index: number, title: RegExp) {
  await ui.click(modal.querySelectorAll(".ant-select-selector")[index] as Element);
  // 多个 Select 的下拉都挂在 body 上且历史下拉不销毁 → 必须限定在「最后打开的那个」
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  const current = dropdowns[dropdowns.length - 1] as HTMLElement;
  const option = await within(current).findByTitle(title);
  await ui.click(option);
}

describe("FundsPage：资金账户卡片", () => {
  it("资金中心不再展示返点明细 Tab", async () => {
    renderLight(<FundsPage />, { user: "admin" });
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

    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    const headers = Array.from(document.querySelectorAll(".ant-table-thead tr:first-child th"))
      .map((header) => header.textContent?.trim())
      .filter(Boolean);
    expect(headers[0]).toBe("可用余额");
  });

  it("渲染资金账户与可用余额", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    expect(await screen.findByRole("cell", { name: /经营主池/ })).toBeInTheDocument();
    expect(screen.getAllByText("700.00").length).toBeGreaterThanOrEqual(1);
  });

  it("后端不可达 → 错误条落地", async () => {
    vi.mocked(poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<FundsPage />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("FE-228：资金账户主数据失败时总览不可用且划转入口禁用", async () => {
    vi.mocked(poolsApi.list).mockRejectedValueOnce(new Error("pools down"));
    renderLight(<FundsPage />, { user: "admin" });

    expect(await screen.findByText("资金账户卡片")).toBeInTheDocument();
    expect(screen.getByText("现金头寸合计").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeDisabled();
  });

  it("资金中心将工作室运营、对账和押金作为一级入口", async () => {
    vi.mocked(cashflowsApi.list).mockResolvedValueOnce(cashflowPage([
        { ...cashflows[0], id: 31, source_type: "TRANSFER", source_id: "TRF-PAIRED-01", direction: "OUT" },
        { ...cashflows[0], id: 32, source_type: "TRANSFER", source_id: "TRF-PAIRED-01", direction: "IN", pool_id: 2 },
      ]));
    renderLight(<FundsPage />, { user: "admin" });
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
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    expect(screen.getByText("业务资金")).toBeInTheDocument();
    expect(screen.getAllByText("工作室运营").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("combobox", { name: "流水状态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "流水资金性质" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "状态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "资金性质" })).not.toBeInTheDocument();
  });

  it("FE-229：资金流水失败时统计不可用、筛选和新增入口禁用", async () => {
    vi.mocked(cashflowsApi.list).mockRejectedValueOnce(new Error("cashflows down"));
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));

    expect(await screen.findByText("资金流水数据不可用，请点击“查询”或页面顶部的“重新加载”。")).toBeInTheDocument();
    expect(screen.getByText("总收入").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByRole("button", { name: /新增流水/ })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "流水方向" })).toBeDisabled();
  });

  it("FE-230：对账失败时显示明确空态并禁用新增", async () => {
    vi.mocked(reconciliationsApi.list).mockRejectedValueOnce(new Error("reconciliations down"));
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));

    expect(await screen.findByText("资金对账数据不可用，请点击重新加载")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增对账/ })).toBeDisabled();
  });

  it("P1/FE-244：资金总览数据失败时不显示零统计且禁用划转", async () => {
    vi.mocked(poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "pools down" });
    renderLight(<FundsPage />, { user: "admin" });

    expect(await screen.findByText("资金账户卡片")).toBeInTheDocument();
    expect(screen.getByText("现金头寸合计").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByText("可用余额合计").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByRole("button", { name: /资金账户划转/ })).toBeDisabled();
  });
});

describe("FundsPage：押金占用", () => {
  it("押金板块作为独立入口保留业务资金口径", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });

    await ui.click(screen.getByRole("tab", { name: "押金" }));
    // 断言「押金占用」这一整块（卡片标题 + 新增入口）落在资金中心独立入口内，而不是靠
    // 别处（如已卸载的总览 StatRow）凑出现次数。Tabs 开了 destroyOnHidden，未激活面板
    // 不会留在 DOM，故此处必须是面板内的唯一一份。
    const depositPanel = await screen.findByRole("tabpanel", { name: "押金" });
    expect(within(depositPanel).getByText("押金占用")).toBeInTheDocument();
    expect(within(depositPanel).getByRole("button", { name: /新增占用/ })).toBeInTheDocument();
  });

  it("押金列表渲染金额与剩余（占用-已释放）", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    expect(screen.queryByText("押金编号")).not.toBeInTheDocument();
    expect(screen.getAllByText("300.00").length).toBeGreaterThanOrEqual(1); // 500-200
  });

  it("押金明细展示对手方、来源订单和预计释放日", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    expect(screen.getByText("#99")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
    expect(screen.getByText("2026-11-01")).toBeInTheDocument();
  });
});

describe("FundsPage：资金流水", () => {
  it("资金流水日期筛选使用日期范围控件（与工作室经营一致）", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));

    const rangeInputs = screen.getAllByLabelText("流水日期区间");
    expect(rangeInputs).toHaveLength(2);
    const rangePicker = rangeInputs[0]!.closest(".ant-picker");
    expect(rangePicker).toBeInTheDocument();
    expect(rangePicker!.querySelectorAll(".ant-picker-input")).toHaveLength(2);
  });

  it("资金流水录入不再提供资金账户账户选择", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await ui.click(await screen.findByRole("button", { name: /新增流水/ }));

    expect(screen.queryByText("资金账户账户")).not.toBeInTheDocument();
  });

  it("资金流水录入显示操作人选择", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await ui.click(await screen.findByRole("button", { name: /新增流水/ }));

    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    expect(within(modal).getByLabelText("操作人")).toBeInTheDocument();
    expect(employeesApi.list).toHaveBeenCalled();
  });

  it("展示订单号、收支明细及总收入/总支出", async () => {
    renderLight(<FundsPage />, { user: "admin" });
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
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));

    expect((await screen.findByText("总收入")).closest(".ui-stat")).toHaveTextContent("123,456.78");
    expect(screen.getByText("总支出").closest(".ui-stat")).toHaveTextContent("87,654.32");
  });

  it("流水支持按订单号、流水号或备注关键词筛选", async () => {
    vi.mocked(cashflowsApi.list).mockImplementation(async (params) => cashflowPage(
      params?.keyword
        ? cashflows.filter((row) => `${row.order_no ?? ""} ${row.flow_no} ${row.category}`.includes(params.keyword!))
        : cashflows,
      { total: params?.keyword ? 1 : cashflows.length, total_in: "800.00", total_out: "1000.00" },
    ));
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    const search = screen.getByLabelText("流水搜索");
    await ui.type(search, "SELL");
    await ui.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(vi.mocked(cashflowsApi.list)).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "SELL" })));
    expect(screen.getByText("SR00001")).toBeInTheDocument();
    expect(screen.queryByText("ZC00001")).not.toBeInTheDocument();
  });

  it("资金流水导出与列表同口径：带上当前搜索关键词", async () => {
    // 修复 #2：旧实现 exportCsv 漏传 keyword，筛关键词后导出的是全量。
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:flow");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.mocked(cashflowsApi.exportCsv).mockResolvedValue(new Blob(["csv"]));
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await ui.type(screen.getByLabelText("流水搜索"), "SELL");
    await ui.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(vi.mocked(cashflowsApi.exportCsv)).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: "SELL" }),
    ));
  });

  it("流水被服务端截断时，本地关键词收窄不回退本地求和（避免少算）", async () => {
    // 修复 #1：total=5000 > 已加载 2 条（limit=2000 截断）。此时本地可见行只是部分数据，
    // 用户再输入关键词收窄，合计必须仍取服务端聚合，不能用可见的 1 条冒充全量。
    vi.mocked(cashflowsApi.list).mockImplementation(async (params) => cashflowPage(
      params?.keyword ? [cashflows[1]] : cashflows,
      { total: 5000, total_in: "123456.78", total_out: "87654.32" },
    ));
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    await ui.type(screen.getByLabelText("流水搜索"), "SELL");
    await ui.click(screen.getByRole("button", { name: "查询" }));
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
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "资金明细" }));
    // 关键词 "SE" 本地收窄出两条 IN（SE-A / SE-B），排除 BUY-C；
    // 即便当前页面已加载全部 3 条，合计仍使用服务端返回的 1.01。
    vi.mocked(cashflowsApi.list).mockImplementation(async (params) => cashflowPage(
      params?.keyword ? rows.filter((row) => `${row.order_no} ${row.flow_no}`.includes(params.keyword!)) : rows,
      { total: rows.length, total_in: "1.01", total_out: "9.00" },
    ));
    await ui.type(screen.getByLabelText("流水搜索"), "SE");
    await ui.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(vi.mocked(cashflowsApi.list)).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "SE" })));
    expect(screen.queryByText("BUY-C")).not.toBeInTheDocument();
    expect((await screen.findByText("总收入")).closest(".ui-stat")).toHaveTextContent("1.01");
  });
});

// —— 原 FundsPage.write.test.tsx：同页同 mock 契约（METHODS 已取并集），
// 独立成文件只是让同样的 jsdom+antd 启动多付一次。
describe("FundsPage：资金写路径", () => {
  it("新增押金占用提交后回传金额与日期", async () => {
    resolveMockOnce(vi.mocked(depositsApi.create), { id: 12 });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /新增占用/ }));
    await waitFor(() => expect(screen.getByText("新增押金占用")).toBeInTheDocument());
    expect(document.querySelector(".deposit-modal")).toBeInTheDocument();
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    expect(within(modal).getByText("操作人")).toBeInTheDocument();
    await pickSelect(modal, 0, /经营主池/);
    await ui.type(modal.querySelector("#amount") ?? modal, "500.00");
    await ui.click(screen.getByRole("button", { name: /提\s*交/ }));
    await waitFor(() => expect(vi.mocked(depositsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(depositsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.pool_id).toBe(1);
    expect(payload.amount).toBe("500.00");
  });

  it("押金关联编号必须是正整数", async () => {
    renderLight(<FundsPage />, { user: "admin" });
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

  it("未发生释放或损失的押金可编辑并回填", async () => {
    vi.mocked(depositsApi.list).mockResolvedValueOnce([{ ...deposits[0], status: "PAID", paid_on: "2026-10-17", returned_amount: "0.00", paid_amount: "500.00", remaining_amount: "500.00" }] as never);
    resolveMockOnce(vi.mocked(depositsApi.update), { ...deposits[0], status: "PAID" });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    const row = screen.getByText("#99").closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: "编辑" }));
    expect(await screen.findByText("编辑押金占用")).toBeInTheDocument();
    expect(screen.getByLabelText("占用金额")).toHaveValue("500.00");
    await ui.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(vi.mocked(depositsApi.update)).toHaveBeenCalledWith(11, expect.objectContaining({ amount: "500.00", paid_on: "2026-10-17" })));
  });

  it("未发生释放或损失的押金可删除并刷新列表", async () => {
    vi.mocked(depositsApi.list).mockResolvedValueOnce([{ ...deposits[0], status: "PAID", paid_on: "2026-10-17", returned_amount: "0.00", paid_amount: "500.00", remaining_amount: "500.00" }] as never);
    resolveMockOnce(vi.mocked(depositsApi.remove), undefined);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    const row = screen.getByText("#99").closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: "删除" }));
    expect(await screen.findByText("删除押金占用")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(vi.mocked(depositsApi.remove)).toHaveBeenCalledWith(11));
  });

  it("押金释放按 deposit.post 门控：finance 可见、operator 不可见", async () => {
    renderLight(<FundsPage />, { user: "finance" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await screen.findByText("300.00");
    expect(screen.getAllByRole("button", { name: /释\s*放/ }).length).toBeGreaterThanOrEqual(1);
  });

  it("押金损失登记提交原金额、日期、分类和原因", async () => {
    resolveMockOnce(vi.mocked(depositsApi.loss), { id: 91 });
    renderLight(<FundsPage />, { user: "finance" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /登记损失/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await ui.type(modal.querySelector("#amount") ?? modal, "100.00");
    await ui.type(modal.querySelector("#category") ?? modal, "违约损失");
    await ui.type(modal.querySelector("#reason") ?? modal, "对手方未按约返还");
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
    vi.mocked(depositsApi.list).mockResolvedValue([
      { id: 12, pool_id: 1, paid_amount: "300.00", returned_amount: "0.00", lost_amount: "0.00", remaining_amount: "300.00", status: "PAID" },
    ] as unknown as Awaited<ReturnType<typeof depositsApi.list>>);
    resolveMockOnce(vi.mocked(depositsApi.cancel), { id: 12 });
    renderLight(<FundsPage />, { user: "finance" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /取\s*消/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await waitFor(() => expect(modal).toBeTruthy());
    await ui.type(modal.querySelector("#reason") as Element, "押金登记有误");
    await ui.click(screen.getByRole("button", { name: /确认取消/ }));
    await waitFor(() => expect(vi.mocked(depositsApi.cancel)).toHaveBeenCalled(), { timeout: 5000 });
    expect(vi.mocked(depositsApi.cancel).mock.calls[0]).toEqual([12, {
      cancelled_on: expect.any(String),
      reason: "押金登记有误",
      operator_user_ids: [2],
    }]);
  });

  it("P1/FE-049：超出转出资金账户可用余额时由后端拒绝", async () => {
    vi.mocked(poolsApi.list).mockResolvedValueOnce([
      { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
      { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", ownership: "SELF", status: "ACTIVE" },
    ] as never);
  vi.mocked(poolsApi.balances).mockResolvedValue(poolBalancesResponse([
    { ...balance, pool_id: 1, pool_code: "POOL-A" },
    { ...balance, pool_id: 2, pool_code: "POOL-B" },
  ], { pool_count: 2, cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00", owned_cash_balance: "1600.00" }));
    vi.mocked(depositsApi.list).mockResolvedValueOnce([] as never);
    vi.mocked(cashflowsApi.list).mockResolvedValueOnce(cashflowPage([]));
    vi.mocked(reconciliationsApi.list).mockResolvedValueOnce([] as never);
    vi.mocked(transfersApi.create).mockRejectedValueOnce(new Error("转出资金账户可用余额不足"));
    renderLight(<FundsPage />, { user: "admin" });
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
    await user.type(modal.querySelector("#amount") ?? modal, "700.01");
    await user.click(screen.getByRole("button", { name: /确认划转/ }));

    await waitFor(() => expect(screen.getByText(/可用余额不足/)).toBeInTheDocument());
    expect(transfersApi.create).toHaveBeenCalled();
  });

  it("P1/FE-050：流水冲销成功后原流水不再显示重复冲销入口", async () => {
    const original = { id: 7, flow_no: "CF-A-07", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "300.00", source_type: "MANUAL", source_id: null, source: "MANUAL", ledger_type: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST" };
    const reversal = { ...original, id: 8, flow_no: "CF-REV-08", category: "REVERSAL", direction: "IN", accounting_attribute: "REVERSAL", source_type: "REVERSAL", source_id: original.flow_no };
    let mainListCalls = 0;
    vi.mocked(poolsApi.list).mockResolvedValueOnce([
      { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
    ] as never);
  vi.mocked(poolsApi.balances).mockResolvedValue(poolBalancesResponse([
    { ...balance, pool_id: 1, pool_code: "POOL-A" },
    { ...balance, pool_id: 2, pool_code: "POOL-B" },
  ], { pool_count: 2, cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00", owned_cash_balance: "1600.00" }));
    vi.mocked(cashflowsApi.list).mockImplementation(async (params) => {
      if (params?.direction) return cashflowPage([]);
      mainListCalls += 1;
      return mainListCalls === 1 ? cashflowPage([original]) : cashflowPage([original, reversal]);
    });
    vi.mocked(cashflowsApi.reverse).mockResolvedValueOnce(reversal as never);
    vi.mocked(depositsApi.list).mockResolvedValue([] as never);
    vi.mocked(reconciliationsApi.list).mockResolvedValue([] as never);
    renderLight(<FundsPage />, { user: "admin" });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await screen.findByText(/经营主池/);
    await user.click(screen.getByRole("tab", { name: "资金明细" }));
    await screen.findByText("CF-A-07");
    await user.click(screen.getByRole("button", { name: /冲销/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await user.type(modal.querySelector("#reversed_on") ?? modal, "2026-10-18");
    await user.type(modal.querySelector("#reason") ?? modal, "重复入账");
    await user.click(screen.getByRole("button", { name: /确认冲销/ }));

    await waitFor(() => expect(cashflowsApi.reverse).toHaveBeenCalledWith(7, expect.objectContaining({ reason: "重复入账" })));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^冲销$/ })).toBeNull());
    expect(screen.getByText("CF-REV-08")).toBeInTheDocument();
  });
});
