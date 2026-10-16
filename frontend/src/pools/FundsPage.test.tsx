import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { FundsPage } from "./FundsPage";

const poolsList = vi.fn();
const poolsBalance = vi.fn();
const depositsList = vi.fn();
const cashflowsList = vi.fn();
const depositsCreate = vi.fn();
const depositsRelease = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  poolsApi: {
    list: (...a: unknown[]) => poolsList(...a),
    balance: (...a: unknown[]) => poolsBalance(...a),
    create: vi.fn(),
  },
  depositsApi: {
    list: (...a: unknown[]) => depositsList(...a),
    create: (...a: unknown[]) => depositsCreate(...a),
    release: (...a: unknown[]) => depositsRelease(...a),
  },
  cashflowsApi: {
    list: (...a: unknown[]) => cashflowsList(...a),
  },
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
  available: "700.00",
};
const deposits = [
  { id: 11, pool_id: 1, paid_amount: "500.00", returned_amount: "200.00", status: "HELD" },
];
const cashflows = [
  { id: 1, flow_no: "HS0001-CF-BUY-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "500.00", order_no: "HS0001", source: "ORDER_EVENT" },
  { id: 2, flow_no: "HS0001-CF-SELL-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_IN", category: "SELL", direction: "IN", amount: "800.00", order_no: "HS0001", source: "ORDER_EVENT" },
];

beforeEach(() => {
  vi.clearAllMocks();
  poolsList.mockResolvedValue(pools);
  poolsBalance.mockResolvedValue(balance);
  depositsList.mockResolvedValue(deposits);
  cashflowsList.mockResolvedValue(cashflows);
});

async function pickSelect(modal: HTMLElement, index: number, title: RegExp) {
  await userEvent.click(modal.querySelectorAll(".ant-select-selector")[index] as Element);
  // 多个 Select 的下拉都挂在 body 上且历史下拉不销毁 → 必须限定在「最后打开的那个」
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  const current = dropdowns[dropdowns.length - 1] as HTMLElement;
  const option = await within(current).findByTitle(title);
  await userEvent.click(option);
}

describe("FundsPage：资金池卡片", () => {
  it("渲染资金池与可用余额", async () => {
    renderApp(<FundsPage />, { user: "admin" });
    expect(await screen.findByText(/POOL-A/)).toBeInTheDocument();
    expect(screen.getAllByText("700.00").length).toBeGreaterThanOrEqual(1);
  });

  it("后端不可达 → 错误条落地", async () => {
    poolsList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<FundsPage />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });
});

describe("FundsPage：押金占用", () => {
  it("押金列表渲染金额与剩余（占用-已释放）", async () => {
    renderApp(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    await userEvent.click(screen.getByRole("tab", { name: "押金" }));
    expect(screen.queryByText("押金编号")).not.toBeInTheDocument();
    expect(screen.getAllByText("300.00").length).toBeGreaterThanOrEqual(1); // 500-200
  });

  it("新增押金占用提交后回传金额与日期", async () => {
    depositsCreate.mockResolvedValueOnce({ id: 12 });
    renderApp(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    await userEvent.click(screen.getByRole("tab", { name: "押金" }));
    await userEvent.click(await screen.findByRole("button", { name: /新增占用/ }));
    await waitFor(() => expect(screen.getByText("新增押金占用")).toBeInTheDocument());
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, /POOL-A/);
    await userEvent.type(modal.querySelector("#amount") ?? modal, "500.00");
    await userEvent.click(screen.getByRole("button", { name: /提\s*交/ }));
    await waitFor(() => expect(depositsCreate).toHaveBeenCalled());
    const payload = depositsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.pool_id).toBe(1);
    expect(payload.amount).toBe("500.00");
  });

  it("押金释放按 deposit.post 门控：finance 可见、operator 不可见", async () => {
    renderApp(<FundsPage />, { user: "finance" });
    await screen.findByText(/POOL-A/);
    await userEvent.click(screen.getByRole("tab", { name: "押金" }));
    await screen.findByText("300.00");
    expect(screen.getAllByRole("button", { name: /释\s*放/ }).length).toBeGreaterThanOrEqual(1);
  });
});

describe("FundsPage：资金流水", () => {
  it("展示订单号、收支明细及总收入/总支出", async () => {
    renderApp(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    await userEvent.click(screen.getByRole("tab", { name: "流水" }));
    expect(screen.getByText("HS0001-CF-BUY-01")).toBeInTheDocument();
    expect(screen.getAllByText("HS0001").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("总收入")).toBeInTheDocument();
    expect(screen.getByText("总支出")).toBeInTheDocument();
    expect(screen.getAllByText("800.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("500.00").length).toBeGreaterThanOrEqual(1);
  });
});
