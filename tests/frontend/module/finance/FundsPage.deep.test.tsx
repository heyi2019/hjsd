import { appMessage as message } from "@/shared/ui/appFeedback";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { FundsPage } from "@/pools/FundsPage";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";

import * as catalog from "@/shared/api/catalog";
import { seedOptionSets, seedOrderFormFields } from "@fixtures/formFieldsSeed";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  seedOrderFormFields(catalog);
  seedOptionSets(catalog);
});

vi.mock("@/shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/catalog")>();
  const METHODS = [
    "all",
    "list", "get", "create", "update", "patch", "post", "postEvent", "remove",
    "setStatus", "setActive", "resolve", "release", "loss", "repair", "settle", "approve", "reject",
    "reverse", "close", "convert", "detail", "allocations", "setAllocations",
    "balance", "balances", "executionDetail", "updateProfile", "updateExecution", "merge", "search",
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
const balance = {
  income: "1000.00",
  expense: "200.00",
  cash_balance: "800.00",
  deposit_held: "100.00",
  available: "700.00",
};
const deposits = [
  { id: 11, pool_id: 1, counterparty_id: 99, source_order_id: 7, paid_amount: "500.00", returned_amount: "200.00", remaining_amount: "300.00", status: "HELD", expected_release_on: "2026-11-01" },
];
const cashflows = [
  { id: 1, flow_no: "HS0001-CF-BUY-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "500.00", order_no: "HS0001", source: "ORDER_EVENT", accounting_attribute: "SELF_DIRECT_COST" },
  { id: 2, flow_no: "HS0001-CF-SELL-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_IN", category: "SELL", direction: "IN", amount: "800.00", order_no: "HS0001", source: "ORDER_EVENT", accounting_attribute: "SELF_REVENUE" },
  { id: 3, flow_no: "HS0001-CF-CXL-01", pool_id: 1, occurred_on: "2026-10-18", nature: "BUSINESS_OUT", category: "CXL", direction: "OUT", amount: "500.00", order_no: "HS0001", source: "ORDER_EVENT", status: "APPROVED", reviewed_by: "admin", reviewed_at: "2026-10-18T09:30:00", reversal_of_id: 1, accounting_attribute: "REVERSAL" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.listColumnsApi.all).mockResolvedValue([]);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools);
  // 余额与汇总一次批量取回（服务端 Decimal 聚合），合计按两池同额计。
  resolveMock(vi.mocked(catalog.poolsApi.balances), {
    items: pools.map((pool) => ({ ...balance, pool_id: pool.id, pool_code: pool.code })),
    totals: { cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00", owned_cash_balance: "1600.00" },
  });
  resolveMock(vi.mocked(catalog.depositsApi.list), deposits);
  // 合计由服务端返回，桩里同步给出，避免卡片落回 0.00。
  resolveMock(vi.mocked(catalog.cashflowsApi.list), { items: cashflows, total: cashflows.length, total_in: "800.00", total_out: "1000.00" });
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
  const option = await within(current).findByTitle(title);
  await ui.click(option);
}

function modalContent(): HTMLElement {
  return document.querySelector(".ant-modal-content") as HTMLElement;
}

describe("FundsPage：资金写路径深覆盖", () => {
  it("新增流水可选关联订单，未填写则保持全局流水", async () => {
    resolveMockOnce(vi.mocked(catalog.cashflowsApi.create), { id: 100 });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    await ui.click(await screen.findByRole("button", { name: /新增流水/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await ui.type(modal.querySelector("#occurred_on") ?? modal, "2026-10-17");
    await ui.type(modal.querySelector("#category") ?? modal, "SELL");
    await ui.type(modal.querySelector("#amount") ?? modal, "300.00");
    await ui.type(modal.querySelector("#note") ?? modal, "测试收入");
    expect(within(modal).getByLabelText("关联订单")).toBeInTheDocument();
    await ui.type(within(modal).getByLabelText("关联订单"), "42");
    await ui.click(screen.getByRole("button", { name: /提交/ }));
    await waitFor(() => expect(vi.mocked(catalog.cashflowsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(catalog.cashflowsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.direction).toBe("IN");
    expect(payload.order_id).toBe(42);
  });


  it("已入账且无关联流水 → 冲销调用 cashflowsApi.reverse", async () => {
    const approved = [{ id: 7, flow_no: "CF-A-07", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "300.00", source: "MANUAL", accounting_attribute: "SELF_DIRECT_COST", status: "APPROVED" }];
    resolveMock(vi.mocked(catalog.cashflowsApi.list), { items: approved, total: approved.length, total_in: "0.00", total_out: "300.00" });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    await ui.click(screen.getByRole("tab", { name: "支出明细" }));
    await ui.click(await screen.findByRole("button", { name: /冲\s*销/ }));
    const modal = modalContent();
    await ui.type(modal.querySelector("#reversed_on") ?? modal, "2026-10-18");
    await ui.type(modal.querySelector("#reason") ?? modal, "重复入账");
    await ui.click(screen.getByRole("button", { name: /确认冲销/ }));
    await waitFor(() => expect(vi.mocked(catalog.cashflowsApi.reverse)).toHaveBeenCalled());
    const [id, payload] = vi.mocked(catalog.cashflowsApi.reverse).mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(7);
    expect(payload.reason).toBe("重复入账");
  });

  it("冲销成功后原流水不再提供重复冲销入口，并展示反向流水", async () => {
    const approved = { id: 7, flow_no: "CF-A-07", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "300.00", source: "MANUAL", accounting_attribute: "SELF_DIRECT_COST", status: "APPROVED" };
    const reversal = { ...approved, id: 8, flow_no: "CF-REV-08", category: "REVERSAL", direction: "IN", accounting_attribute: "REVERSAL", reversal_of_id: 7 };
    let mainListCalls = 0;
    vi.mocked(catalog.cashflowsApi.list).mockImplementation(async (params) => {
      if (params?.direction) return { items: [], total: 0, total_in: "0.00", total_out: "0.00" };
      mainListCalls += 1;
      return mainListCalls === 1
        ? { items: [approved], total: 1, total_in: "0.00", total_out: "300.00" }
        : { items: [approved, reversal], total: 2, total_in: "300.00", total_out: "300.00" };
    });
    resolveMockOnce(vi.mocked(catalog.cashflowsApi.reverse), reversal);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    await ui.click(screen.getByRole("tab", { name: "支出明细" }));
    await screen.findByText("CF-A-07");
    await ui.click(await screen.findByRole("button", { name: /冲\s*销/ }));
    const modal = modalContent();
    await ui.type(modal.querySelector("#reversed_on") ?? modal, "2026-10-18");
    await ui.type(modal.querySelector("#reason") ?? modal, "重复入账");
    await ui.click(screen.getByRole("button", { name: /确认冲销/ }));

    await waitFor(() => expect(vi.mocked(catalog.cashflowsApi.reverse)).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: /^冲\s*销$/ })).toBeNull());
    expect(screen.getByText("CF-REV-08")).toBeInTheDocument();
  });

  it("冲销失败时保留弹窗和表单，并显示可重试错误", async () => {
    const approved = [{ id: 7, flow_no: "CF-A-07", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "300.00", source: "MANUAL", accounting_attribute: "SELF_DIRECT_COST", status: "APPROVED" }];
    vi.mocked(catalog.cashflowsApi.list).mockImplementation(async (params) => params?.direction
      ? { items: [], total: 0, total_in: "0.00", total_out: "0.00" }
      : { items: approved, total: 1, total_in: "0.00", total_out: "300.00" });
    vi.mocked(catalog.cashflowsApi.reverse).mockRejectedValueOnce(new Error("冲销接口暂时不可用"));
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    await ui.click(screen.getByRole("tab", { name: "支出明细" }));
    await screen.findByText("CF-A-07");
    await ui.click(await screen.findByRole("button", { name: /冲\s*销/ }));
    const modal = modalContent();
    await ui.type(modal.querySelector("#reversed_on") ?? modal, "2026-10-18");
    await ui.type(modal.querySelector("#reason") ?? modal, "重复入账");
    await ui.click(screen.getByRole("button", { name: /确认冲销/ }));

    await waitFor(() => expect(screen.getByText(/冲销接口暂时不可用/)).toBeInTheDocument());
    expect(modal.querySelector("#reason")).toHaveValue("重复入账");
    expect(screen.getByRole("button", { name: /确认冲销/ })).toBeEnabled();
  });

  it("资金池划转提交调用 transfersApi.create", async () => {
    resolveMockOnce(vi.mocked(catalog.transfersApi.create), { id: 200, transfer_id: "TRF-200" });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(await screen.findByRole("button", { name: /资金池划转/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await pickSelect(modal, 1, /押金池/);
    await ui.type(modal.querySelector("#amount") ?? modal, "100.00");
    await ui.type(modal.querySelector("#note") ?? modal, "调拨测试");
    await ui.click(screen.getByRole("button", { name: /确认划转/ }));
    await waitFor(() => expect(vi.mocked(catalog.transfersApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(catalog.transfersApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.source_pool_id).toBe(1);
    expect(payload.target_pool_id).toBe(2);
    expect(payload.amount).toBe("100.00");
  });

  it("超出转出资金池可用余额时前端拦截且不发起划转", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(await screen.findByRole("button", { name: /资金池划转/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await pickSelect(modal, 1, /押金池/);
    await ui.type(modal.querySelector("#amount") ?? modal, "700.01");
    await ui.click(screen.getByRole("button", { name: /确认划转/ }));

    await waitFor(() => expect(screen.getByText(/可用余额不足/)).toBeInTheDocument());
    expect(modal.querySelector("#amount")).toHaveValue("700.01");
    expect(vi.mocked(catalog.transfersApi.create)).not.toHaveBeenCalled();
  });

  it("对账状态列显示未核销/已核销（对齐后端 ReconciliationStatus 语义）", async () => {
    vi.mocked(catalog.reconciliationsApi.list).mockResolvedValue([
      { id: 31, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN" },
      { id: 32, pool_id: 1, reconciled_on: "2026-10-17", account_label: "经营账户", system_balance: "800.00", statement_balance: "800.00", difference: "0.00", status: "RESOLVED" },
    ]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    expect(await screen.findByText("未核销")).toBeInTheDocument();
    expect(screen.getByText("已核销")).toBeInTheDocument();
    // 不再出现质量域语义的「未结算/已处置」
    expect(screen.queryByText("已处置")).toBeNull();
  });



  it("新增对账提交：未达流水 ID 按逗号解析为数组", async () => {
    resolveMockOnce(vi.mocked(catalog.reconciliationsApi.create), { id: 210 });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /新增对账/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await ui.clear(modal.querySelector("#reconciled_on") ?? modal);
    await ui.type(modal.querySelector("#reconciled_on") ?? modal, "2026-10-18");
    await ui.type(modal.querySelector("#account_label") ?? modal, "经营账户");
    await ui.type(modal.querySelector("#statement_balance") ?? modal, "900.00");
    await ui.type(modal.querySelector("#unmatched_flow_ids") ?? modal, "1, 2");
    await ui.type(modal.querySelector("#note") ?? modal, "对账测试");
    await ui.click(screen.getByRole("button", { name: /提交对账/ }));
    await waitFor(() => expect(vi.mocked(catalog.reconciliationsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(catalog.reconciliationsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.unmatched_flow_ids).toEqual([1, 2]);
  });

  it("新增对账预检：命中唯一约束（池+账户+日期）时阻断提交并提示调整", async () => {
    const warningSpy = vi.spyOn(message, "warning").mockReturnValue(undefined as never);
    // 初始加载即带入一条「同池+同日期+同账户」记录，模拟重复对账场景。
    vi.mocked(catalog.reconciliationsApi.list).mockResolvedValueOnce([
      { id: 30, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN" },
    ]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
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
      expect(warningSpy).toHaveBeenCalledWith("同一资金池、对账账户和日期只能对账一次，请调整对账日期或账户"),
    );
    expect(vi.mocked(catalog.reconciliationsApi.create)).not.toHaveBeenCalled();
    warningSpy.mockRestore();
  });

  it("对账页展示系统余额口径说明", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    expect(await screen.findByText(/系统余额口径：截至对账日期「已入账」流水的累计/)).toBeInTheDocument();
  });

  it("总览统计卡的自有权益取服务端汇总（不再前端按 ownership 自算）", async () => {
    // 归属判定（OWNED 计入权益、CUSTODY/THIRD_PART 只计头寸）已在后端
    // pool_balance_summary 里完成，契约由 backend tests/v1/test_pool_balances_batch.py 守；
    // 这里只验前端确实展示服务端给的数，而不是自己挑池相加。
    vi.mocked(catalog.poolsApi.list).mockResolvedValue([
      { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "OWNED", status: "ACTIVE" },
      { id: 2, code: "POOL-B", name: "托管池", pool_type: "DEPOSIT", ownership: "CUSTODY", status: "ACTIVE" },
    ]);
    resolveMock(vi.mocked(catalog.poolsApi.balances), {
      items: [
        { ...balance, pool_id: 1, pool_code: "POOL-A" },
        { ...balance, pool_id: 2, pool_code: "POOL-B" },
      ],
      totals: { cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00", owned_cash_balance: "800.00" },
    });
    renderLight(<FundsPage />, { user: "admin" });
    expect(await screen.findByText("自有权益合计")).toBeInTheDocument();
    // 两池现金头寸各 800.00，但只有 OWNED 的 POOL-A 计入 → 服务端给出 800.00。
    const card = screen.getByText("自有权益合计").closest(".ui-stat");
    expect(within(card as HTMLElement).getByText("800.00")).toBeInTheDocument();
    // 口径说明：CUSTODY/THIRD_PART 只计头寸不计权益。
    expect(screen.getByText(/自有权益仅计归属为「自有」的池/)).toBeInTheDocument();
  });

  it("对账差异核销提交调用 reconciliationsApi.resolve", async () => {
    vi.mocked(catalog.reconciliationsApi.list).mockResolvedValueOnce([{
      id: 21, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN", unmatched_flow_ids: [1],
    }]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /核销/ }));
    const modal = modalContent();
    await ui.type(modal.querySelector("#reason") ?? modal, "已补录漏记流水");
    await ui.click(screen.getByRole("button", { name: /确认核销/ }));
    await waitFor(() => expect(vi.mocked(catalog.reconciliationsApi.resolve)).toHaveBeenCalledWith(21, "已补录漏记流水"));
  });

  it("押金释放提交调用 depositsApi.release", async () => {
    resolveMockOnce(vi.mocked(catalog.depositsApi.release), { id: 11 });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "工作室支出" }));
    await ui.click(await screen.findByRole("button", { name: /释\s*放/ }));
    const modal = modalContent();
    await ui.type(modal.querySelector("#amount") ?? modal, "100.00");
    await ui.type(modal.querySelector("#released_on") ?? modal, "2026-10-19");
    await ui.click(screen.getByRole("button", { name: /确认释放/ }));
    await waitFor(() => expect(vi.mocked(catalog.depositsApi.release)).toHaveBeenCalled());
    const [id, payload] = vi.mocked(catalog.depositsApi.release).mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(11);
    expect(payload.amount).toBe("100.00");
  });
});
