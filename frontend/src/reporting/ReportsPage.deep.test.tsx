import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { ReportsPage } from "./ReportsPage";
import { resolveMock, resolveMockOnce } from "../test/mock-api";

import * as catalog from "../shared/api/catalog";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("../shared/api/catalog");

// 报表 DataTable 重型，替换为轻量实现（与 ReportsPage.test.tsx 一致），
// MoneyText / StatusTag / StatRow / ErrorBanner 仍用真实组件。
vi.mock("../shared/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { LightweightDataTable } = await import("../test/LightweightDataTable");
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
  resolveMock(vi.mocked(catalog.reportsApi.dailyFunds), { date: "2026-10-01", total: {}, items: [] });
  resolveMock(vi.mocked(catalog.reportsApi.financeDimensions), {
    items: [],
    total_amount: "0",
    total_signed_amount: "0",
  });
  resolveMock(vi.mocked(catalog.reportsApi.businessPnl), { items: [], total: {} });
  resolveMock(vi.mocked(catalog.reportsApi.orderProfit), {
    items: [],
    total: { income: "0", direct_cost: "0", rebate: "0", net_profit: "0" },
  });
  resolveMock(vi.mocked(catalog.reportsApi.exportCsv), new Blob(["csv"]));
  // 数据中心面板（同页挂载）：空池空单——本文件只关心报表 Tab，桩位兜底即可。
  vi.mocked(catalog.poolsApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(catalog.poolsApi.balance), {
    income: "0.00",
    expense: "0.00",
    cash_balance: "0.00",
    deposit_held: "0.00",
    available: "0.00",
  });
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([]);
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
    await gotoTab("资金日报 R4");
    expect((await screen.findAllByText("POOL-A")).length).toBeGreaterThanOrEqual(1); // 资金池/名称两列同值
    expect(screen.getByText(/2026-10-08/)).toBeInTheDocument(); // 标题含日期
    expect(screen.getAllByText("现金余额").length).toBeGreaterThanOrEqual(1); // StatRow + 列标题
    expect(screen.getAllByText("可用余额").length).toBeGreaterThanOrEqual(1); // StatRow + 列标题
  });

  it("R4 资金日报：切换日期带 on 参数重新拉取（#56）", async () => {
    vi.mocked(catalog.reportsApi.dailyFunds).mockClear();
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("资金日报 R4");
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.dailyFunds)).toHaveBeenCalled());
    const dateInput = screen.getByLabelText("资金日报日期");
    fireEvent.change(dateInput, { target: { value: "2026-10-08" } });
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.dailyFunds)).toHaveBeenLastCalledWith({ on: "2026-10-08" }));
  });

  it("资金属性分析：渲染资金账户 / 方向 / 净方向金额", async () => {
    resolveMockOnce(vi.mocked(catalog.reportsApi.financeDimensions), {
      items: [
        {
          pool_name: "POOL-A",
          account_name: "经营账户",
          account_no: "A1",
          fund_nature: "BUSINESS",
          accounting_attribute: "SELF_REVENUE",
          direction: "IN",
          flow_count: 3,
          amount: "100.00",
          signed_amount: "100.00",
        },
      ],
      total_amount: "100.00",
      total_signed_amount: "100.00",
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("资金属性分析");
    await screen.findByText("经营账户（A1）"); // account_name 拼接 account_no
    expect(screen.getByText("收入")).toBeInTheDocument(); // direction === IN
    expect(screen.getByText("本方经营")).toBeInTheDocument(); // fund_nature 中文映射（#60）
    expect(screen.getByText("自营收入")).toBeInTheDocument(); // accounting_attribute 中文映射（#60）
    expect(screen.getAllByText("净方向金额").length).toBeGreaterThanOrEqual(1);
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

  it("导出成功分支：stub URL 后真正创建下载锚点", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    renderLight(<ReportsPage />, { user: "admin" });
    const selector = screen.getByText("选择导出报表").closest(".ant-select")!.querySelector(".ant-select-selector") as HTMLElement;
    await ui.click(selector);
    const listbox = await screen.findByRole("listbox");
    await ui.click(within(listbox).getByText("库存健康"));
    await ui.click(screen.getByRole("button", { name: /导出/ }));
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.exportCsv)).toHaveBeenCalled());
    expect(createUrl).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalled();
    createUrl.mockRestore();
    revokeUrl.mockRestore();
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

  it("R3 加载失败显示错误条，点「重新加载」可重试成功", async () => {
    vi.mocked(catalog.reportsApi.commission).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" } as unknown as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("提成对账 R3");
    await waitFor(() => expect(document.querySelector(".ui-error-banner")).toBeTruthy());
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await screen.findByText("应付合计"); // 重试成功后渲染 Commission StatRow
  });
});
