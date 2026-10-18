import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { FundsPage } from "./FundsPage";

import * as catalog from "../shared/api/catalog";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("../shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api/catalog")>();
  const METHODS = [
    "list", "get", "create", "update", "patch", "post", "postEvent", "remove",
    "setStatus", "setActive", "resolve", "release", "settle", "approve", "reject",
    "reverse", "close", "convert", "detail", "allocations", "setAllocations",
    "balance", "executionDetail", "updateProfile", "updateExecution", "merge", "search",
  ];
  const mk = (api: Record<string, unknown>) => {
    const o: Record<string, unknown> = { ...api };
    for (const m of METHODS) {
      if (m in o) o[m] = vi.fn();
    }
    return o;
  };
  const out: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(actual)) {
    const v = (actual as Record<string, unknown>)[key];
    if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).some((x) => typeof x === "function")) {
      out[key] = mk(v as Record<string, unknown>);
    }
  }
  return out as unknown as typeof actual;
});

const pools = [
  { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
  { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", ownership: "SELF", status: "ACTIVE" },
];
const balance = { income: "1000.00", expense: "200.00", cash_balance: "800.00", deposit_held: "100.00", available: "700.00" };
const deposits = [{ id: 11, pool_id: 1, counterparty_id: 99, source_order_id: 7, paid_amount: "500.00", returned_amount: "200.00", status: "HELD", expected_release_on: "2026-11-01" }];
const cashflows = [
  { id: 1, flow_no: "HS0001-CF-BUY-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "500.00", order_no: "HS0001", source: "ORDER_EVENT", fund_nature: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST" },
  { id: 2, flow_no: "HS0001-CF-SELL-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_IN", category: "SELL", direction: "IN", amount: "800.00", order_no: "HS0001", source: "ORDER_EVENT", fund_nature: "BUSINESS", accounting_attribute: "SELF_REVENUE" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools);
  vi.mocked(catalog.poolsApi.balance).mockResolvedValue(balance);
  vi.mocked(catalog.depositsApi.list).mockResolvedValue(deposits);
  vi.mocked(catalog.cashflowsApi.list).mockResolvedValue(cashflows);
  vi.mocked(catalog.reconciliationsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([]);
  // 内嵌 RebatesPanel 本套件不覆盖：同步抛错，与改造前「工厂未导出 rebatesApi」的行为一致
  vi.mocked(catalog.rebatesApi.list).mockImplementation(() => {
    throw new Error("rebatesApi 不在本套件覆盖范围");
  });
});

async function pickSelect(modal: HTMLElement, index: number, title: RegExp) {
  await ui.click(modal.querySelectorAll(".ant-select-selector")[index] as Element);
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  const current = dropdowns[dropdowns.length - 1] as HTMLElement;
  await ui.click(await within(current).findByTitle(title));
}

describe("FundsPage：资金写路径", () => {
  it("新增押金占用提交后回传金额与日期", async () => {
    vi.mocked(catalog.depositsApi.create).mockResolvedValueOnce({ id: 12 });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await ui.click(await screen.findByRole("button", { name: /新增占用/ }));
    await waitFor(() => expect(screen.getByText("新增押金占用")).toBeInTheDocument());
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, /POOL-A/);
    await ui.type(modal.querySelector("#amount") ?? modal, "500.00");
    await ui.click(screen.getByRole("button", { name: /提\s*交/ }));
    await waitFor(() => expect(vi.mocked(catalog.depositsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(catalog.depositsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.pool_id).toBe(1);
    expect(payload.amount).toBe("500.00");
  });

  it("押金释放按 deposit.post 门控：finance 可见、operator 不可见", async () => {
    renderLight(<FundsPage />, { user: "finance" });
    await screen.findByText(/POOL-A/);
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    await screen.findByText("300.00");
    expect(screen.getAllByRole("button", { name: /释\s*放/ }).length).toBeGreaterThanOrEqual(1);
  });

  it("对账可以钻取查看未达流水", async () => {
    vi.mocked(catalog.reconciliationsApi.list).mockResolvedValueOnce([{
      id: 21, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN", unmatched_flow_ids: [1],
    }]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /查看未达流水/ }));
    expect((await screen.findAllByText("HS0001-CF-BUY-01")).length).toBeGreaterThanOrEqual(2);
  });
});
