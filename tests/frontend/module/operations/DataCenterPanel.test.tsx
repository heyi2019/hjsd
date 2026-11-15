import { countOngoingOrders } from "@/reporting/DataCenterPanel";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DataCenterPanel } from "@/reporting/DataCenterPanel";
import { resolveMock } from "@fixtures/mock-api";

import { ordersApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";
import { reportsApi } from "@/shared/api/reports.api";
import { stocksApi } from "@/shared/api/stocks.api";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

/** 数据中心用例集：2026-10-13 从「工作台资金总览」原样迁入（内容未变，只换容器）。
 *  覆盖：资金池表格、金额/计数两种统计口径、错误条必达 UI、
 *  finance.read 门控、订单入口卡计数与跳转。 */

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

const pools = [
  { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
  { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", ownership: "SELF", status: "ACTIVE" },
];
const balance = {
  income: "1000.00",
  expense: "200.00",
  cash_balance: "800.00",
  deposit_held: "100.00",
  available: "700.00",
};
const inventory = {
  items: [],
  count: 2,
  total_cost: "3,500.00",
};
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
/** 入口卡计数口径：订单总数=2、进行中=1（HS ACTIVE）。 */
const orders = [
  { id: 1, order_no: "HS-2026-0001", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" },
  { id: 2, order_no: "TH-2026-0002", order_type: "TH", capital_type: "PEER", trade_date: "2026-10-02", status: "COMPLETED" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(poolsApi.list).mockResolvedValue(pools);
  // 余额与汇总一次批量取回（服务端 Decimal 聚合），合计按两池同额计。
  resolveMock(vi.mocked(poolsApi.balances), {
    items: pools.map((pool) => ({ ...balance, pool_id: pool.id, pool_code: pool.code })),
    totals: { cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00", owned_cash_balance: "1600.00" },
  });
  vi.mocked(ordersApi.list).mockResolvedValue(orders);
  vi.mocked(reportsApi.businessPnl).mockResolvedValue(businessPnl);
  vi.mocked(stocksApi.inventory).mockResolvedValue(inventory);
});

describe("DataCenterPanel：资金总览", () => {
  it("渲染资金池编码与余额列（可用余额加粗）", async () => {
    renderLight(<DataCenterPanel />, { user: "admin" });
    expect(await screen.findByText(/POOL-A/)).toBeInTheDocument();
    expect(screen.getByText(/POOL-B/)).toBeInTheDocument();
    expect(screen.getAllByText("700.00").length).toBeGreaterThanOrEqual(1);
  });

  it("统计卡：可用余额合计按金额口径（千分位两位小数）", async () => {
    renderLight(<DataCenterPanel />, { user: "admin" });
    await screen.findByText("可用余额合计");
    const card = screen.getByText("可用余额合计").closest(".ui-stat");
    // 两个池各 700 → 1400.00
    expect(card?.textContent).toContain("1,400.00");
  });

  it("统计卡：资金池数量为计数口径（不出现小数）", async () => {
    renderLight(<DataCenterPanel />, { user: "admin" });
    await screen.findByText("资金池数量");
    const card = screen.getByText("资金池数量").closest(".ui-stat");
    expect(card?.textContent).toContain("2");
    expect(card?.textContent).not.toContain("2.00");
  });

  it("数据中心展示利润并保留押金占用指标", async () => {
    renderLight(<DataCenterPanel />, { user: "admin" });
    await screen.findByText("可用余额合计");
    expect(screen.getByText("利润", { selector: ".ui-stat__label" })).toBeInTheDocument();
    expect(screen.getByText("利润").closest(".ui-stat")?.textContent).toContain("800.00");
    expect(screen.getByText("押金占用", { selector: ".ui-stat__label" })).toBeInTheDocument();
  });

  it("统计卡展示库存账号占用的在途成本", async () => {
    renderLight(<DataCenterPanel />, { user: "admin" });
    await screen.findByText("在途成本");
    const card = screen.getByText("在途成本").closest(".ui-stat");
    expect(card?.textContent).toContain("3,500.00");
  });

  it("后端不可达时显示错误条，不能静默显示「尚未配置资金池」", async () => {
    vi.mocked(poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<DataCenterPanel />, { user: "admin" });
    // 关键：错误必须落到 UI。空态仍在（数据确实为空），但错误条必须出现，
    // 否则「后端没起」与「真的没数据」在页面上无法区分。
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("FE-227：数据中心主数据失败时统计不可用且快捷入口不可点击", async () => {
    vi.mocked(poolsApi.list).mockRejectedValueOnce(new Error("pools down"));
    const onNavigate = vi.fn();
    renderLight(<DataCenterPanel onNavigate={onNavigate} />, { user: "admin" });

    const totalCard = await screen.findByRole("button", { name: /订单总数/ });
    expect(totalCard).toHaveTextContent("不可用");
    expect(totalCard).toHaveAttribute("aria-disabled", "true");
    await ui.click(totalCard);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("资金池概览受 finance.read 门控：无权限角色看不到卡片", async () => {
    renderLight(<DataCenterPanel />, { user: "nobody" });
    await screen.findByText("订单总数");
    expect(screen.queryByText("资金池概览")).toBeNull();
  });

  it("有 finance.read 的角色（viewer）可见资金池概览", async () => {
    renderLight(<DataCenterPanel />, { user: "viewer" });
    await screen.findByText(/POOL-A/);
    expect(screen.getByText("资金池概览")).toBeInTheDocument();
  });

  it("订单接口失败不阻断资金总览：池数据仍在，错误条露出", async () => {
    vi.mocked(ordersApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<DataCenterPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
    expect(await screen.findByText(/POOL-A/)).toBeInTheDocument();
  });

  it("P1/FE-241：数据中心主数据失败时不显示零统计且禁用快捷入口", async () => {
    vi.mocked(poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "pools down" });
    const onNavigate = vi.fn();
    renderLight(<DataCenterPanel onNavigate={onNavigate} />, { user: "admin" });

    const totalCard = await screen.findByRole("button", { name: /订单总数/ });
    const activeCard = screen.getByRole("button", { name: /进行中/ });
    expect(totalCard).toHaveTextContent("不可用");
    expect(activeCard).toHaveTextContent("不可用");
    expect(totalCard).toHaveAttribute("aria-disabled", "true");
    expect(activeCard).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(totalCard);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByText("资金池数量").closest(".ui-stat")).toHaveTextContent("不可用");
  });
});

describe("DataCenterPanel：业务入口卡（2026-10-13 从工作台迁入）", () => {
  it("渲染订单统计入口卡：总数/进行中", async () => {
    renderLight(<DataCenterPanel />, { user: "admin" });
    await screen.findByText("订单总数");
    const total = screen.getByText("订单总数").closest(".ui-entry-card");
    expect(total?.textContent).toContain("2");
    expect(total?.textContent).not.toContain("2.00");
    const active = screen
      .getAllByText("进行中")
      .map((el) => el.closest(".ui-entry-card"))
      .find(Boolean);
    expect(active?.textContent).toContain("1");
    expect(screen.queryByText("提号未闭环")).toBeNull();
  });

  it("点击入口卡跳转业务中心（onNavigate 带 business）", async () => {
    const onNavigate = vi.fn();
    renderLight(<DataCenterPanel onNavigate={onNavigate} />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: /订单总数/ }));
    expect(onNavigate).toHaveBeenCalledWith("business", "ledger");
  });

  it("进行中统计包含分期订单，并从快捷卡进入订单台账", async () => {
    vi.mocked(ordersApi.list).mockResolvedValueOnce([
      ...orders,
      { id: 3, order_no: "TH-2026-0003", order_type: "TH", capital_type: "STOCK", trade_date: "2026-10-03", status: "INSTALLMENT" },
    ]);
    const onNavigate = vi.fn();
    renderLight(<DataCenterPanel onNavigate={onNavigate} />, { user: "admin" });
    const card = await screen.findByRole("button", { name: /进行中/ });
    expect(card).toHaveTextContent("2");
    await ui.click(card);
    expect(onNavigate).toHaveBeenCalledWith("business", "ledger");
  });

  it("P1/FE-149：数据中心进行中包含分期订单并跳转订单台账", async () => {
    expect(countOngoingOrders([{ status: "ACTIVE" }, { status: "INSTALLMENT" }, { status: "COMPLETED" }])).toBe(2);
    vi.mocked(poolsApi.list).mockResolvedValueOnce([]);
    // 数据中心改为一次批量取余额（含服务端汇总），空池时给空 items + 零合计。
    vi.mocked(poolsApi.balances).mockResolvedValueOnce({
      items: [],
      totals: { cash_balance: "0.00", available: "0.00", deposit_held: "0.00", owned_cash_balance: "0.00" },
    });
    vi.mocked(ordersApi.list).mockResolvedValueOnce([
      { id: 10, order_no: "HS-2026-0001", order_type: "HS", capital_type: "STOCK", trade_date: "2026-10-01", status: "ACTIVE" },
      { id: 11, order_no: "TH-2026-0002", order_type: "TH", capital_type: "STOCK", trade_date: "2026-10-02", status: "INSTALLMENT" },
      { id: 12, order_no: "DG-2026-0003", order_type: "DG", capital_type: "ZERO", trade_date: "2026-10-03", status: "COMPLETED" },
    ]);
    const onNavigate = vi.fn();
    renderLight(<DataCenterPanel onNavigate={onNavigate} />, { user: "admin" });
    const card = await screen.findByRole("button", { name: /进行中/ });
    expect(card).toHaveTextContent("2");
    await userEvent.setup({ pointerEventsCheck: 0 }).click(card);
    expect(onNavigate).toHaveBeenCalledWith("business", "ledger");
  });
});
