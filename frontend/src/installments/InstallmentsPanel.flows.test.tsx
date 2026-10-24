import { message } from "antd";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { InstallmentsPanel } from "./InstallmentsPanel";

import * as catalog from "../shared/api/catalog";
vi.mock("../shared/api/catalog");

const baseInstallment = {
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
  total_receivable: "300.00",
  final_period_adjustment: "0.00",
  waived_amount: "0.00",
  bad_debt_amount: "0.00",
};

const order = {
  id: 10,
  order_no: "HS-2026-0010",
  order_type: "HS",
  capital_type: "SELF",
  account_business_mode: "SELF",
  account_game_type: "王者荣耀",
  account_game_account: "abc",
  party_name: "张三",
  trade_date: "2026-10-01",
  status: "ACTIVE",
};

let ui: ReturnType<typeof userEvent.setup>;
let successSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  successSpy = vi.spyOn(message, "success").mockImplementation(() => undefined as never);
  errorSpy = vi.spyOn(message, "error").mockImplementation(() => undefined as never);
  vi.clearAllMocks();
  vi.mocked(catalog.installmentsApi.list).mockResolvedValue([{ ...baseInstallment }]);
  vi.mocked(catalog.installmentsApi.schedules).mockResolvedValue([
    { id: 1, installment_id: 1, period_no: 0, due_on: "2026-10-01", due_amount: "100.00", received_amount: "100.00", status: "PENDING" },
  ]);
  vi.mocked(catalog.installmentsApi.dispositions).mockResolvedValue([]);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([order]);
});

afterEach(() => {
  successSpy.mockRestore();
  errorSpy.mockRestore();
});

/** 取当前可见（open）的 Modal 内容节点，按标题子串定位，避免命中关闭态的隐藏 Modal。 */
function openModal(substr: string): HTMLElement {
  const modals = Array.from(document.querySelectorAll<HTMLElement>(".ant-modal-content"));
  const m = modals.find((el) => el.textContent?.includes(substr));
  if (!m) throw new Error(`modal not found: ${substr}`);
  return m;
}

