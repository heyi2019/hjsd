import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { resolveMockOnce } from "@fixtures/mock-api";
import { customReceipt, depositRows, deposits, modalContent, pickSelect, ui } from "@fixtures/financePageDeepSetup";
import { FinancePage } from "@/finance/FinancePage";
import { depositsApi } from "@/shared/api/deposits.api";
import { orderFormFieldsApi } from "@/shared/api/orders.api";
import { transfersApi } from "@/shared/api/transfers.api";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/deposits.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/profitAllocation.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/reconciliations.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;
vi.mock("@/shared/api/transfers.api");
vi.mock("@/shared/api/studioExpenses.api");

describe("FinancePage：资金写路径深覆盖", () => {
  it("资金账户划转展示并提交配置的自定义字段", async () => {
    customReceipt("FUNDTRANSFER");
    resolveMockOnce(vi.mocked(transfersApi.create), { transfer_id: "TRF-200" });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(await screen.findByRole("button", { name: /资金账户划转/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await pickSelect(modal, 1, /押金池/);
    await ui.type(within(modal).getByLabelText("划转金额"), "100.00");
    const receipt = await within(modal).findByLabelText("自定义凭据");
    await ui.click(within(modal).getByRole("button", { name: /确认划转/ }));
    expect(vi.mocked(transfersApi.create)).not.toHaveBeenCalled();
    await ui.type(receipt, "划转凭据");
    await ui.click(within(modal).getByRole("button", { name: /确认划转/ }));
    await waitFor(() => expect(vi.mocked(transfersApi.create)).toHaveBeenCalledWith(
      expect.objectContaining({ form_extra: { receipt: "划转凭据" } }),
    ));
  });

  it("取消划转后重新打开不会带入上次的自定义字段", async () => {
    customReceipt("FUNDTRANSFER");
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(await screen.findByRole("button", { name: /资金账户划转/ }));
    await ui.type(await screen.findByLabelText("自定义凭据"), "上一笔");
    await ui.click(within(modalContent()).getByRole("button", { name: "Close" }));
    await ui.click(await screen.findByRole("button", { name: /资金账户划转/ }));
    expect(await screen.findByLabelText("自定义凭据")).toHaveValue("");
  });

  it("新增押金提交配置的自定义字段", async () => {
    customReceipt("FUNDDEPOSIT");
    resolveMockOnce(vi.mocked(depositsApi.create), { id: 12 });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /新增占用/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await ui.type(within(modal).getByLabelText("占用金额"), "100");
    await ui.type(await within(modal).findByLabelText("自定义凭据"), "押金凭据");
    await ui.click(within(modal).getByRole("button", { name: /提\s*交/ }));
    await waitFor(() => expect(vi.mocked(depositsApi.create)).toHaveBeenCalledWith(
      expect.objectContaining({ form_extra: { receipt: "押金凭据" } }),
    ));
  });

  it("编辑押金回填自定义字段并保留其他操作的历史字段", async () => {
    customReceipt("FUNDDEPOSIT");
    vi.mocked(depositRows).mockResolvedValueOnce([{
      ...deposits[0], status: "PAID", paid_on: "2026-10-17", returned_amount: "0.00", available_actions: ["EDIT", "CANCEL", "RETURN", "LOSS"],
      form_extra: { receipt: "原始凭据", old_action: "历史信息" },
    }] as never);
    resolveMockOnce(vi.mocked(depositsApi.update), { id: 11 });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    const row = screen.getByText("#99").closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: "编辑" }));
    const receipt = await screen.findByLabelText("自定义凭据");
    expect(receipt).toHaveValue("原始凭据");
    await ui.clear(receipt);
    await ui.type(receipt, "更新凭据");
    await ui.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(vi.mocked(depositsApi.update)).toHaveBeenCalledWith(11,
      expect.objectContaining({ form_extra: { receipt: "更新凭据", old_action: "历史信息" } }),
    ));
  });

  it("编辑押金时清空可选数字字段并保留其他历史字段", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => scope === "FUNDDEPOSIT" ? [{
      id: 902, order_type_code: scope, field_key: "optional_number", label: "可选数字",
      field_type: "NUMBER", required: false, is_active: true, sort_order: 1,
      locked: false, is_custom: true, section: "EXTRA",
    }] : []);
    vi.mocked(depositRows).mockResolvedValueOnce([{
      ...deposits[0], status: "PAID", paid_on: "2026-10-17", returned_amount: "0.00", available_actions: ["EDIT", "CANCEL", "RETURN", "LOSS"],
      form_extra: { optional_number: 17, old_action: "历史信息" },
    }] as never);
    resolveMockOnce(vi.mocked(depositsApi.update), { id: 11 });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(within(screen.getByText("#99").closest("tr") as HTMLElement).getByRole("button", { name: "编辑" }));
    const optionalNumber = await screen.findByLabelText("可选数字");
    expect(optionalNumber).toHaveValue("17");
    await ui.clear(optionalNumber);
    await ui.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(vi.mocked(depositsApi.update)).toHaveBeenCalledWith(11,
      expect.objectContaining({ form_extra: { old_action: "历史信息" } }),
    ));
  });

  it("编辑押金时清空唯一可选字段仍会提交空对象", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => scope === "FUNDDEPOSIT" ? [{
      id: 903, order_type_code: scope, field_key: "optional_number", label: "可选数字",
      field_type: "NUMBER", required: false, is_active: true, sort_order: 1,
      locked: false, is_custom: true, section: "EXTRA",
    }] : []);
    vi.mocked(depositRows).mockResolvedValueOnce([{
      ...deposits[0], status: "PAID", paid_on: "2026-10-17", returned_amount: "0.00", available_actions: ["EDIT", "CANCEL", "RETURN", "LOSS"],
      form_extra: { optional_number: 17 },
    }] as never);
    resolveMockOnce(vi.mocked(depositsApi.update), { id: 11 });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(within(screen.getByText("#99").closest("tr") as HTMLElement).getByRole("button", { name: "编辑" }));
    await ui.clear(await screen.findByLabelText("可选数字"));
    await ui.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(vi.mocked(depositsApi.update)).toHaveBeenCalledWith(11,
      expect.objectContaining({ form_extra: {} }),
    ));
  });

  it("押金释放提交配置的自定义字段", async () => {
    customReceipt("FUNDRELEASE");
    resolveMockOnce(vi.mocked(depositsApi.release), { id: 11 });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /释\s*放/ }));
    const modal = modalContent();
    await ui.type(within(modal).getByLabelText("释放金额"), "100");
    await ui.type(within(modal).getByLabelText("释放日期"), "2026-10-19");
    await ui.type(await within(modal).findByLabelText("自定义凭据"), "释放凭据");
    await ui.click(within(modal).getByRole("button", { name: /确认释放/ }));
    await waitFor(() => expect(vi.mocked(depositsApi.release)).toHaveBeenCalledWith(11,
      expect.objectContaining({ form_extra: { receipt: "释放凭据" } }),
    ));
  });

  it("押金损失提交配置的自定义字段", async () => {
    customReceipt("FUNDLOSS");
    resolveMockOnce(vi.mocked(depositsApi.loss), { id: 91 });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /登记损失/ }));
    const modal = modalContent();
    await ui.type(within(modal).getByLabelText("损失金额"), "100");
    await ui.type(within(modal).getByLabelText("费用分类"), "违约损失");
    await ui.type(within(modal).getByLabelText("损失原因"), "未返还");
    await ui.type(await within(modal).findByLabelText("自定义凭据"), "损失凭据");
    await ui.click(within(modal).getByRole("button", { name: /确认损失/ }));
    await waitFor(() => expect(vi.mocked(depositsApi.loss)).toHaveBeenCalledWith(11,
      expect.objectContaining({ form_extra: { receipt: "损失凭据" } }),
    ));
  });

  it("取消押金提交配置的自定义字段", async () => {
    customReceipt("FUNDCANCEL");
    vi.mocked(depositRows).mockResolvedValueOnce([{
      ...deposits[0], status: "PAID", paid_on: "2026-10-17", returned_amount: "0.00", available_actions: ["EDIT", "CANCEL", "RETURN", "LOSS"],
    }] as never);
    resolveMockOnce(vi.mocked(depositsApi.cancel), { id: 11 });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /取\s*消/ }));
    const modal = modalContent();
    await ui.type(within(modal).getByLabelText("取消原因"), "登记有误");
    await ui.type(await within(modal).findByLabelText("自定义凭据"), "取消凭据");
    await ui.click(within(modal).getByRole("button", { name: /确认取消/ }));
    await waitFor(() => expect(vi.mocked(depositsApi.cancel)).toHaveBeenCalledWith(11,
      expect.objectContaining({ form_extra: { receipt: "取消凭据" } }),
    ));
  });

  it("资金账户划转提交调用 transfersApi.create", async () => {
    resolveMockOnce(vi.mocked(transfersApi.create), { id: 200, transfer_id: "TRF-200" });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(await screen.findByRole("button", { name: /资金账户划转/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await pickSelect(modal, 1, /押金池/);
    await ui.type(within(modal).getByLabelText("划转金额"), "100.00");
    await ui.type(within(modal).getByLabelText("说明"), "调拨测试");
    await ui.click(screen.getByRole("button", { name: /确认划转/ }));
    await waitFor(() => expect(vi.mocked(transfersApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(transfersApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.source_pool_id).toBe(1);
    expect(payload.target_pool_id).toBe(2);
    expect(payload.amount).toBe("100.00");
  });

  it("资金账户划转金额不接受负数", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(await screen.findByRole("button", { name: /资金账户划转/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await pickSelect(modal, 1, /押金池/);
    await ui.type(within(modal).getByLabelText("划转金额"), "-100");
    await ui.click(screen.getByRole("button", { name: /确认划转/ }));

    expect(await screen.findByText("划转金额不能为负数")).toBeInTheDocument();
    expect(vi.mocked(transfersApi.create)).not.toHaveBeenCalled();
  });

  it("押金释放提交调用 depositsApi.release", async () => {
    resolveMockOnce(vi.mocked(depositsApi.release), { id: 11 });
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /释\s*放/ }));
    const modal = modalContent();
    await ui.type(within(modal).getByLabelText("释放金额"), "100.00");
    await ui.type(within(modal).getByLabelText("释放日期"), "2026-10-19");
    await ui.click(screen.getByRole("button", { name: /确认释放/ }));
    await waitFor(() => expect(vi.mocked(depositsApi.release)).toHaveBeenCalled());
    const [id, payload] = vi.mocked(depositsApi.release).mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(11);
    expect(payload.amount).toBe("100.00");
  });
});
