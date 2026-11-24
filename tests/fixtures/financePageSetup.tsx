import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { within } from "@testing-library/react";
import { resolveMock } from "@fixtures/mock-api";
import { cashflowPage, poolBalancesResponse, studioExpenseSummary } from "@fixtures/api-responses";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { cashflowsApi } from "@/shared/api/cashflows.api";
import { depositsApi } from "@/shared/api/deposits.api";
import { studioExpensesApi } from "@/shared/api/studioExpenses.api";
import { listColumnsApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";
import { reconciliationsApi } from "@/shared/api/reconciliations.api";
import { employeesApi } from "@/shared/api/org.api";
import { useBusinessPeriod } from "@/shared/state/businessPeriod";

export const depositRows = vi.fn<() => Promise<Awaited<ReturnType<typeof depositsApi.page>>["items"]>>();
export const reconciliationRows = vi.fn<() => Promise<Awaited<ReturnType<typeof reconciliationsApi.page>>["items"]>>();
export let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  seedOrderFormFields();
  seedOptionSets();
});


export const pools = [
  { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", status: "ACTIVE" },
  { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", status: "ACTIVE" },
];
export const balance = {
  income: "1000.00",
  expense: "200.00",
  transfer_in: "0.00",
  transfer_out: "0.00",
  cash_balance: "800.00",
  deposit_held: "100.00",
  available: "700.00",
};
export const deposits = [
  { id: 11, pool_id: 1, counterparty_id: 99, source_order_id: 7, ledger_type: "BUSINESS", paid_on: "2026-10-01", paid_amount: "500.00", returned_amount: "200.00", remaining_amount: "300.00", status: "PARTIALLY_RETURNED", available_actions: ["RETURN", "LOSS"], expected_release_on: "2026-11-01" },
];
export const cashflows = [
  { id: 1, flow_no: "ZC00001", pool_id: 1, occurred_on: "2026-10-17", category: "BUY", direction: "OUT", amount: "500.00", order_no: "HS0001", source_type: "ORDER_EVENT", source_id: "HS0001-EV-BUY-01", source: "ORDER_EVENT", ledger_type: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST" },
  { id: 2, flow_no: "SR00001", pool_id: 1, occurred_on: "2026-10-17", category: "SELL", direction: "IN", amount: "800.00", order_no: "HS0001", source_type: "ORDER_EVENT", source_id: "HS0001-EV-SELL-01", source: "ORDER_EVENT", ledger_type: "BUSINESS", accounting_attribute: "SELF_REVENUE" },
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
  resolveMock(vi.mocked(cashflowsApi.list), cashflowPage(cashflows, { total_in: "800.00", total_out: "500.00" }));
  vi.mocked(studioExpensesApi.summary).mockResolvedValue(studioExpenseSummary([]));
  vi.mocked(reconciliationRows).mockResolvedValue([]);
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "管理员", is_active: true },
    { id: 2, username: "finance", display_name: "财务", is_active: true },
  ]);
});
export async function pickSelect(modal: HTMLElement, index: number, title: RegExp) {
  await ui.click(modal.querySelectorAll(".ant-select-selector")[index] as Element);
  // 多个 Select 的下拉都挂在 body 上且历史下拉不销毁 → 必须限定在「最后打开的那个」
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  const current = dropdowns[dropdowns.length - 1] as HTMLElement;
  const option = await within(current).findByTitle(title);
  await ui.click(option);
}

export function PeriodReadyProbe() {
  return <span>{useBusinessPeriod().ready ? "周期已就绪" : "周期加载中"}</span>;
}
