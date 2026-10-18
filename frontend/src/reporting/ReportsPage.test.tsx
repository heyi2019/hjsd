import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { ReportsPage } from "./ReportsPage";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

const inventoryHealth = vi.fn();
const monthlyPnl = vi.fn();
const commission = vi.fn();
const dailyFunds = vi.fn();
const financeDimensions = vi.fn();
const businessPnl = vi.fn();
const orderProfit = vi.fn();
const poolsList = vi.fn();
const poolsBalance = vi.fn();
const ordersList = vi.fn();
const exportCsv = vi.fn();

// jsdom 不执行真实下载跳转；屏蔽 anchor.click，避免导出测试留下 navigation 定时器拖住全量单测。
beforeAll(() => {
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

vi.mock("../shared/api/catalog", () => ({
  reportsApi: {
    inventoryHealth: (...a: unknown[]) => inventoryHealth(...a),
    monthlyPnl: (...a: unknown[]) => monthlyPnl(...a),
    commission: (...a: unknown[]) => commission(...a),
    dailyFunds: (...a: unknown[]) => dailyFunds(...a),
    financeDimensions: (...a: unknown[]) => financeDimensions(...a),
    businessPnl: (...a: unknown[]) => businessPnl(...a),
    orderProfit: (...a: unknown[]) => orderProfit(...a),
    exportCsv: (...a: unknown[]) => exportCsv(...a),
  },
  // 数据中心 Tab 与报表面板同页挂载（antd Tabs 不卸载非激活面板）：必须给齐它的
  // 取数桩，否则 poolsApi.list 等会在挂载 effect 里同步 TypeError 炸测试。
  poolsApi: {
    list: (...a: unknown[]) => poolsList(...a),
    balance: (...a: unknown[]) => poolsBalance(...a),
    create: vi.fn(),
  },
  ordersApi: { list: (...a: unknown[]) => ordersList(...a) },
  qualityApi: { summary: vi.fn().mockResolvedValue({ total: 0, by_severity: {}, by_code: {}, items: [] }), list: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
  notificationsApi: { list: vi.fn().mockResolvedValue({ items: [], total: 0, unread_total: 0 }), markRead: vi.fn(), syncOverdueRebates: vi.fn() },
  auditApi: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), actions: vi.fn() },
  attachmentsApi: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), create: vi.fn(), download: vi.fn(), remove: vi.fn() },
}));

vi.mock("../shared/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { LightweightDataTable } = await import("../test/LightweightDataTable");
  return { ...actual, DataTable: LightweightDataTable };
});

const emptyHealth = { generated_on: "2026-10-01", total_cost: "0.00", items: [] };

beforeEach(() => {
  vi.clearAllMocks();
  inventoryHealth.mockResolvedValue(emptyHealth);
  monthlyPnl.mockResolvedValue({ items: [], total: {} });
  commission.mockResolvedValue({ items: [], total: { order_count: 0, payable: "0", paid: "0", difference: "0" } });
  dailyFunds.mockResolvedValue({ date: "2026-10-01", total: {}, items: [] });
  financeDimensions.mockResolvedValue({ items: [], total_amount: "0", total_signed_amount: "0" });
  businessPnl.mockResolvedValue({ items: [], total: {} });
  orderProfit.mockResolvedValue({ items: [], total: { income: "0", direct_cost: "0", rebate: "0", net_profit: "0" } });
  exportCsv.mockResolvedValue(new Blob(["csv"]));
  // 数据中心面板（同页挂载）：空池空单——本文件只关心报表 Tab，桩位兜底即可。
  poolsList.mockResolvedValue([]);
  poolsBalance.mockResolvedValue({
    income: "0.00",
    expense: "0.00",
    cash_balance: "0.00",
    deposit_held: "0.00",
    available: "0.00",
  });
  ordersList.mockResolvedValue([]);
});

async function gotoTab(label: string) {
  await ui.click(screen.getByRole("tab", { name: label }));
}

describe("ReportsPage：经营中心报表", () => {
  it("初始只加载当前激活的库存报表，不提前加载隐藏 Tab", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "库存 R1" });
    expect(inventoryHealth).toHaveBeenCalledTimes(1);
    expect(monthlyPnl).not.toHaveBeenCalled();
    expect(commission).not.toHaveBeenCalled();
    expect(dailyFunds).not.toHaveBeenCalled();
    expect(businessPnl).not.toHaveBeenCalled();
    expect(orderProfit).not.toHaveBeenCalled();
    expect(poolsList).not.toHaveBeenCalled();
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
    await waitFor(() => expect(exportCsv).toHaveBeenCalledWith("order-profit", { from: "2026-01-01", to: "2026-01-31" }));
  });

  it("未勾选报表直接点导出 → 提示至少勾选一项", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: /导出/ }));
    expect(await screen.findByText("请至少勾选一项报表")).toBeInTheDocument();
    expect(exportCsv).not.toHaveBeenCalled();
  });
});
