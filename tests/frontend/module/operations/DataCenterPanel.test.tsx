import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DataCenterPanel } from "@/reporting/DataCenterPanel";
import { ReportsActiveContext } from "@/reporting/reports/shared";
import { reportsApi } from "@/shared/api/reports.api";
import { dataCenterSummary } from "@fixtures/api-responses";

vi.mock("@/shared/api/reports.api");

const summary = dataCenterSummary({
  order_count: 2,
  active_order_count: 1,
  sold_cost: "100.00",
  in_transit_cost: "70.00",
  deposit_held: "50.00",
  studio_cost: "30.00",
  account_sale_profit: "60.00",
  studio_other_income: "20.00",
  profit: "80.00",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reportsApi.dataCenter).mockResolvedValue(summary);
});

describe("DataCenterPanel：经营指标", () => {
  it("只读取一次数据中心汇总", async () => {
    let resolveDataCenter: (value: typeof summary) => void = () => undefined;
    vi.mocked(reportsApi.dataCenter).mockReturnValue(new Promise((resolve) => { resolveDataCenter = resolve; }));

    renderLight(<DataCenterPanel />, { user: "admin" });
    expect(vi.mocked(reportsApi.dataCenter)).toHaveBeenCalledTimes(1);

    resolveDataCenter(summary);
    expect(await screen.findByText("售出成本", { selector: ".ui-stat__label" })).toBeInTheDocument();
  });

  it("不重复展示资金中心的余额、资金池数量和资金池明细", async () => {
    renderLight(<DataCenterPanel />, { user: "admin" });
    await screen.findByText("订单总数");
    expect(screen.queryByText("可用余额合计")).not.toBeInTheDocument();
    expect(screen.queryByText("资金池数量")).not.toBeInTheDocument();
    expect(screen.queryByText("资金池概览")).not.toBeInTheDocument();
  });

  it("展示三类成本、利润构成和利润合计", async () => {
    renderLight(<DataCenterPanel />, { user: "admin" });
    expect(await screen.findByText("售出成本", { selector: ".ui-stat__label" })).toBeInTheDocument();
    expect(screen.getByText("售出成本").closest(".ui-stat")?.textContent).toContain("100.00");
    expect(screen.getByText("在途成本").closest(".ui-stat")?.textContent).toContain("70.00");
    expect(screen.getByText("押金占用").closest(".ui-stat")?.textContent).toContain("50.00");
    expect(screen.getByText("工作室成本").closest(".ui-stat")?.textContent).toContain("30.00");
    expect(screen.getByText("账号售出利润").closest(".ui-stat")?.textContent).toContain("60.00");
    expect(screen.getByText("工作室其他收入").closest(".ui-stat")?.textContent).toContain("20.00");
    expect(screen.getByText("利润").closest(".ui-stat")?.textContent).toContain("80.00");
  });

  it("日期范围只传给经营指标接口", async () => {
    const range = { params: { from: "2026-11-01", to: "2026-11-15" }, picker: null };
    renderLight(<DataCenterPanel range={range} />, { user: "admin" });
    await screen.findByText("订单总数");
    expect(vi.mocked(reportsApi.dataCenter)).toHaveBeenLastCalledWith({ from: "2026-11-01", to: "2026-11-15" });
  });

  it("隐藏期间不请求，重新激活后重新读取经营指标", async () => {
    const { rerender } = renderLight(
      <ReportsActiveContext.Provider value={false}>
        <DataCenterPanel />
      </ReportsActiveContext.Provider>,
      { user: "admin" },
    );

    expect(vi.mocked(reportsApi.dataCenter)).not.toHaveBeenCalled();

    rerender(
      <ReportsActiveContext.Provider value>
        <DataCenterPanel />
      </ReportsActiveContext.Provider>,
    );

    await waitFor(() => {
      expect(vi.mocked(reportsApi.dataCenter)).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("售出成本", { selector: ".ui-stat__label" })).toBeInTheDocument();
  });

  it("订单接口失败时显示错误并禁用订单入口", async () => {
    vi.mocked(reportsApi.dataCenter).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
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
