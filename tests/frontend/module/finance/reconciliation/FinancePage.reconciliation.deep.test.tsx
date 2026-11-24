import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { customReceipt, modalContent, pickSelect, reconciliationRows, ui } from "@fixtures/financePageDeepSetup";
import { FinancePage } from "@/finance/FinancePage";
import { reconciliationsApi } from "@/shared/api/reconciliations.api";
import { appMessage as message } from "@/shared/ui/appFeedback";

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

describe("FinancePage：资金对账深覆盖", () => {
  it("新增对账提交配置的自定义字段", async () => {
    customReceipt("FUNDRECON");
    renderLight(<FinancePage />, { user: "admin" });
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
    renderLight(<FinancePage />, { user: "admin" });
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

  it("对账状态列显示未核销/已核销（对齐后端 ReconciliationStatus 语义）", async () => {
    vi.mocked(reconciliationRows).mockResolvedValue([
      { id: 31, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN" },
      { id: 32, pool_id: 1, reconciled_on: "2026-10-17", account_label: "经营账户", system_balance: "800.00", statement_balance: "800.00", difference: "0.00", status: "RESOLVED" },
    ]);
    renderLight(<FinancePage />, { user: "admin" });
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
    renderLight(<FinancePage />, { user: "admin" });
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
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    expect(await screen.findByText(/系统余额是创建对账时截至对账日期的已入账流水累计净额/)).toHaveTextContent("不会改变已保存的对账和首次快照");
  });

  it("对账差异核销提交调用 reconciliationsApi.resolve", async () => {
    vi.mocked(reconciliationRows).mockResolvedValueOnce([{
      id: 21, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN",
    }]);
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /核销/ }));
    const modal = modalContent();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "操作人" }).closest(".ant-select")).toHaveTextContent("管理员"));
    await ui.type(within(modal).getByLabelText("处理说明"), "已补录漏记流水");
    await ui.click(screen.getByRole("button", { name: /确认核销/ }));
    await waitFor(() => expect(vi.mocked(reconciliationsApi.resolve)).toHaveBeenCalledWith(21, "已补录漏记流水", [1], undefined));
  });

});
