import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { ReportsPage } from "./ReportsPage";
import { resolveMock, resolveMockOnce } from "../test/mock-api";

import * as catalog from "../shared/api/catalog";
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

vi.mock("../shared/api/catalog")

const emptyHealth = { generated_on: "2026-10-01", total_cost: "0.00", items: [] };

beforeEach(() => {
  vi.clearAllMocks();
  resolveMock(vi.mocked(catalog.reportsApi.inventoryHealth), emptyHealth);
  resolveMock(vi.mocked(catalog.reportsApi.monthlyPnl), { items: [], total: {} });
  resolveMock(vi.mocked(catalog.reportsApi.commission), { items: [], total: { order_count: 0, payable: "0", paid: "0", difference: "0" } });
  resolveMock(vi.mocked(catalog.reportsApi.dailyFunds), { date: "2026-10-01", total: {}, items: [] });
  resolveMock(vi.mocked(catalog.reportsApi.financeDimensions), { items: [], total_amount: "0", total_signed_amount: "0" });
  resolveMock(vi.mocked(catalog.reportsApi.businessPnl), { items: [], total: {} });
  resolveMock(vi.mocked(catalog.reportsApi.orderProfit), { items: [], total: { income: "0", direct_cost: "0", rebate: "0", net_profit: "0" } });
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

describe("ReportsPage：各报表渲染与错误态", () => {
  it("R1 库存健康：渲染账号编号与买入金额", async () => {
  resolveMockOnce(vi.mocked(catalog.reportsApi.inventoryHealth), {
      generated_on: "2026-10-01",
      total_cost: "100.00",
      items: [
        {
          account_id: 1,
          game_account: "acc-1",
          platform: "A",
          status: "IN_STOCK",
          buy_amount: "100.00",
          extra_cost: "10.00",
          total_cost: "110.00",
          holding_days: 5,
        },
      ],
    });
    renderLight(<ReportsPage />, { user: "admin" });
    await screen.findByText("acc-1");
    expect(screen.getAllByText("100.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("5天")).toBeInTheDocument();
  });

  it("R1 无数据时显示空态文案", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    expect(await screen.findByText("暂无在库账号")).toBeInTheDocument();
  });

  it("R1 后端不可达 → 错误条落地（不静默空表）", async () => {
    vi.mocked(catalog.reportsApi.inventoryHealth).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<ReportsPage />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

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
          settled_rebate: "20.00",
          uncollected_rebate: "10.00",
          full_income: "820.00",
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
});