describe("InstallmentsPanel：剩余动作流加深", () => {
  it("登记回收（OVERDUE 合约）提交调用 recover 并提示", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValueOnce([
      { ...baseInstallment, status: "OVERDUE" },
    ]);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    await ui.click(screen.getByRole("button", { name: /登记回收/ }));
    const modal = openModal("逾期回收");
    await ui.clear(within(modal).getByLabelText("回收日期"));
    await ui.type(within(modal).getByLabelText("回收日期"), "2026-10-15");
    await ui.type(within(modal).getByLabelText("回收说明"), "逾期未付");
    await ui.click(within(modal).getByRole("button", { name: /确认回收/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.recover)).toHaveBeenCalledWith(
      1,
      { occurred_on: "2026-10-15", note: "逾期未付" },
    ));
    expect(successSpy).toHaveBeenCalledWith("逾期账号已登记回收");
  });

  it("提前结清提交调用 settleEarly 并提示", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    await ui.click(screen.getByRole("button", { name: /提前结清/ }));
    const modal = openModal("提前结清");
    await ui.clear(within(modal).getByLabelText("结清日期"));
    await ui.type(within(modal).getByLabelText("结清日期"), "2026-10-20");
    await ui.click(within(modal).getByRole("button", { name: /确认提前结清/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.settleEarly)).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ paid_on: "2026-10-20" }),
    ));
    expect(successSpy).toHaveBeenCalledWith("已提前结清，剩余应收一次性收清");
  });

  it("登记违约提交调用 markDefault 并提示", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    await ui.click(screen.getByRole("button", { name: /登记违约/ }));
    const modal = openModal("登记违约");
    await ui.type(within(modal).getByLabelText("违约原因"), "长期失联");
    await ui.click(within(modal).getByRole("button", { name: /确认登记违约/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.markDefault)).toHaveBeenCalledWith(
      1,
      { reason: "长期失联" },
    ));
    expect(successSpy).toHaveBeenCalledWith("已登记违约，合约进入 DEFAULTED");
  });

  it("期次减免（展开行）提交调用 waiveSchedule 并提示", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const expand = document.querySelector(".ant-table-row-expand-icon") as HTMLElement;
    await ui.click(expand);
    const waiveBtn = await screen.findByRole("button", { name: /减免/ });
    await ui.click(waiveBtn);
    const modal = openModal("期次减免");
    await ui.type(within(modal).getByLabelText("减免金额"), "20.00");
    await ui.clear(within(modal).getByLabelText("减免日期"));
    await ui.type(within(modal).getByLabelText("减免日期"), "2026-10-21");
    await ui.type(within(modal).getByLabelText("减免原因"), "协商减免");
    await ui.click(within(modal).getByRole("button", { name: /确认减免/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.waiveSchedule)).toHaveBeenCalledWith(
      1,
      0,
      expect.objectContaining({ amount: "20.00", reason: "协商减免" }),
    ));
    expect(successSpy).toHaveBeenCalledWith("期次减免已登记");
  });

  it("期次展期（展开行）提交调用 extendSchedule 并提示", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const expand = document.querySelector(".ant-table-row-expand-icon") as HTMLElement;
    await ui.click(expand);
    const extendBtn = await screen.findByRole("button", { name: /展期/ });
    await ui.click(extendBtn);
    const modal = openModal("期次展期");
    await ui.clear(within(modal).getByLabelText("新到期日"));
    await ui.type(within(modal).getByLabelText("新到期日"), "2026-11-30");
    await ui.type(within(modal).getByLabelText("展期原因"), "客户申请");
    await ui.click(within(modal).getByRole("button", { name: /确认展期/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.extendSchedule)).toHaveBeenCalledWith(
      1,
      0,
      expect.objectContaining({ new_due_on: "2026-11-30", reason: "客户申请" }),
    ));
    expect(successSpy).toHaveBeenCalledWith("期次展期已登记");
  });

  it("终止分期并退款：提号分期走「提号账号已结束」文案", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValue([
      { ...baseInstallment, contract_type: "PICKUP_SALE", status: "ACTIVE" },
    ]);
    vi.mocked(catalog.installmentsApi.cancel).mockResolvedValueOnce({
      refund_amount: "30.00",
    } as Awaited<ReturnType<typeof catalog.installmentsApi.cancel>>);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await ui.click(screen.getByText("提号分期"));
    await screen.findByText("HS0001-INS01");
    await ui.click(screen.getByRole("button", { name: /终止分期并退款/ }));
    const modal = openModal("退款登记");
    await ui.type(within(modal).getByLabelText("取消原因"), "客户反悔");
    await ui.click(within(modal).getByRole("button", { name: /确认退款并终止分期/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.cancel)).toHaveBeenCalled());
    expect(successSpy).toHaveBeenCalledWith("退款已登记：¥30.00，提号账号已结束");
  });

  it("终止分期并退款：代分期取消后账号回到库存（后端 CANCEL_STOCK→IN_STOCK）", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValue([
      { ...baseInstallment, contract_type: "ADVANCE_PURCHASE", status: "ACTIVE" },
    ]);
    vi.mocked(catalog.installmentsApi.cancel).mockResolvedValueOnce({
      refund_amount: "40.00",
    } as Awaited<ReturnType<typeof catalog.installmentsApi.cancel>>);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await ui.click(screen.getByText("代分期"));
    await screen.findByText("HS0001-INS01");
    await ui.click(screen.getByRole("button", { name: /终止分期并退款/ }));
    const modal = openModal("退款登记");
    await ui.type(within(modal).getByLabelText("取消原因"), "渠道终止");
    await ui.click(within(modal).getByRole("button", { name: /确认退款并终止分期/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.cancel)).toHaveBeenCalled());
    expect(successSpy).toHaveBeenCalledWith("退款已登记：¥40.00，账号已回到库存");
  });

  it("标记逾期：有新增时提示已标记笔数并刷新列表", async () => {
    vi.mocked(catalog.installmentsApi.markOverdue).mockResolvedValue({ marked: 3 });
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const callsBefore = vi.mocked(catalog.installmentsApi.list).mock.calls.length;
    await ui.click(screen.getByRole("button", { name: /标记逾期/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.markOverdue)).toHaveBeenCalled());
    expect(successSpy).toHaveBeenCalledWith("已标记 3 笔逾期");
    // reloadKey 自增 → ContractTable 重新 load
    await waitFor(() =>
      expect(vi.mocked(catalog.installmentsApi.list).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("标记逾期：无新增时提示当前无新增逾期合约", async () => {
    vi.mocked(catalog.installmentsApi.markOverdue).mockResolvedValue({ marked: 0 });
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    await ui.click(screen.getByRole("button", { name: /标记逾期/ }));
    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("当前无新增逾期合约"));
  });

  it("刷新按钮触发列表重新加载", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const callsBefore = vi.mocked(catalog.installmentsApi.list).mock.calls.length;
    await ui.click(screen.getByRole("button", { name: /刷新/ }));
    await waitFor(() =>
      expect(vi.mocked(catalog.installmentsApi.list).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("CLOSED 且已有回收记录 → 行内提示到库存中心售出", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValueOnce([
      { ...baseInstallment, status: "CLOSED" },
    ]);
    vi.mocked(catalog.installmentsApi.dispositions).mockResolvedValueOnce([
      { id: 1, installment_id: 1, account_id: 2, action: "RECOVER", occurred_on: "2026-10-12", note: "回收" },
    ]);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    expect(await screen.findByText(/请到库存中心售出，系统自动关联/)).toBeInTheDocument();
  });

  it("收款提交失败 → Modal 内 InlineError 展示错误", async () => {
    vi.mocked(catalog.installmentsApi.pay).mockRejectedValueOnce(new Error("pay boom"));
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    await ui.click(screen.getAllByRole("button", { name: /登记收款/ })[0] as Element);
    const modal = openModal("分期收款");
    await ui.type(within(modal).getByLabelText("本次实收"), "50.00");
    await ui.click(within(modal).getByRole("button", { name: /确认收款/ }));
    await waitFor(() => expect(within(modal).getByText(/pay boom/)).toBeInTheDocument());
    expect(vi.mocked(catalog.installmentsApi.pay)).toHaveBeenCalled();
  });
});
