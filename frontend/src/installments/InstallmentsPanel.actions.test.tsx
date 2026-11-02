import { appMessage as message } from "../shared/ui/appFeedback";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { InstallmentsPanel } from "./InstallmentsPanel";
import { resolveMockOnce } from "../test/mock-api";

import * as catalog from "../shared/api/catalog";
import { seedOrderFormFields } from "../test/formFieldsSeed";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

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
    remaining_receivable: "100.00",
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
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([{ id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" }]);
});

describe("InstallmentsPanel：登记收款 / 换绑交付", () => {
  it("已有回收和转售记录时禁用重复处置", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValueOnce([
      { ...installments[0], status: "OVERDUE" },
    ]);
    vi.mocked(catalog.installmentsApi.dispositions).mockResolvedValueOnce([
      { id: 1, installment_id: 1, account_id: 2, action: "RECOVER", occurred_on: "2026-10-12", note: "回收" },
      { id: 2, installment_id: 1, account_id: 2, action: "RESELL", occurred_on: "2026-10-13", note: "转售" },
    ]);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    expect(screen.getByRole("button", { name: /登记回收/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /登记出售/ })).toBeNull();
  });

  it("登记收款提交后回传金额字符串与收款日期", async () => {
    resolveMockOnce(vi.mocked(catalog.installmentsApi.pay), { id: 1 });
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    // 列表按最新合约在前，首个「登记收款」可能是 DELIVERED 禁用态 → 点击可用的那个
    const payButton = screen
      .getAllByRole("button", { name: /登记收款/ })
      .find((b) => !(b as HTMLButtonElement).disabled) as Element;
    await ui.click(payButton);
    await waitFor(() =>
      expect(document.querySelectorAll(".ant-modal-content").length).toBeGreaterThan(0),
    );
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await ui.type(modal.querySelector("#amount") as Element, "50.00");
    await ui.click(screen.getByRole("button", { name: /确认收款/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.pay)).toHaveBeenCalled());
    const [id, payload] = vi.mocked(catalog.installmentsApi.pay).mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(1);
    expect(payload.amount).toBe("50.00");
    expect(typeof payload.amount).toBe("string");
    expect(payload.paid_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("换绑交付：SETTLED 合约可打开弹窗，必填缺失时不提交", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValueOnce([{ ...installments[0], status: "SETTLED" }]);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    await ui.click(screen.getAllByRole("button", { name: /换绑交付/ })[0] as Element);
    await waitFor(() =>
      expect(document.querySelectorAll(".ant-modal-content").length).toBeGreaterThan(0),
    );
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await ui.click(within(modal).getByRole("button", { name: /确认交付/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.deliver)).not.toHaveBeenCalled());
  });

  it("交付前可以登记退款并终止分期", async () => {
    const successSpy = vi.spyOn(message, "success");
    vi.mocked(catalog.installmentsApi.list).mockResolvedValueOnce([
      { ...installments[0], status: "ACTIVE" },
    ]);
    vi.mocked(catalog.installmentsApi.cancel).mockResolvedValueOnce({
      installment: { ...installments[0], status: "CANCELLED" },
      order_status: "CANCELLED",
      account_status: "WAITING",
      refund_amount: "50.00",
      reversed_amount: "0.00",
      cancel_event_ids: [3],
    });
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    await ui.click(screen.getByRole("button", { name: /终止分期并退款/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("取消原因"), "客户取消");
    await ui.click(within(modal).getByRole("button", { name: /确认退款并终止分期/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.cancel)).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ reason: "客户取消", cancelled_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }),
    ));
    expect(successSpy).toHaveBeenCalledWith("退款已登记：¥50.00，账号已回到库存");
    successSpy.mockRestore();
  });

  it("viewer 无 order.event.post → 收款/交付入口全部不渲染", async () => {
    renderLight(<InstallmentsPanel />, { user: "viewer" });
    await screen.findByText("HS0001-INS01");
    expect(screen.queryByRole("button", { name: /登记收款/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /换绑交付/ })).toBeNull();
  });

  it("后端不可达 → 错误条落地", async () => {
    vi.mocked(catalog.installmentsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });
});
