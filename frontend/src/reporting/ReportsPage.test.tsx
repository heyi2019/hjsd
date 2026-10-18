import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { ReportsPage } from "./ReportsPage";

import * as catalog from "../shared/api/catalog";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

// jsdom 不执行真实下载跳转；屏蔽 anchor.click，避免导出测试留下 navigation 定时器拖住全量单测。
beforeAll(() => {
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

vi.mock("../shared/api/catalog")

vi.mock("../shared/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { LightweightDataTable } = await import("../test/LightweightDataTable");
  return { ...actual, DataTable: LightweightDataTable };
});

const emptyHealth = { generated_on: "2026-10-01", total_cost: "0.00", items: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.reportsApi.inventoryHealth).mockResolvedValue(emptyHealth);
  vi.mocked(catalog.reportsApi.monthlyPnl).mockResolvedValue({ items: [], total: {} });
  vi.mocked(catalog.reportsApi.commission).mockResolvedValue({ items: [], total: { order_count: 0, payable: "0", paid: "0", difference: "0" } });
  vi.mocked(catalog.reportsApi.dailyFunds).mockResolvedValue({ date: "2026-10-01", total: {}, items: [] });
  vi.mocked(catalog.reportsApi.financeDimensions).mockResolvedValue({ items: [], total_amount: "0", total_signed_amount: "0" });
  vi.mocked(catalog.reportsApi.businessPnl).mockResolvedValue({ items: [], total: {} });
  vi.mocked(catalog.reportsApi.orderProfit).mockResolvedValue({ items: [], total: { income: "0", direct_cost: "0", rebate: "0", net_profit: "0" } });
  vi.mocked(catalog.reportsApi.exportCsv).mockResolvedValue(new Blob(["csv"]));
  // 数据中心面板（同页挂载）：空池空单——本文件只关心报表 Tab，桩位兜底即可。
  vi.mocked(catalog.poolsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.poolsApi.balance).mockResolvedValue({
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

describe("ReportsPage：经营中心报表", () => {
  it("初始只加载当前激活的库存报表，不提前加载隐藏 Tab", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "库存 R1" });
    expect(vi.mocked(catalog.reportsApi.inventoryHealth)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(catalog.reportsApi.monthlyPnl)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.reportsApi.commission)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.reportsApi.dailyFunds)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.reportsApi.businessPnl)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.reportsApi.orderProfit)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.poolsApi.list)).not.toHaveBeenCalled();
  });

  it("七个 Tab 齐全（R1-R5 + 订单利润 + 数据中心）", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "库存 R1" });
    for (const label of ["库存 R1", "月度损益 R2", "提成对账 R3", "资金日报 R4", "业务损益 R5", "订单利润", "数据中心"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
  });

  it("数据中心 Tab：渲染资金统计与订单入口卡，点击入口卡跳业务中心", async () => {
    const onNavigate = vi.fn();
    renderLight(<ReportsPage onNavigate={onNavigate} />, { user: "admin" });
    await gotoTab("数据中心");
    expect(await screen.findByText("可用余额合计")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /订单总数/ }));
    expect(onNavigate).toHaveBeenCalledWith("business");
  });

  it("管理员可从导出工具条按日期范围 + 下拉勾选发起导出", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await ui.type(screen.getByLabelText("导出开始日期"), "2026-01-01");
    await ui.type(screen.getByLabelText("导出结束日期"), "2026-01-31");
    const selector = screen.getByText("选择导出报表").closest(".ant-select")!.querySelector(".ant-select-selector") as HTMLElement;
    await ui.click(selector);
    const listbox = await screen.findByRole("listbox");
    await ui.click(within(listbox).getByText("订单利润"));
    await ui.click(screen.getByRole("button", { name: /导出/ }));
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.exportCsv)).toHaveBeenCalledWith("order-profit", { from: "2026-01-01", to: "2026-01-31" }));
  });

  it("未勾选报表直接点导出 → 提示至少勾选一项", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: /导出/ }));
    expect(await screen.findByText("请至少勾选一项报表")).toBeInTheDocument();
    expect(vi.mocked(catalog.reportsApi.exportCsv)).not.toHaveBeenCalled();
  });
});
