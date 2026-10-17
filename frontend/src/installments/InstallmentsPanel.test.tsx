import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { InstallmentsPanel } from "./InstallmentsPanel";

const installmentsList = vi.fn();
const schedules = vi.fn();
const dispositions = vi.fn();
const pay = vi.fn();
const deliver = vi.fn();
const recover = vi.fn();
const resale = vi.fn();
const ordersList = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  installmentsApi: {
    list: (...a: unknown[]) => installmentsList(...a),
    schedules: (...a: unknown[]) => schedules(...a),
    dispositions: (...a: unknown[]) => dispositions(...a),
    pay: (...a: unknown[]) => pay(...a),
    deliver: (...a: unknown[]) => deliver(...a),
    recover: (...a: unknown[]) => recover(...a),
    resale: (...a: unknown[]) => resale(...a),
  },
  ordersApi: { list: (...a: unknown[]) => ordersList(...a), create: vi.fn() },
}));

const installments = [
  {
    id: 1,
    inst_no: "HS0001-INS01",
    contract_type: "STOCK_SALE",
    order_id: 10,
    down_payment: "100.00",
    per_period: "50.00",
    periods: 4,
    paid_amount: "150.00",
    status: "ACTIVE",
  },
  {
    id: 2,
    inst_no: "DFQ0001-INS01",
    contract_type: "STOCK_SALE",
    order_id: 10,
    down_payment: "0.00",
    per_period: "100.00",
    periods: 2,
    paid_amount: "200.00",
    status: "DELIVERED",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  installmentsList.mockResolvedValue(installments);
  schedules.mockResolvedValue([
    { id: 1, period_no: 0, due_on: "2026-10-01", due_amount: "100.00", received_amount: "100.00", status: "PAID" },
  ]);
  dispositions.mockResolvedValue([]);
  ordersList.mockResolvedValue([{ id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" }]);
});

describe("InstallmentsPanel：分期合约", () => {
  it("渲染合约号并把 order_id 映射成订单号", async () => {
    renderApp(<InstallmentsPanel />, { user: "admin" });
    expect(await screen.findByText("HS0001-INS01")).toBeInTheDocument();
    expect(screen.getAllByText("HS-2026-0010").length).toBeGreaterThanOrEqual(1);
  });

  it("总应收 = 首付 + 每期 × 期数（前端只做展示，不参与登记）", async () => {
    renderApp(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    // 100 + 50*4 = 300.00
    expect(screen.getAllByText("300.00").length).toBeGreaterThanOrEqual(1);
    // 剩余 = 300 - 150 = 150.00
    expect(screen.getAllByText("150.00").length).toBeGreaterThanOrEqual(1);
  });

  it("统计卡：应收与已收为金额口径", async () => {
    renderApp(<InstallmentsPanel />, { user: "admin" });
    await screen.findAllByText("总应收");
    // 「总应收」同时是统计卡 label 与表头 → 只在统计卡容器里找
    const receivable = screen
      .getAllByText("总应收")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(receivable?.textContent).toContain("500.00"); // 300 + 200
    const paid = screen
      .getAllByText("已收合计")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(paid?.textContent).toContain("350.00"); // 150 + 200
  });

  it("已交付合约禁用「登记收款」，未结清合约禁用「换绑交付」", async () => {
    renderApp(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const payButtons = screen.getAllByRole("button", { name: /登记收款/ });
    const deliverButtons = screen.getAllByRole("button", { name: /换绑交付/ });
    expect((payButtons[0] as HTMLButtonElement).disabled).toBe(false); // ACTIVE
    expect((payButtons[1] as HTMLButtonElement).disabled).toBe(true); // DELIVERED
    expect(deliverButtons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true); // 都不是 SETTLED
  });

  it("SCHEDULED 合约已结清时「换绑交付」可点", async () => {
    installmentsList.mockResolvedValueOnce([{ ...installments[0], status: "SETTLED" }]);
    renderApp(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const deliverButtons = screen.getAllByRole("button", { name: /换绑交付/ });
    expect(deliverButtons.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("InstallmentsPanel：登记收款 / 换绑交付", () => {
  it("已有回收和转售记录时禁用重复处置", async () => {
    installmentsList.mockResolvedValueOnce([
      { ...installments[0], status: "OVERDUE" },
    ]);
    dispositions.mockResolvedValueOnce([
      { id: 1, installment_id: 1, account_id: 2, action: "RECOVER", occurred_on: "2026-10-12", note: "回收" },
      { id: 2, installment_id: 1, account_id: 2, action: "RESELL", occurred_on: "2026-10-13", note: "转售" },
    ]);
    renderApp(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    expect(screen.getByRole("button", { name: /登记回收/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /登记出售/ })).toBeNull();
  });

  it("登记收款提交后回传金额字符串与收款日期", async () => {
    pay.mockResolvedValueOnce({ id: 1 });
    renderApp(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    await userEvent.click(screen.getAllByRole("button", { name: /登记收款/ })[0] as Element);
    // 两行合约都有「登记收款」按钮 → 弹窗标题另找：直接等 Modal 出现
    await waitFor(() =>
      expect(document.querySelectorAll(".ant-modal-content").length).toBeGreaterThan(0),
    );
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await userEvent.type(modal.querySelector("#amount") as Element, "50.00");
    await userEvent.click(screen.getByRole("button", { name: /确认收款/ }));
    await waitFor(() => expect(pay).toHaveBeenCalled());
    const [id, payload] = pay.mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(1);
    expect(payload.amount).toBe("50.00");
    expect(typeof payload.amount).toBe("string");
    expect(payload.paid_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("换绑交付：SETTLED 合约可打开弹窗，必填缺失时不提交", async () => {
    installmentsList.mockResolvedValueOnce([{ ...installments[0], status: "SETTLED" }]);
    renderApp(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    await userEvent.click(screen.getAllByRole("button", { name: /换绑交付/ })[0] as Element);
    await waitFor(() =>
      expect(document.querySelectorAll(".ant-modal-content").length).toBeGreaterThan(0),
    );
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await userEvent.click(within(modal).getByRole("button", { name: /确认交付/ }));
    await waitFor(() => expect(deliver).not.toHaveBeenCalled());
  });

  it("viewer 无 order.event.post → 收款/交付入口全部不渲染", async () => {
    renderApp(<InstallmentsPanel />, { user: "viewer" });
    await screen.findByText("HS0001-INS01");
    expect(screen.queryByRole("button", { name: /登记收款/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /换绑交付/ })).toBeNull();
  });

  it("后端不可达 → 错误条落地", async () => {
    installmentsList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<InstallmentsPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });
});
