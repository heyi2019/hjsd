import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { InstallmentsPanel } from "./InstallmentsPanel";

import * as catalog from "../shared/api/catalog";
import { seedOrderFormFields } from "../test/formFieldsSeed";
vi.mock("../shared/api/catalog")

const installments = [
  {
    id: 1,
    inst_no: "HS0001-INS01",
    contract_type: "STOCK_SALE",
    order_id: 10,
    down_payment: "100.00",
    principal: "300.00",
    service_fee: "0.00",
    per_period_service_fee: "0.00",
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
    principal: "200.00",
    service_fee: "0.00",
    per_period_service_fee: "0.00",
    per_period: "100.00",
    periods: 2,
    paid_amount: "200.00",
    status: "DELIVERED",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.installmentsApi.list).mockResolvedValue(installments);
  vi.mocked(catalog.installmentsApi.schedules).mockResolvedValue([
    { id: 1, installment_id: 1, period_no: 0, due_on: "2026-10-01", due_amount: "100.00", received_amount: "100.00", status: "PAID" },
  ]);
  vi.mocked(catalog.installmentsApi.dispositions).mockResolvedValue([]);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([{ id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" }]);
});

describe("InstallmentsPanel：分期合约", () => {
  it("渲染合约号并把 order_id 映射成订单号", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    expect(await screen.findByText("HS0001-INS01")).toBeInTheDocument();
    expect(screen.getAllByText("HS-2026-0010").length).toBeGreaterThanOrEqual(1);
  });

  it("总应收 = 首付 + 每期 × 期数（前端只做展示，不参与登记）", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    // 100 + 50*4 = 300.00
    expect(screen.getAllByText("300.00").length).toBeGreaterThanOrEqual(1);
    // 剩余 = 300 - 150 = 150.00
    expect(screen.getAllByText("150.00").length).toBeGreaterThanOrEqual(1);
  });

  it("统计卡：应收与已收为金额口径", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
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
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const payButtons = screen.getAllByRole("button", { name: /登记收款/ });
    const deliverButtons = screen.getAllByRole("button", { name: /换绑交付/ });
    expect((payButtons[0] as HTMLButtonElement).disabled).toBe(false); // ACTIVE
    expect((payButtons[1] as HTMLButtonElement).disabled).toBe(true); // DELIVERED
    expect(deliverButtons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true); // 都不是 SETTLED
  });

  it("SCHEDULED 合约已结清时「换绑交付」可点", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValueOnce([{ ...installments[0], status: "SETTLED" }]);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const deliverButtons = screen.getAllByRole("button", { name: /换绑交付/ });
    expect(deliverButtons.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });
});
