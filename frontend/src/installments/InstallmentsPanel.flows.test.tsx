import { appMessage as message } from "../shared/ui/appFeedback";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { InstallmentsPanel } from "./InstallmentsPanel";

import * as catalog from "../shared/api/catalog";
import { seedOrderFormFields } from "../test/formFieldsSeed";
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
  remaining_receivable: "100.00",
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

/** 回收转售的出售订单：必须是新的售出订单（不能是分期来源单本身，后端强制）。 */
const resaleOrder = { ...order, id: 20, order_no: "HS-2026-0020", party_name: "李四" };

let ui: ReturnType<typeof userEvent.setup>;
let successSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  successSpy = vi.spyOn(message, "success").mockImplementation(() => undefined as never);
  errorSpy = vi.spyOn(message, "error").mockImplementation(() => undefined as never);
  vi.clearAllMocks();
  seedOrderFormFields(catalog);
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
    await ui.type(within(modal).getByLabelText("结清日期"), "2026-10-20{enter}");
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
  it("首屏加载一次分期列表（刷新入口已收敛到订单页/操作后自动重载）", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    expect(vi.mocked(catalog.installmentsApi.list)).toHaveBeenCalledTimes(1);
    // 逾期标记是全局动作，入口在订单页「分期与回款」Tab 的右上角，不在本面板内。
    expect(screen.queryByRole("button", { name: /标记逾期/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^刷新$/ })).toBeNull();
  });

  it("CLOSED 且已有回收记录 → 行内提供登记出售入口", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValueOnce([
      { ...baseInstallment, status: "CLOSED" },
    ]);
    vi.mocked(catalog.installmentsApi.dispositions).mockResolvedValueOnce([
      { id: 1, installment_id: 1, account_id: 2, action: "RECOVER", occurred_on: "2026-10-12", note: "回收" },
    ]);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    expect(await screen.findByRole("button", { name: /登记出售/ })).toBeInTheDocument();
  });

  it("登记出售：选择出售订单并填写后调用 resale 关联", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValueOnce([
      { ...baseInstallment, status: "CLOSED" },
    ]);
    vi.mocked(catalog.installmentsApi.dispositions).mockResolvedValueOnce([
      { id: 1, installment_id: 1, account_id: 2, action: "RECOVER", occurred_on: "2026-10-12", note: "回收" },
    ]);
    vi.mocked(catalog.ordersApi.list).mockResolvedValueOnce([order, resaleOrder]);
    vi.mocked(catalog.installmentsApi.resale).mockResolvedValue({
      id: 2, installment_id: 1, account_id: 2, action: "RESELL", occurred_on: "2026-10-20", related_order_id: 20, note: "转售",
    } as never);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    await ui.click(await screen.findByRole("button", { name: /登记出售/ }));
    const modal = openModal("登记出售");
    await ui.click(within(modal).getByRole("combobox", { name: /出售订单/ }));
    await ui.click(await within(document.body).findByText("HS-2026-0020 · 李四", { selector: ".ant-select-item-option-content" }));
    await ui.clear(within(modal).getByLabelText("出售日期"));
    await ui.type(within(modal).getByLabelText("出售日期"), "2026-10-20");
    await ui.type(within(modal).getByLabelText("出售说明"), "转售给下家");
    await ui.click(within(modal).getByRole("button", { name: /确认登记/ }));
    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.resale)).toHaveBeenCalledWith(
      1,
      { resale_order_id: 20, occurred_on: "2026-10-20", note: "转售给下家" },
    ));
    expect(successSpy).toHaveBeenCalledWith("已登记出售，原分期与出售订单的利润关联保留");
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

  it("P2-274：上一弹窗操作失败后，打开其它业务弹窗不残留旧错误", async () => {
    vi.mocked(catalog.installmentsApi.markDefault).mockRejectedValueOnce(new Error("default boom"));
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    // 在「登记违约」弹窗触发失败，错误残留于共享 write.error
    await ui.click(screen.getByRole("button", { name: /登记违约/ }));
    const defaultModal = openModal("登记违约");
    await ui.type(within(defaultModal).getByLabelText("违约原因"), "长期失联");
    await ui.click(within(defaultModal).getByRole("button", { name: /确认登记违约/ }));
    await waitFor(() => expect(within(defaultModal).getByText(/default boom/)).toBeInTheDocument());
    // 注：motion-stub 下弹窗关闭动画不会收尾，A 弹窗在测试中仍可见、遮罩仍在；
    // 因此这里直接以 fireEvent 打开另一个业务弹窗（提前结清）——fireEvent 绕过遮罩直接触发其 onClick。
    // 打开任一业务弹窗应清空共享错误态（含从 A 弹窗切到 B 弹窗的场景）。
    fireEvent.click(await screen.findByRole("button", { name: /提前结清/ }));
    const settleModal = openModal("提前结清");
    // 旧错误不应残留到新弹窗
    expect(within(settleModal).queryByText(/default boom/)).toBeNull();
  });
});
