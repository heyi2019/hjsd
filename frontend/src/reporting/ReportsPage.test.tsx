import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { ReportsPage } from "./ReportsPage";

const inventoryHealth = vi.fn();
const monthlyPnl = vi.fn();
const commission = vi.fn();
const dailyFunds = vi.fn();
const businessPnl = vi.fn();
const orderProfit = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  reportsApi: {
    inventoryHealth: (...a: unknown[]) => inventoryHealth(...a),
    monthlyPnl: (...a: unknown[]) => monthlyPnl(...a),
    commission: (...a: unknown[]) => commission(...a),
    dailyFunds: (...a: unknown[]) => dailyFunds(...a),
    businessPnl: (...a: unknown[]) => businessPnl(...a),
    orderProfit: (...a: unknown[]) => orderProfit(...a),
  },
}));

const emptyHealth = { generated_on: "2026-10-01", total_cost: "0.00", items: [] };

beforeEach(() => {
  vi.clearAllMocks();
  inventoryHealth.mockResolvedValue(emptyHealth);
  monthlyPnl.mockResolvedValue({ items: [], total: {} });
  commission.mockResolvedValue({ items: [], total: { order_count: 0, payable: "0", paid: "0", difference: "0" } });
  dailyFunds.mockResolvedValue({ date: "2026-10-01", total: {}, items: [] });
  businessPnl.mockResolvedValue({ items: [], total: {} });
  orderProfit.mockResolvedValue({ items: [], total: { income: "0", direct_cost: "0", rebate: "0", net_profit: "0" } });
});

async function gotoTab(label: string) {
  await userEvent.click(screen.getByRole("tab", { name: label }));
}

describe("ReportsPage：经营中心报表", () => {
  it("六个报表 Tab 齐全（R1-R5 + 订单利润）", async () => {
    renderApp(<ReportsPage />, { user: "admin" });
    await screen.findByText("经营中心");
    for (const label of ["库存 R1", "月度损益 R2", "提成对账 R3", "资金日报 R4", "业务损益 R5", "订单利润"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
  });
});

describe("ReportsPage：各报表渲染与错误态", () => {
  it("R1 库存健康：渲染账号编号与买入金额", async () => {
    inventoryHealth.mockResolvedValueOnce({
      generated_on: "2026-10-01",
      total_cost: "100.00",
      items: [
        {
          account_no: "HJACC-0001",
          game_account: "acc-1",
          platform: "A",
          status: "IN_STOCK",
          buy_amount: "100.00",
          extra_cost: "10.00",
          total_cost: "110.00",
          holding_days: 5,
          risk_level: "LOW",
        },
      ],
    });
    renderApp(<ReportsPage />, { user: "admin" });
    await screen.findByText("HJACC-0001");
    expect(screen.getAllByText("100.00").length).toBeGreaterThanOrEqual(1);
  });

  it("R1 无数据时显示空态文案", async () => {
    renderApp(<ReportsPage />, { user: "admin" });
    expect(await screen.findByText("暂无在库账号")).toBeInTheDocument();
  });

  it("R1 后端不可达 → 错误条落地（不静默空表）", async () => {
    inventoryHealth.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<ReportsPage />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("R2 月度损益：渲染月份与销售收入", async () => {
    monthlyPnl.mockResolvedValueOnce({
      from: "2026-09",
      to: "2026-09",
      total: {},
      items: [
        {
          month: "2026-09",
          sales_income: "2000.00",
          account_direct_cost: "500.00",
          operating_expense: "100.00",
          rebate_net: "50.00",
          operating_profit: "1450.00",
        },
      ],
    });
    renderApp(<ReportsPage />, { user: "admin" });
    await gotoTab("月度损益 R2");
    expect(await screen.findByText("2026-09")).toBeInTheDocument();
    expect(screen.getAllByText("2,000.00").length).toBeGreaterThanOrEqual(1);
  });

  it("R5 业务损益：渲染业务与主营收入", async () => {
    businessPnl.mockResolvedValueOnce({
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
    renderApp(<ReportsPage />, { user: "admin" });
    await gotoTab("业务损益 R5");
    expect(await screen.findByText("HS")).toBeInTheDocument();
    expect(screen.getAllByText("800.00").length).toBeGreaterThanOrEqual(1);
  });

  it("订单利润：渲染订单号与净额", async () => {
    orderProfit.mockResolvedValueOnce({
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
    renderApp(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");
    expect(await screen.findByText("HS-2026-0010")).toBeInTheDocument();
    expect(screen.getAllByText("160.00").length).toBeGreaterThanOrEqual(1);
  });
});
