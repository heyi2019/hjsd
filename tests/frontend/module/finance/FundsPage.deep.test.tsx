import { appMessage as message } from "@/shared/ui/appFeedback";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { FundsPage } from "@/pools/FundsPage";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";
import { cashflowPage, poolBalancesResponse, studioExpenseSummary } from "@fixtures/api-responses";

import { cashflowsApi } from "@/shared/api/cashflows.api";
import { depositsApi } from "@/shared/api/deposits.api";
import { studioExpensesApi } from "@/shared/api/studioExpenses.api";
import { listColumnsApi, orderFormFieldsApi, ordersApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";
import { reconciliationsApi } from "@/shared/api/reconciliations.api";
import { transfersApi } from "@/shared/api/transfers.api";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { employeesApi } from "@/shared/api/org.api";
const depositRows = vi.fn<() => Promise<Awaited<ReturnType<typeof depositsApi.page>>["items"]>>();
const reconciliationRows = vi.fn<() => Promise<Awaited<ReturnType<typeof reconciliationsApi.page>>["items"]>>();
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  seedOrderFormFields();
  seedOptionSets();
});

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

const pools = [
  { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", status: "ACTIVE" },
  { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", status: "ACTIVE" },
];
const balance = {
  income: "1000.00",
  expense: "200.00",
  transfer_in: "0.00",
  transfer_out: "0.00",
  cash_balance: "800.00",
  deposit_held: "100.00",
  available: "700.00",
};
const deposits = [
  { id: 11, pool_id: 1, counterparty_id: 99, source_order_id: 7, paid_amount: "500.00", returned_amount: "200.00", remaining_amount: "300.00", status: "PARTIALLY_RETURNED", available_actions: ["RETURN", "LOSS"], expected_release_on: "2026-11-01" },
];
const cashflows = [
  { id: 1, flow_no: "ZC00001", pool_id: 1, occurred_on: "2026-10-17", category: "BUY", direction: "OUT", amount: "500.00", order_no: "HS0001", source_type: "ORDER_EVENT", source_id: "HS0001-EV-BUY-01", source: "ORDER_EVENT", ledger_type: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST" },
  { id: 2, flow_no: "SR00001", pool_id: 1, occurred_on: "2026-10-17", category: "SELL", direction: "IN", amount: "800.00", order_no: "HS0001", source_type: "ORDER_EVENT", source_id: "HS0001-EV-SELL-01", source: "ORDER_EVENT", ledger_type: "BUSINESS", accounting_attribute: "SELF_REVENUE" },
  { id: 3, flow_no: "ZC00002", pool_id: 1, occurred_on: "2026-10-18", category: "CXL", direction: "OUT", amount: "500.00", order_no: "HS0001", source_type: "REVERSAL", source_id: "ZC00001", source: "REVERSAL", reviewed_by: "admin", reviewed_at: "2026-10-18T09:30:00", ledger_type: "BUSINESS", accounting_attribute: "REVERSAL" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(depositsApi.page).mockImplementation(async ({ limit, offset }) => {
    const items = await depositRows();
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  });
  vi.mocked(reconciliationsApi.page).mockImplementation(async ({ limit, offset }) => {
    const items = await reconciliationRows();
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  });

  vi.mocked(listColumnsApi.all).mockResolvedValue([]);
  vi.mocked(poolsApi.list).mockResolvedValue(pools);
  // 余额与汇总一次批量取回（服务端 Decimal 聚合），合计按两池同额计。
  resolveMock(vi.mocked(poolsApi.balances), poolBalancesResponse(
    pools.map((pool) => ({ ...balance, pool_id: pool.id, pool_code: pool.code })),
    { pool_count: 2, cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00" },
  ));
  resolveMock(vi.mocked(depositRows), deposits);
  // 合计由服务端返回，桩里同步给出，避免卡片落回 0.00。
  resolveMock(vi.mocked(cashflowsApi.list), cashflowPage(cashflows, { total_in: "800.00", total_out: "1000.00" }));
  vi.mocked(studioExpensesApi.summary).mockResolvedValue(studioExpenseSummary([]));
  vi.mocked(reconciliationRows).mockResolvedValue([]);
  vi.mocked(employeesApi.list).mockResolvedValue([{ id: 1, username: "admin", display_name: "管理员", is_active: true }]);
});

async function pickSelect(modal: HTMLElement, index: number, title: RegExp) {
  await ui.click(modal.querySelectorAll(".ant-select-selector")[index] as Element);
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  const current = dropdowns[dropdowns.length - 1] as HTMLElement;
  const option = await within(current).findByTitle(title);
  await ui.click(option);
}

function modalContent(): HTMLElement {
  return document.querySelector(".ant-modal-content") as HTMLElement;
}

function customReceipt(scope: string) {
  vi.mocked(orderFormFieldsApi.list).mockImplementation(async (actualScope) => actualScope === scope ? [{
    id: 901, order_type_code: scope, field_key: "receipt", label: "自定义凭据",
    field_type: "TEXT", required: true, is_active: true, sort_order: 1,
    locked: false, is_custom: true, section: "FINANCE",
  }] : []);
}

describe("FundsPage：资金写路径深覆盖", () => {
  it("资金账户划转展示并提交配置的自定义字段", async () => {
    customReceipt("FUNDTRANSFER");
    resolveMockOnce(vi.mocked(transfersApi.create), { transfer_id: "TRF-200" });
    renderLight(<FundsPage />, { user: "admin" });
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
    renderLight(<FundsPage />, { user: "admin" });
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
    renderLight(<FundsPage />, { user: "admin" });
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
    renderLight(<FundsPage />, { user: "admin" });
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
    renderLight(<FundsPage />, { user: "admin" });
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
    renderLight(<FundsPage />, { user: "admin" });
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
    renderLight(<FundsPage />, { user: "admin" });
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
    renderLight(<FundsPage />, { user: "admin" });
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
    renderLight(<FundsPage />, { user: "admin" });
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

  it("新增对账提交配置的自定义字段", async () => {
    customReceipt("FUNDRECON");
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /新增对账/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await ui.type(within(modal).getByLabelText("对账账户"), "账户A");
    await ui.type(within(modal).getByLabelText("账面余额"), "800");
    await ui.type(await within(modal).findByLabelText("自定义凭据"), "对账凭据");
    await ui.click(within(modal).getByRole("button", { name: /提交对账/ }));
    await waitFor(() => expect(vi.mocked(reconciliationsApi.create)).toHaveBeenCalledWith(
      expect.objectContaining({ form_extra: { receipt: "对账凭据" } }),
    ));
  });

  it("核销对账提交配置的自定义字段", async () => {
    customReceipt("FUNDCLEAR");
    vi.mocked(reconciliationRows).mockResolvedValueOnce([{
      id: 21, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户",
      system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN",
    }]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /核销/ }));
    const modal = modalContent();
    await ui.type(within(modal).getByLabelText("处理说明"), "完成核对");
    await ui.type(await within(modal).findByLabelText("自定义凭据"), "核销凭据");
    await ui.click(within(modal).getByRole("button", { name: /确认核销/ }));
    await waitFor(() => expect(vi.mocked(reconciliationsApi.resolve)).toHaveBeenCalledWith(
      21, "完成核对", [1], { receipt: "核销凭据" },
    ));
  });

  it("资金账户划转提交调用 transfersApi.create", async () => {
    resolveMockOnce(vi.mocked(transfersApi.create), { id: 200, transfer_id: "TRF-200" });
    renderLight(<FundsPage />, { user: "admin" });
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
    renderLight(<FundsPage />, { user: "admin" });
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

  it("对账状态列显示未核销/已核销（对齐后端 ReconciliationStatus 语义）", async () => {
    vi.mocked(reconciliationRows).mockResolvedValue([
      { id: 31, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN" },
      { id: 32, pool_id: 1, reconciled_on: "2026-10-17", account_label: "经营账户", system_balance: "800.00", statement_balance: "800.00", difference: "0.00", status: "RESOLVED" },
    ]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    expect(await screen.findByText("未核销")).toBeInTheDocument();
    expect(screen.getByText("已核销")).toBeInTheDocument();
    // 不再出现质量域语义的「未结算/已处置」
    expect(screen.queryByText("已处置")).toBeNull();
  });



  it("新增对账预检：命中唯一约束（池+账户+日期）时阻断提交并提示调整", async () => {
    const warningSpy = vi.spyOn(message, "warning").mockReturnValue(undefined as never);
    // 初始加载即带入一条「同池+同日期+同账户」记录，模拟重复对账场景。
    vi.mocked(reconciliationRows).mockResolvedValueOnce([
      { id: 30, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN" },
    ]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /新增对账/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await ui.clear(within(modal).getByLabelText("对账日期"));
    await ui.type(within(modal).getByLabelText("对账日期"), "2026-10-18");
    await ui.type(within(modal).getByLabelText("对账账户"), "经营账户");
    await ui.type(within(modal).getByLabelText("账面余额"), "900.00");
    await ui.click(screen.getByRole("button", { name: /提交对账/ }));
    await waitFor(() =>
      expect(warningSpy).toHaveBeenCalledWith("同一资金账户、对账账户和日期只能对账一次，请调整对账日期或账户"),
    );
    expect(vi.mocked(reconciliationsApi.create)).not.toHaveBeenCalled();
    warningSpy.mockRestore();
  });

  it("对账页展示系统余额口径说明", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    expect(await screen.findByText(/系统余额是创建对账时截至对账日期的已入账流水累计净额/)).toHaveTextContent("不会改变已保存的对账和首次快照");
  });

  it("对账差异核销提交调用 reconciliationsApi.resolve", async () => {
    vi.mocked(reconciliationRows).mockResolvedValueOnce([{
      id: 21, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN",
    }]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /核销/ }));
    const modal = modalContent();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "操作人" }).closest(".ant-select")).toHaveTextContent("管理员"));
    await ui.type(within(modal).getByLabelText("处理说明"), "已补录漏记流水");
    await ui.click(screen.getByRole("button", { name: /确认核销/ }));
    await waitFor(() => expect(vi.mocked(reconciliationsApi.resolve)).toHaveBeenCalledWith(21, "已补录漏记流水", [1], undefined));
  });

  it("押金释放提交调用 depositsApi.release", async () => {
    resolveMockOnce(vi.mocked(depositsApi.release), { id: 11 });
    renderLight(<FundsPage />, { user: "admin" });
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
