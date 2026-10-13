import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { DataCenterPanel } from "./DataCenterPanel";

/** 数据中心用例集：2026-10-13 从「工作台资金总览」原样迁入（内容未变，只换容器）。
 *  覆盖：资金池表格、金额/计数两种统计口径、错误条必达 UI、
 *  finance.read 门控、订单入口卡计数与跳转。 */
const poolsList = vi.fn();
const poolsBalance = vi.fn();
const ordersList = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  poolsApi: {
    list: (...a: unknown[]) => poolsList(...a),
    balance: (...a: unknown[]) => poolsBalance(...a),
    create: vi.fn(),
  },
  ordersApi: { list: (...a: unknown[]) => ordersList(...a) },
}));

const pools = [
  { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
  { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", ownership: "SELF", status: "ACTIVE" },
];
const balance = {
  income: "1000.00",
  expense: "200.00",
  cash_balance: "800.00",
  deposit_held: "100.00",
  th_advance: "50.00",
  available: "650.00",
};
/** 入口卡计数口径：订单总数=2、待处理=1（HS ACTIVE）、提号未闭环=0（TH 已 COMPLETED）。 */
const orders = [
  { id: 1, order_no: "HS-2026-0001", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" },
  { id: 2, order_no: "TH-2026-0002", order_type: "TH", capital_type: "PEER", trade_date: "2026-10-02", status: "COMPLETED" },
];

beforeEach(() => {
  vi.clearAllMocks();
  poolsList.mockResolvedValue(pools);
  poolsBalance.mockResolvedValue(balance);
  ordersList.mockResolvedValue(orders);
});

describe("DataCenterPanel：资金总览", () => {
  it("渲染资金池编码与余额列（可用余额加粗）", async () => {
    renderApp(<DataCenterPanel />, { user: "admin" });
    expect(await screen.findByText(/POOL-A/)).toBeInTheDocument();
    expect(screen.getByText(/POOL-B/)).toBeInTheDocument();
    expect(screen.getAllByText("650.00").length).toBeGreaterThanOrEqual(1);
  });

  it("统计卡：可用余额合计按金额口径（千分位两位小数）", async () => {
    renderApp(<DataCenterPanel />, { user: "admin" });
    await screen.findByText("可用余额合计");
    const card = screen.getByText("可用余额合计").closest(".ui-stat");
    // 两个池各 650 → 1300.00
    expect(card?.textContent).toContain("1,300.00");
  });

  it("统计卡：资金池数量为计数口径（不出现小数）", async () => {
    renderApp(<DataCenterPanel />, { user: "admin" });
    await screen.findByText("资金池数量");
    const card = screen.getByText("资金池数量").closest(".ui-stat");
    expect(card?.textContent).toContain("2");
    expect(card?.textContent).not.toContain("2.00");
  });

  it("后端不可达时显示错误条，不能静默显示「尚未配置资金池」", async () => {
    poolsList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<DataCenterPanel />, { user: "admin" });
    // 关键：错误必须落到 UI。空态仍在（数据确实为空），但错误条必须出现，
    // 否则「后端没起」与「真的没数据」在页面上无法区分。
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("资金池概览受 finance.read 门控：无权限角色看不到卡片", async () => {
    renderApp(<DataCenterPanel />, { user: "nobody" });
    await screen.findByText("订单总数");
    expect(screen.queryByText("资金池概览")).toBeNull();
  });

  it("有 finance.read 的角色（viewer）可见资金池概览", async () => {
    renderApp(<DataCenterPanel />, { user: "viewer" });
    await screen.findByText(/POOL-A/);
    expect(screen.getByText("资金池概览")).toBeInTheDocument();
  });

  it("订单接口失败不阻断资金总览：池数据仍在，错误条露出", async () => {
    ordersList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<DataCenterPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
    expect(await screen.findByText(/POOL-A/)).toBeInTheDocument();
  });
});

describe("DataCenterPanel：业务入口卡（2026-10-13 从工作台迁入）", () => {
  it("渲染三张订单统计入口卡：总数/待处理/提号未闭环", async () => {
    renderApp(<DataCenterPanel />, { user: "admin" });
    await screen.findByText("订单总数");
    const total = screen.getByText("订单总数").closest(".ui-entry-card");
    expect(total?.textContent).toContain("2");
    expect(total?.textContent).not.toContain("2.00");
    expect(screen.getByText("待处理").closest(".ui-entry-card")?.textContent).toContain("1");
    expect(screen.getByText("提号未闭环").closest(".ui-entry-card")?.textContent).toContain("0");
  });

  it("点击入口卡跳转业务中心（onNavigate 带 business）", async () => {
    const onNavigate = vi.fn();
    renderApp(<DataCenterPanel onNavigate={onNavigate} />, { user: "admin" });
    await userEvent.click(await screen.findByRole("button", { name: /订单总数/ }));
    expect(onNavigate).toHaveBeenCalledWith("business");
  });
});
