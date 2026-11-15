import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DataCenterPanel } from "@/reporting/DataCenterPanel";
import { ordersApi } from "@/shared/api/orders.api";
import { cashflowsApi } from "@/shared/api/cashflows.api";
import { reportsApi } from "@/shared/api/reports.api";
import { stocksApi } from "@/shared/api/stocks.api";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");

const businessPnl = {
  total: {
    business_mode: null,
    business_type: null,
    order_count: 2,
    main_income: "1,000.00",
    main_cost: "200.00",
    main_profit: "800.00",
  },
  items: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ordersApi.summary).mockResolvedValue({ total_count: 2, completed_count: 1, active_count: 1 });
  vi.mocked(cashflowsApi.studioSummary).mockResolvedValue({ items: [], approved_income: "0.00", approved_expense: "0.00", approved_net: "0.00", count: 0 });
  vi.mocked(reportsApi.businessPnl).mockResolvedValue(businessPnl);
  vi.mocked(stocksApi.inventoryCostSummary).mockResolvedValue({ total_cost: "3,500.00" });
});

describe("DataCenterPanel：经营指标", () => {
  it("不重复展示资金中心的余额、押金、资金池数量和资金池明细", async () => {
    renderLight(<DataCenterPanel />, { user: "admin" });
    await screen.findByText("订单总数");
    expect(screen.queryByText("可用余额合计")).not.toBeInTheDocument();
    expect(screen.queryByText("押金占用")).not.toBeInTheDocument();
    expect(screen.queryByText("资金池数量")).not.toBeInTheDocument();
    expect(screen.queryByText("资金池概览")).not.toBeInTheDocument();
  });

  it("保留在途成本、利润和工作室支出", async () => {
    vi.mocked(cashflowsApi.studioSummary).mockResolvedValueOnce({
      items: [],
      approved_income: "100.00",
      approved_expense: "88.80",
      approved_net: "11.20",
      count: 2,
    });
    renderLight(<DataCenterPanel />, { user: "admin" });
    expect(await screen.findByText("在途成本", { selector: ".ui-stat__label" })).toBeInTheDocument();
    expect(screen.getByText("在途成本").closest(".ui-stat")?.textContent).toContain("3,500.00");
    expect(screen.getByText("利润", { selector: ".ui-stat__label" }).closest(".ui-stat")?.textContent).toContain("800.00");
    expect(screen.getByText("工作室支出", { selector: ".ui-stat__label" }).closest(".ui-stat")?.textContent).toContain("88.80");
  });

  it("日期范围只传给经营指标接口", async () => {
    const range = { params: { from: "2026-11-01", to: "2026-11-15" }, picker: null };
    renderLight(<DataCenterPanel range={range} />, { user: "admin" });
    await screen.findByText("订单总数");
    expect(vi.mocked(ordersApi.summary)).toHaveBeenLastCalledWith({ trade_date_from: "2026-11-01", trade_date_to: "2026-11-15" });
    expect(vi.mocked(reportsApi.businessPnl)).toHaveBeenLastCalledWith({ from: "2026-11-01", to: "2026-11-15" });
    expect(vi.mocked(cashflowsApi.studioSummary)).toHaveBeenLastCalledWith({ occurred_from: "2026-11-01", occurred_to: "2026-11-15" });
    expect(vi.mocked(stocksApi.inventoryCostSummary)).toHaveBeenLastCalledWith({ entry_date_from: "2026-11-01", entry_date_to: "2026-11-15" });
  });

  it("订单接口失败时显示错误并禁用订单入口", async () => {
    vi.mocked(ordersApi.summary).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    const onNavigate = vi.fn();
    renderLight(<DataCenterPanel onNavigate={onNavigate} />, { user: "admin" });
    const totalCard = await screen.findByRole("button", { name: /订单总数/ });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
    expect(totalCard).toHaveTextContent("不可用");
    expect(totalCard).toHaveAttribute("aria-disabled", "true");
    await userEvent.setup({ pointerEventsCheck: 0 }).click(totalCard);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("DataCenterPanel：订单入口", () => {
  it("展示订单总数和进行中数量并支持跳转", async () => {
    const onNavigate = vi.fn();
    renderLight(<DataCenterPanel onNavigate={onNavigate} />, { user: "admin" });
    const total = await screen.findByRole("button", { name: /订单总数/ });
    expect(total).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /进行中/ })).toHaveTextContent("1");
    await userEvent.setup({ pointerEventsCheck: 0 }).click(total);
    expect(onNavigate).toHaveBeenCalledWith("business", "ledger");
  });
});
