import { appMessage as message } from "@/shared/ui/appFeedback";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { FundsPage } from "@/pools/FundsPage";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";
import { cashflowPage, cashflowTotals, poolBalancesResponse, studioExpenseSummary } from "@fixtures/api-responses";

import { cashflowsApi } from "@/shared/api/cashflows.api";
import { depositsApi } from "@/shared/api/deposits.api";
import { studioExpensesApi } from "@/shared/api/studioExpenses.api";
import { listColumnsApi, ordersApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";
import { reconciliationsApi } from "@/shared/api/reconciliations.api";
import { transfersApi } from "@/shared/api/transfers.api";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { employeesApi } from "@/shared/api/org.api";
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
  { id: 11, pool_id: 1, counterparty_id: 99, source_order_id: 7, paid_amount: "500.00", returned_amount: "200.00", remaining_amount: "300.00", status: "HELD", expected_release_on: "2026-11-01" },
];
const cashflows = [
  { id: 1, flow_no: "ZC00001", pool_id: 1, occurred_on: "2026-10-17", category: "BUY", direction: "OUT", amount: "500.00", order_no: "HS0001", source_type: "ORDER_EVENT", source_id: "HS0001-EV-BUY-01", source: "ORDER_EVENT", ledger_type: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST" },
  { id: 2, flow_no: "SR00001", pool_id: 1, occurred_on: "2026-10-17", category: "SELL", direction: "IN", amount: "800.00", order_no: "HS0001", source_type: "ORDER_EVENT", source_id: "HS0001-EV-SELL-01", source: "ORDER_EVENT", ledger_type: "BUSINESS", accounting_attribute: "SELF_REVENUE" },
  { id: 3, flow_no: "ZC00002", pool_id: 1, occurred_on: "2026-10-18", category: "CXL", direction: "OUT", amount: "500.00", order_no: "HS0001", source_type: "REVERSAL", source_id: "ZC00001", source: "REVERSAL", reviewed_by: "admin", reviewed_at: "2026-10-18T09:30:00", ledger_type: "BUSINESS", accounting_attribute: "REVERSAL" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listColumnsApi.all).mockResolvedValue([]);
  vi.mocked(poolsApi.list).mockResolvedValue(pools);
  // 余额与汇总一次批量取回（服务端 Decimal 聚合），合计按两池同额计。
  resolveMock(vi.mocked(poolsApi.balances), poolBalancesResponse(
    pools.map((pool) => ({ ...balance, pool_id: pool.id, pool_code: pool.code })),
    { pool_count: 2, cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00" },
  ));
  resolveMock(vi.mocked(depositsApi.list), deposits);
  // 合计由服务端返回，桩里同步给出，避免卡片落回 0.00。
  resolveMock(vi.mocked(cashflowsApi.list), cashflowPage(cashflows, { total_in: "800.00", total_out: "1000.00" }));
  resolveMock(vi.mocked(cashflowsApi.totals), cashflowTotals({ total_in: "800.00", total_out: "1000.00" }));
  vi.mocked(studioExpensesApi.summary).mockResolvedValue(studioExpenseSummary([]));
  vi.mocked(reconciliationsApi.list).mockResolvedValue([]);
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

describe("FundsPage：资金写路径深覆盖", () => {
  it("资金账户划转提交调用 transfersApi.create", async () => {
    resolveMockOnce(vi.mocked(transfersApi.create), { id: 200, transfer_id: "TRF-200" });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(await screen.findByRole("button", { name: /资金账户划转/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await pickSelect(modal, 1, /押金池/);
    await ui.type(modal.querySelector("#amount") ?? modal, "100.00");
    await ui.type(modal.querySelector("#note") ?? modal, "调拨测试");
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
    await ui.type(modal.querySelector("#amount") ?? modal, "-100");
    await ui.click(screen.getByRole("button", { name: /确认划转/ }));

    expect(await screen.findByText("划转金额不能为负数")).toBeInTheDocument();
    expect(vi.mocked(transfersApi.create)).not.toHaveBeenCalled();
  });

  it("对账状态列显示未核销/已核销（对齐后端 ReconciliationStatus 语义）", async () => {
    vi.mocked(reconciliationsApi.list).mockResolvedValue([
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
    vi.mocked(reconciliationsApi.list).mockResolvedValueOnce([
      { id: 30, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN" },
    ]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /新增对账/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await ui.clear(modal.querySelector("#reconciled_on") ?? modal);
    await ui.type(modal.querySelector("#reconciled_on") ?? modal, "2026-10-18");
    await ui.type(modal.querySelector("#account_label") ?? modal, "经营账户");
    await ui.type(modal.querySelector("#statement_balance") ?? modal, "900.00");
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
    expect(await screen.findByText(/系统余额口径：截至对账日期「已入账」流水的累计/)).toBeInTheDocument();
  });

  it("对账差异核销提交调用 reconciliationsApi.resolve", async () => {
    vi.mocked(reconciliationsApi.list).mockResolvedValueOnce([{
      id: 21, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN",
    }]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /核销/ }));
    const modal = modalContent();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "操作人" }).closest(".ant-select")).toHaveTextContent("管理员"));
    await ui.type(modal.querySelector("#reason") ?? modal, "已补录漏记流水");
    await ui.click(screen.getByRole("button", { name: /确认核销/ }));
    await waitFor(() => expect(vi.mocked(reconciliationsApi.resolve)).toHaveBeenCalledWith(21, "已补录漏记流水", [1]));
  });

  it("押金释放提交调用 depositsApi.release", async () => {
    resolveMockOnce(vi.mocked(depositsApi.release), { id: 11 });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /释\s*放/ }));
    const modal = modalContent();
    await ui.type(modal.querySelector("#amount") ?? modal, "100.00");
    await ui.type(modal.querySelector("#released_on") ?? modal, "2026-10-19");
    await ui.click(screen.getByRole("button", { name: /确认释放/ }));
    await waitFor(() => expect(vi.mocked(depositsApi.release)).toHaveBeenCalled());
    const [id, payload] = vi.mocked(depositsApi.release).mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(11);
    expect(payload.amount).toBe("100.00");
  });
});
