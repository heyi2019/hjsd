import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { ReportsPage } from "@/reporting/ReportsPage";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";
import { reportResponse } from "@fixtures/api-responses";

import { ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { reportsApi } from "@/shared/api/reports.api";
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

beforeEach(() => {
  vi.clearAllMocks();
  resolveMock(vi.mocked(reportsApi.monthlyPnl), reportResponse([], {}));
    resolveMock(vi.mocked(reportsApi.commission), { order_groups: [], total: { order_count: 0, profit_base: "0" } });
  vi.mocked(employeesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(reportsApi.businessPnl), reportResponse([], {}));
  resolveMock(vi.mocked(reportsApi.orderProfit), reportResponse([], { income: "0", cost: "0", rebate: "0", net_profit: "0" }));
  resolveMock(vi.mocked(reportsApi.exportCsv), new Blob(["csv"]));
  // 数据中心面板（同页挂载）：空池空单——本文件只关心报表 Tab，桩位兜底即可。
  vi.mocked(poolsApi.list).mockResolvedValue([]);
  // 空池 → 批量余额返回空 items 与零汇总（服务端聚合）。
  resolveMock(vi.mocked(poolsApi.balances), {
    items: [],
    totals: { pool_count: 0, cash_balance: "0.00", available: "0.00", deposit_held: "0.00", owned_cash_balance: "0.00" },
  });
});

async function gotoTab(label: string) {
  await ui.click(screen.getByRole("tab", { name: label }));
}

describe("ReportsPage：各报表渲染与错误态", () => {
  it("经营损益：同时渲染月度趋势与业务拆分", async () => {
    resolveMockOnce(vi.mocked(reportsApi.monthlyPnl), {
      from: "2026-09",
      to: "2026-09",
      total: {},
      items: [
        {
          month: "2026-09",
          sales_income: "2000.00",
          cost: "500.00",
          operating_expense: "100.00",
          rebate_income: "50.00",
          operating_profit: "1450.00",
        },
      ],
    });
    resolveMock(vi.mocked(reportsApi.businessPnl), {
      items: [
        {
          order_type: "HS",
          main_income: "800.00",
          cost: "300.00",
          main_profit: "500.00",
        },
      ],
      total: {},
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("经营损益");
    expect(await screen.findByText("2026-09")).toBeInTheDocument();
    expect(screen.getAllByText("2,000.00").length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText(/HS/)).toBeInTheDocument();
    expect(screen.getAllByText("800.00").length).toBeGreaterThanOrEqual(1);
  });

  it("订单利润：渲染订单号与净额", async () => {
    resolveMockOnce(vi.mocked(reportsApi.orderProfit), {
      from: null,
      to: null,
      total: { income: "0", cost: "0", rebate: "0", net_profit: "0" },
      items: [
        {
          order_no: "HS-2026-0010",
          order_type: "HS",
          income: "600.00",
          cost: "450.00",
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

  it("P1/FE-169：订单利润只展示统一成本口径且不展示旧口径说明", async () => {
    vi.mocked(reportsApi.orderProfit).mockResolvedValueOnce({
      items: [{
        order_id: 11,
        order_no: "HS-2026-0011",
        order_type: "HS",
        trade_date: "2026-11-01",
        status: "COMPLETED",
        income: "600.00",
        cost: "450.00",
        rebate: "10.00",
        net_profit: "160.00",
      }],
      total: { income: "600.00", cost: "450.00", rebate: "10.00", net_profit: "160.00" },
    } as never);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ReportsPage />, { user: "admin" });
    await user.click(await screen.findByRole("tab", { name: /订单利润/ }));

    expect(await screen.findByText("HS-2026-0011")).toBeInTheDocument();
    expect(screen.getAllByText("成本").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("账号采购成本")).not.toBeInTheDocument();
    expect(screen.queryByText("直接成本")).not.toBeInTheDocument();
    expect(screen.queryByText(/净利 = 所有收入 − 所有支出/)).not.toBeInTheDocument();
    expect(screen.getAllByText("450.00").length).toBeGreaterThanOrEqual(1);
  });
});
