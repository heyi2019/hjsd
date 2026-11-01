import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { DataCenterPanel } from "./DataCenterPanel";
import { resolveMock } from "../test/mock-api";

import * as catalog from "../shared/api/catalog";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

/** 数据中心用例集：2026-10-13 从「工作台资金总览」原样迁入（内容未变，只换容器）。
 *  覆盖：资金池表格、金额/计数两种统计口径、错误条必达 UI、
 *  finance.read 门控、订单入口卡计数与跳转。 */

vi.mock("../shared/api/catalog")

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
const businessPnl = {
  total: {
    business_mode: null,
    business_type: null,
    order_count: 2,
    main_income: "1,000.00",
    main_cost: "200.00",
    main_profit: "800.00",
    settled_rebate: "0.00",
    uncollected_rebate: "0.00",
    full_income: "800.00",
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
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools);
  resolveMock(vi.mocked(catalog.poolsApi.balance), balance);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue(orders);
  vi.mocked(catalog.reportsApi.businessPnl).mockResolvedValue(businessPnl);
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

  it("统计卡包含利润，并使用金额口径展示", async () => {
    renderLight(<DataCenterPanel />, { user: "admin" });
    await screen.findByText("利润");
    const card = screen.getByText("利润").closest(".ui-stat");
    expect(card?.textContent).toContain("800.00");
  });

  it("后端不可达时显示错误条，不能静默显示「尚未配置资金池」", async () => {
    vi.mocked(catalog.poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<DataCenterPanel />, { user: "admin" });
    // 关键：错误必须落到 UI。空态仍在（数据确实为空），但错误条必须出现，
    // 否则「后端没起」与「真的没数据」在页面上无法区分。
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
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
    vi.mocked(catalog.ordersApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<DataCenterPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
    expect(await screen.findByText(/POOL-A/)).toBeInTheDocument();
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
    vi.mocked(catalog.ordersApi.list).mockResolvedValueOnce([
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
});
