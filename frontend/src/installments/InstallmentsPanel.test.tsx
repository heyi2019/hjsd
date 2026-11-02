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
    total_receivable: "300.00",
    remaining_receivable: "150.00",
    status: "ACTIVE",
  },
  {
    id: 2,
    inst_no: "HS0002-INS01",
    contract_type: "STOCK_SALE",
    order_id: 10,
    down_payment: "0.00",
    principal: "200.00",
    service_fee: "0.00",
    per_period_service_fee: "0.00",
    per_period: "100.00",
    periods: 2,
    paid_amount: "200.00",
    total_receivable: "200.00",
    remaining_receivable: "0.00",
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
  // 合计由服务端下发（Decimal 聚合）；「300+200」这类算术的契约在
  // backend tests/v1/test_installment_totals.py，前端只验展示。
  vi.mocked(catalog.installmentsApi.totals).mockResolvedValue({
    total_receivable: "500.00",
    total_paid: "350.00",
    total_remaining: "150.00",
  });
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([{ id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" }]);
});

describe("InstallmentsPanel：分期合约", () => {
  it("只展示分期出售，不展示代分期/提号分期/代挂分期", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    expect(await screen.findByText("HS0001-INS01")).toBeInTheDocument();
    // 代分期（DFQ）下线后本面板专营库存分期出售（contractType=STOCK_SALE），
    // 不再有分期类型切换页签，故断言「无任何 tab」而非「选中分期出售 tab」。
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    for (const name of ["代分期", "提号分期", "代挂分期"]) {
      expect(screen.queryByText(name)).toBeNull();
    }
  });

  it("渲染合约号并把 order_id 映射成订单号", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    expect(await screen.findByText("HS0001-INS01")).toBeInTheDocument();
    expect(screen.getAllByText("HS-2026-0010").length).toBeGreaterThanOrEqual(1);
  });

  it("提供分期合约日期区间筛选", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });

    await screen.findByText("HS0001-INS01");
    expect(screen.getByPlaceholderText("开始日期")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("结束日期")).toBeInTheDocument();
  });

  it("坏账列使用列表配置键参与排序", async () => {
    vi.mocked(catalog.listColumnsApi.all).mockResolvedValueOnce([{
      code: "INSTALLMENT",
      label: "分期与回款",
      columns: [
        { key: "bad_debt", label: "坏账", locked: false, is_visible: true, sort_order: 0 },
        { key: "inst_no", label: "合约号", locked: false, is_visible: true, sort_order: 10 },
      ],
    }]);

    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const headers = Array.from(document.querySelectorAll(".ant-table-thead tr:first-child th"))
      .map((header) => header.textContent?.trim())
      .filter(Boolean);
    expect(headers[0]).toBe("坏账");
  });

  it("总应收 = 首付 + 每期 × 期数（前端只做展示，不参与登记）", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    // 100 + 50*4 = 300.00
    expect(screen.getAllByText("300.00").length).toBeGreaterThanOrEqual(1);
    // 剩余 = 300 - 150 = 150.00
    expect(screen.getAllByText("150.00").length).toBeGreaterThanOrEqual(1);
  });

  it("统计卡：应收与已收取服务端合计（金额口径）", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findAllByText("总应收");
    // 「总应收」同时是统计卡 label 与表头 → 只在统计卡容器里找
    const receivable = screen
      .getAllByText("总应收")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(receivable?.textContent).toContain("500.00");
    const paid = screen
      .getAllByText("已收合计")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(paid?.textContent).toContain("350.00");
  });

  it("合计取服务端，不与当页明细相加（明细只回当前区间）", async () => {
    // 故意让服务端合计与两条明细之和（500 / 350）不同：卡片不得自己 reduce。
    vi.mocked(catalog.installmentsApi.totals).mockResolvedValue({
      total_receivable: "12345.67",
      total_paid: "8901.23",
      total_remaining: "3444.44",
    });
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findAllByText("总应收");

    const receivable = screen
      .getAllByText("总应收")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(receivable?.textContent).toContain("12,345.67");

    const paid = screen
      .getAllByText("已收合计")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(paid?.textContent).toContain("8,901.23");
  });

  it("已交付合约禁用「登记收款」，未结清合约禁用「换绑交付」", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const payButtons = screen.getAllByRole("button", { name: /登记收款/ });
    const deliverButtons = screen.getAllByRole("button", { name: /换绑交付/ });
    // 列表按最新合约在前排序，按钮状态断言不依赖行序：ACTIVE 可收款、DELIVERED 禁收款。
    const payStates = payButtons.map((b) => (b as HTMLButtonElement).disabled);
    expect(payStates).toContain(false); // ACTIVE
    expect(payStates).toContain(true); // DELIVERED
    expect(deliverButtons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true); // 都不是 SETTLED
  });

  it("SCHEDULED 合约已结清时「换绑交付」可点", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValueOnce([{ ...installments[0], status: "SETTLED" }]);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const deliverButtons = screen.getAllByRole("button", { name: /换绑交付/ });
    expect(deliverButtons.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("已结清合约禁止登记收款和终止退款", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValueOnce([{ ...installments[0], status: "SETTLED" }]);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    expect(screen.getByRole("button", { name: /登记收款/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /终止分期并退款/ })).toBeDisabled();
  });
});
