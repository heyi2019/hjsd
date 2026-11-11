import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { ReportsPage } from "@/reporting/ReportsPage";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";

import * as catalog from "@/shared/api/catalog";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

// jsdom 不执行真实下载跳转；屏蔽 anchor.click，避免导出测试留下 navigation 定时器拖住全量单测。
beforeAll(() => {
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

vi.mock("@/shared/api/catalog")

beforeEach(() => {
  vi.clearAllMocks();
  resolveMock(vi.mocked(catalog.reportsApi.monthlyPnl), { items: [], total: {} });
  resolveMock(vi.mocked(catalog.reportsApi.commission), { items: [], total: { order_count: 0, payable: "0", paid: "0", difference: "0" } });
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(catalog.reportsApi.dailyFunds), { date: "2026-10-01", total: {}, items: [] });
  resolveMock(vi.mocked(catalog.reportsApi.financeDimensions), { items: [], total_amount: "0", total_signed_amount: "0" });
  resolveMock(vi.mocked(catalog.reportsApi.businessPnl), { items: [], total: {} });
  resolveMock(vi.mocked(catalog.reportsApi.orderProfit), { items: [], total: { income: "0", direct_cost: "0", rebate: "0", net_profit: "0" } });
  resolveMock(vi.mocked(catalog.reportsApi.exportCsv), new Blob(["csv"]));
  // 数据中心面板（同页挂载）：空池空单——本文件只关心报表 Tab，桩位兜底即可。
  vi.mocked(catalog.poolsApi.list).mockResolvedValue([]);
  // 空池 → 批量余额返回空 items 与零汇总（服务端聚合）。
  resolveMock(vi.mocked(catalog.poolsApi.balances), {
    items: [],
    totals: { cash_balance: "0.00", available: "0.00", deposit_held: "0.00", owned_cash_balance: "0.00" },
  });
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([]);
});

async function gotoTab(label: string) {
  await ui.click(screen.getByRole("tab", { name: label }));
}

describe("ReportsPage：各报表渲染与错误态", () => {
  it("R2 月度损益：渲染月份与销售收入", async () => {
    resolveMockOnce(vi.mocked(catalog.reportsApi.monthlyPnl), {
      from: "2026-09",
      to: "2026-09",
      total: {},
      items: [
        {
          month: "2026-09",
          sales_income: "2000.00",
          account_direct_cost: "500.00",
          operating_expense: "100.00",
          rebate_income: "50.00",
          operating_profit: "1450.00",
        },
      ],
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("月度损益 R2");
    expect(await screen.findByText("2026-09")).toBeInTheDocument();
    expect(screen.getAllByText("2,000.00").length).toBeGreaterThanOrEqual(1);
  });

  it("R5 业务损益：渲染业务与主营收入", async () => {
    resolveMock(vi.mocked(catalog.reportsApi.businessPnl), {
      items: [
        {
          order_type: "HS",
          main_income: "800.00",
          main_cost: "300.00",
          main_profit: "500.00",
        },
      ],
      total: {},
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("业务损益 R5");
    expect(await screen.findByText(/HS/)).toBeInTheDocument();
    expect(screen.getAllByText("800.00").length).toBeGreaterThanOrEqual(1);
  });

  it("订单利润：渲染订单号与净额", async () => {
    resolveMockOnce(vi.mocked(catalog.reportsApi.orderProfit), {
      from: null,
      to: null,
      total: { income: "0", direct_cost: "0", rebate: "0", net_profit: "0" },
      items: [
        {
          order_no: "HS-2026-0010",
          order_type: "HS",
          income: "600.00",
          buy_amount: "400.00",
          direct_cost: "50.00",
          rebate: "10.00",
          net_profit: "160.00",
        },
      ],
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");
    expect(await screen.findByText("HS-2026-0010")).toBeInTheDocument();
    expect(screen.getAllByText("160.00").length).toBeGreaterThanOrEqual(1);
  });

  it("订单利润：单独展示账号采购成本", async () => {
    resolveMockOnce(vi.mocked(catalog.reportsApi.orderProfit), {
      from: null,
      to: null,
      total: { income: "600.00", buy_amount: "400.00", direct_cost: "50.00", rebate: "10.00", net_profit: "160.00" },
      items: [{
        order_no: "HS-2026-0011",
        order_type: "HS",
        income: "600.00",
        buy_amount: "400.00",
        direct_cost: "50.00",
        rebate: "10.00",
        net_profit: "160.00",
      }],
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");

    expect(await screen.findByText("HS-2026-0011")).toBeInTheDocument();
    expect(screen.getAllByText("账号采购成本").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("400.00").length).toBeGreaterThanOrEqual(1);
  });
  // —— P0/P1 Round 2026-11-01 回归桶归并（原 P0P1Round20261101.test.tsx）——

  it("P1/FE-169：订单利润展示采购成本并给出可复算口径", async () => {
    vi.mocked(catalog.reportsApi.orderProfit).mockResolvedValueOnce({
      items: [{
        order_id: 11,
        order_no: "HS-2026-0011",
        order_type: "HS",
        trade_date: "2026-11-01",
        status: "COMPLETED",
        income: "600.00",
        buy_amount: "400.00",
        direct_cost: "50.00",
        rebate: "10.00",
        net_profit: "160.00",
      }],
      total: { income: "600.00", buy_amount: "400.00", direct_cost: "50.00", rebate: "10.00", net_profit: "160.00" },
    } as never);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ReportsPage />, { user: "admin" });
    await user.click(await screen.findByRole("tab", { name: /订单利润/ }));

    expect(await screen.findByText("HS-2026-0011")).toBeInTheDocument();
    expect(screen.getAllByText("账号采购成本").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/净利 = 所有收入 − 所有支出/)).toBeInTheDocument();
    expect(screen.getAllByText("400.00").length).toBeGreaterThanOrEqual(1);
  });
});
