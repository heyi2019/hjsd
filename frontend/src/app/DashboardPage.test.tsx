import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { DashboardPage } from "./DashboardPage";

const poolsList = vi.fn();
const poolsBalance = vi.fn();
const qualityOverview = vi.fn();
const ordersList = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  poolsApi: {
    list: (...a: unknown[]) => poolsList(...a),
    balance: (...a: unknown[]) => poolsBalance(...a),
    create: vi.fn(),
  },
  qualityApi: { overview: (...a: unknown[]) => qualityOverview(...a) },
  ordersApi: { list: (...a: unknown[]) => ordersList(...a) },
  // 新建业务弹窗自加载的选项数据：工作台用例给空列表即可（弹窗自身用例在 CreateOrderModal.test.tsx）。
  orderTypesApi: { list: vi.fn().mockResolvedValue([]) },
  customersApi: { list: vi.fn().mockResolvedValue([]) },
  counterpartiesApi: { list: vi.fn().mockResolvedValue([]) },
  accountsApi: { list: vi.fn().mockResolvedValue([]) },
}));

const pools = [
  { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
  { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", ownership: "SELF", status: "ACTIVE" },
];
const balance = {
  income: "1000.00",
  expense: "200.00",
  transfer_in: "0.00",
  transfer_out: "0.00",
  cash_balance: "800.00",
  deposit_held: "100.00",
  th_advance: "50.00",
  available: "650.00",
};
/** 速览区计数口径：DRAFT/ACTIVE 计待处理；TH 且 ACTIVE 计提号未闭环。 */
const orders = [
  { id: 1, order_no: "HS-2026-0001", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" },
  { id: 2, order_no: "TH-2026-0002", order_type: "TH", capital_type: "PEER", trade_date: "2026-10-02", status: "COMPLETED" },
];

beforeEach(() => {
  vi.clearAllMocks();
  poolsList.mockResolvedValue(pools);
  poolsBalance.mockResolvedValue(balance);
  qualityOverview.mockResolvedValue({ items: [{ type: "X", open: 2 }, { type: "Y", open: 3 }] });
  ordersList.mockResolvedValue(orders);
});

describe("DashboardPage：资金总览", () => {
  it("渲染资金池编码与余额列（可用余额加粗）", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    expect(await screen.findByText(/POOL-A/)).toBeInTheDocument();
    expect(screen.getByText(/POOL-B/)).toBeInTheDocument();
    expect(screen.getAllByText("650.00").length).toBeGreaterThanOrEqual(1);
  });

  it("统计卡：可用余额合计按金额口径（千分位两位小数）", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await screen.findByText("可用余额合计");
    const card = screen.getByText("可用余额合计").closest(".ui-stat");
    // 两个池各 650 → 1300.00
    expect(card?.textContent).toContain("1,300.00");
  });

  it("统计卡：资金池数量为计数口径（不出现小数）", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await screen.findByText("资金池数量");
    const card = screen.getByText("资金池数量").closest(".ui-stat");
    expect(card?.textContent).toContain("2");
    expect(card?.textContent).not.toContain("2.00");
  });

  it("未闭环异常取 quality 概览的 open 求和", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await waitFor(() => {
      const card = screen.getByText("未闭环异常").closest(".ui-stat");
      expect(card?.textContent).toContain("5"); // 2 + 3
    });
  });

  it("quality 概览失败不阻断工作台，异常数回落 -", async () => {
    qualityOverview.mockRejectedValueOnce(new Error("boom"));
    renderApp(<DashboardPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    const card = screen.getByText("未闭环异常").closest(".ui-stat");
    expect(card?.textContent).toContain("-");
  });

  it("后端不可达时显示错误条，不能静默显示「尚未配置资金池」", async () => {
    poolsList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<DashboardPage />, { user: "admin" });
    // 关键：错误必须落到 UI。空态仍在（数据确实为空），但错误条必须出现，
    // 否则「后端没起」与「真的没数据」在页面上无法区分。
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("资金池概览受 finance.read 门控：无权限角色看不到卡片", async () => {
    renderApp(<DashboardPage />, { user: "nobody" });
    await waitFor(() => expect(screen.getByText("今日总览")).toBeInTheDocument());
    expect(screen.queryByText("资金池概览")).toBeNull();
  });

  it("有 finance.read 的角色（viewer）可见资金池概览", async () => {
    renderApp(<DashboardPage />, { user: "viewer" });
    await screen.findByText(/POOL-A/);
    expect(screen.getByText("资金池概览")).toBeInTheDocument();
  });
});

describe("DashboardPage：业务速览（2026-10-13 从业务中心迁入）", () => {
  it("admin 渲染四张入口卡：新建业务 + 三项订单计数", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    // 计数口径：订单总数=2、待处理=1（HS ACTIVE）、提号未闭环=0（TH 已 COMPLETED）
    await screen.findByText("订单总数");
    const total = screen.getByText("订单总数").closest(".ui-entry-card");
    expect(total?.textContent).toContain("2");
    expect(total?.textContent).not.toContain("2.00");
    expect(screen.getByText("待处理").closest(".ui-entry-card")?.textContent).toContain("1");
    expect(screen.getByText("提号未闭环").closest(".ui-entry-card")?.textContent).toContain("0");
    expect(screen.getByRole("button", { name: /新建业务/ })).toBeInTheDocument();
  });

  it("viewer 无 order.create → 看不到新建业务卡，统计卡仍在", async () => {
    renderApp(<DashboardPage />, { user: "viewer" });
    await screen.findByText("订单总数");
    expect(screen.queryByRole("button", { name: /新建业务/ })).toBeNull();
  });

  it("点击新建业务卡直接打开登记弹窗（不跳转页面）", async () => {
    renderApp(<DashboardPage />, { user: "admin" });
    await userEvent.click(await screen.findByRole("button", { name: /新建业务/ }));
    const modal = await screen.findByText("业务类型");
    expect(modal.closest(".ant-modal-content")).toBeTruthy();
  });

  it("点击统计卡跳转业务中心（onNavigate 带 business）", async () => {
    const onNavigate = vi.fn();
    renderApp(<DashboardPage onNavigate={onNavigate} />, { user: "admin" });
    await userEvent.click(await screen.findByRole("button", { name: /订单总数/ }));
    expect(onNavigate).toHaveBeenCalledWith("business");
  });

  it("订单接口失败不阻断资金总览：池数据仍在，错误条露出", async () => {
    ordersList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<DashboardPage />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
    expect(await screen.findByText(/POOL-A/)).toBeInTheDocument();
  });
});
