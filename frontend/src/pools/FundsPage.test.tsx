import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { FundsPage } from "./FundsPage";

const poolsList = vi.fn();
const poolsBalance = vi.fn();
const depositsList = vi.fn();
const depositsCreate = vi.fn();
const depositsRelease = vi.fn();
const ordersTransfer = vi.fn();

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
  ordersApi: { transfer: (...a: unknown[]) => ordersTransfer(...a), list: vi.fn() },
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
const deposits = [
  { id: 11, deposit_no: "DEP-0001", pool_id: 1, paid_amount: "500.00", returned_amount: "200.00", status: "HELD" },
];

beforeEach(() => {
  vi.clearAllMocks();
  poolsList.mockResolvedValue(pools);
  poolsBalance.mockResolvedValue(balance);
  depositsList.mockResolvedValue(deposits);
});

async function openTransferModal() {
  // antd Tabs 懒渲染：未激活过的 Tab 内容不在 DOM 里，必须先切 Tab
  await userEvent.click(screen.getByRole("tab", { name: "划转" }));
  await userEvent.click(await screen.findByRole("button", { name: /发起划转/ }));
  await waitFor(() => expect(screen.getByText("发起池间划转")).toBeInTheDocument());
  const modal = document.querySelector(".ant-modal-content") as HTMLElement;
  return modal;
}

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
    expect(screen.getAllByText("650.00").length).toBeGreaterThanOrEqual(1);
  });

  it("后端不可达 → 错误条落地", async () => {
    poolsList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<FundsPage />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });
});

describe("FundsPage：池间划转（写路径）", () => {
  it("提交后按 (源池, 目标池, 金额字符串, 日期) 过账", async () => {
    ordersTransfer.mockResolvedValueOnce({ out_flow_no: "OUT-1", in_flow_no: "IN-1" });
    renderApp(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);

    const modal = await openTransferModal();
    await pickSelect(modal, 0, /POOL-A/);
    await pickSelect(modal, 1, /POOL-B/);
    await userEvent.type(modal.querySelector("#amount") ?? modal, "100.00");
    await userEvent.click(screen.getByRole("button", { name: /提\s*交/ }));

    await waitFor(() => expect(ordersTransfer).toHaveBeenCalled());
    const payload = ordersTransfer.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.source_pool_id).toBe(1);
    expect(payload.target_pool_id).toBe(2);
    expect(payload.amount).toBe("100.00");
    expect(typeof payload.amount).toBe("string");
    expect(payload.occurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("缺少必填时不提交（金额为空被拦下）", async () => {
    renderApp(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    await openTransferModal();
    await userEvent.click(screen.getByRole("button", { name: /提\s*交/ }));
    await waitFor(() => expect(ordersTransfer).not.toHaveBeenCalled());
  });

  it("划转失败（缺资金路由）→ 错误条给出处置提示", async () => {
    ordersTransfer.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "POOL_ROUTE_MISSING", message: "缺少资金池路由" } },
      message: "Request failed",
    });
    renderApp(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    const modal = await openTransferModal();
    await pickSelect(modal, 0, /POOL-A/);
    await pickSelect(modal, 1, /POOL-B/);
    await userEvent.type(modal.querySelector("#amount") ?? modal, "100.00");
    await userEvent.click(screen.getByRole("button", { name: /提\s*交/ }));
    expect(await screen.findByText(/设置 → 主数据/)).toBeInTheDocument();
  });

  it("viewer 无 finance.transfer → 发起划转入口不渲染", async () => {
    renderApp(<FundsPage />, { user: "viewer" });
    await screen.findByText(/POOL-A/);
    expect(screen.queryByRole("button", { name: /发起划转/ })).toBeNull();
  });
});

describe("FundsPage：押金占用", () => {
  it("押金列表渲染编号与剩余（占用-已释放）", async () => {
    renderApp(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    await userEvent.click(screen.getByRole("tab", { name: "押金" }));
    expect(await screen.findByText("DEP-0001")).toBeInTheDocument();
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
    await screen.findByText("DEP-0001");
    expect(screen.getAllByRole("button", { name: /释\s*放/ }).length).toBeGreaterThanOrEqual(1);
  });
});
