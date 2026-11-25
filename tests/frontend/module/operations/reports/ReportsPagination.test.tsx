import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { OrderProfit } from "@/operations/reports/OrderProfitReport";
import { Commission } from "@/operations/reports/CommissionReport";
import { reportsApi } from "@/shared/api/reports.api";
import { employeesApi } from "@/shared/api/org.api";

vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/options.api");

beforeEach(() => {
  vi.mocked(employeesApi.list).mockResolvedValue([]);
});

describe("经营报表服务端分页", () => {
  it("订单利润翻页和改变时序时请求对应数据，合计保持全范围", async () => {
    vi.mocked(reportsApi.orderProfit).mockImplementation(async (params) => ({
      count: 11,
      total: { income: "1100", cost: "550", rebate: "0", net_profit: "550" },
      items: [{ order_id: params?.offset === 10 ? 11 : 1, order_no: params?.offset === 10 ? "HS-PAGE2" : "HS-PAGE1", order_type: "HS", trade_date: "2026-10-04", status: "ACTIVE", income: "100", cost: "50", rebate: "0", net_profit: "50" }],
    }));
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    const { container } = renderLight(<OrderProfit range={{ params: {}, picker: null }} />, { user: "admin" });
    expect(await screen.findByText("HS-PAGE1")).toBeInTheDocument();
    expect(reportsApi.orderProfit).toHaveBeenLastCalledWith({ limit: 10, offset: 0, sort_desc: true });
    await ui.click(container.querySelector(".ant-pagination-next")!);
    expect(await screen.findByText("HS-PAGE2")).toBeInTheDocument();
    expect(reportsApi.orderProfit).toHaveBeenLastCalledWith({ limit: 10, offset: 10, sort_desc: true });
    expect(screen.getAllByText("550.00").length).toBeGreaterThan(0);
    await ui.click(screen.getByRole("button", { name: "最旧在前" }));
    await waitFor(() => expect(reportsApi.orderProfit).toHaveBeenLastCalledWith({ limit: 10, offset: 0, sort_desc: false }));
  });

  it("分润对账翻页只请求当前页，切换时序回到第一页", async () => {
    vi.mocked(reportsApi.commission).mockImplementation(async (params) => ({
      total: { order_count: 11, profit_base: "550" }, people: [],
      order_groups: [{ order_id: params?.offset === 10 ? 11 : 1, order_no: params?.offset === 10 ? "HS-COMM2" : "HS-COMM1", inventory_date: "2026-10-04", outbound_date: null, profit_base: "50", personnel_profit_base: "50", orders: [] }],
    }));
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    const { container } = renderLight(<Commission range={{ params: {}, picker: null }} />, { user: "admin" });
    expect(await screen.findByText("HS-COMM1")).toBeInTheDocument();
    expect(reportsApi.commission).toHaveBeenLastCalledWith({ all_people: true, limit: 10, offset: 0, sort_desc: true });
    await ui.click(container.querySelector(".ant-pagination-next")!);
    expect(await screen.findByText("HS-COMM2")).toBeInTheDocument();
    expect(reportsApi.commission).toHaveBeenLastCalledWith({ all_people: true, limit: 10, offset: 10, sort_desc: true });
    await ui.click(screen.getByRole("button", { name: "最旧在前" }));
    await waitFor(() => expect(reportsApi.commission).toHaveBeenLastCalledWith({ all_people: true, limit: 10, offset: 0, sort_desc: false }));
  });
});
