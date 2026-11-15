import { appMessage as message } from "@/shared/ui/appFeedback";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { FundsPage, deriveCashflowNature } from "@/pools/FundsPage";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";

import { cashflowsApi } from "@/shared/api/cashflows.api";
import { depositsApi } from "@/shared/api/installments.api";
import { listColumnsApi, ordersApi } from "@/shared/api/orders.api";
import { poolsApi, reconciliationsApi, transfersApi } from "@/shared/api/pools.api";
import { seedOptionSets, seedOrderFormFields } from "@fixtures/formFieldsSeed";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  seedOrderFormFields();
  seedOptionSets();
});

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

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
  { id: 1, flow_no: "HS0001-CF-BUY-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "500.00", order_no: "HS0001", source: "ORDER_EVENT", fund_nature: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST" },
  { id: 2, flow_no: "HS0001-CF-SELL-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_IN", category: "SELL", direction: "IN", amount: "800.00", order_no: "HS0001", source: "ORDER_EVENT", fund_nature: "BUSINESS", accounting_attribute: "SELF_REVENUE" },
  { id: 3, flow_no: "HS0001-CF-CXL-01", pool_id: 1, occurred_on: "2026-10-18", nature: "BUSINESS_OUT", category: "CXL", direction: "OUT", amount: "500.00", order_no: "HS0001", source: "ORDER_EVENT", status: "APPROVED", reviewed_by: "admin", reviewed_at: "2026-10-18T09:30:00", reversal_of_id: 1, fund_nature: "BUSINESS", accounting_attribute: "REVERSAL" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listColumnsApi.all).mockResolvedValue([]);
  vi.mocked(poolsApi.list).mockResolvedValue(pools);
  // 余额与汇总一次批量取回（服务端 Decimal 聚合），合计按两池同额计。
  resolveMock(vi.mocked(poolsApi.balances), {
    items: pools.map((pool) => ({ ...balance, pool_id: pool.id, pool_code: pool.code })),
    totals: { pool_count: 2, cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00", owned_cash_balance: "1600.00" },
  });
  resolveMock(vi.mocked(depositsApi.list), deposits);
  // 合计由服务端返回，桩里同步给出，避免卡片落回 0.00。
  resolveMock(vi.mocked(cashflowsApi.list), { items: cashflows, total: cashflows.length, total_in: "800.00", total_out: "1000.00" });
  vi.mocked(reconciliationsApi.list).mockResolvedValue([]);
  vi.mocked(ordersApi.list).mockResolvedValue([]);
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
  it("新增流水（本方经营 + 收入）→ nature=BUSINESS_IN", async () => {
    resolveMockOnce(vi.mocked(cashflowsApi.create), { id: 100 });
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
    await ui.click(screen.getByRole("button", { name: /提交/ }));
    await waitFor(() => expect(vi.mocked(cashflowsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(cashflowsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.nature).toBe("BUSINESS_IN");
    expect(payload.fund_nature).toBe("BUSINESS");
  });

  // nature 口径矩阵走纯函数单测（deriveCashflowNature，毫秒级），不再为每个口径
  // 重复整页挂载 + 弹窗全链路（原 3 条用例各 ~1s，2026-10-27 实测重构）；
  // 弹窗→提交→payload 的接线正确性由下方「本方经营 + 收入」1 条全链路用例守护。
  // 口径对齐后端 create_cashflow（finance/cashflows.py:97-105）：OUT 一律 BUSINESS_OUT，
  // 只有 IN 才按资金性质二分；独立流水禁 INTERNAL（submitCashflow 前置拦截）。
  it("nature 口径矩阵：支出一律 BUSINESS_OUT，收入按资金性质二分", () => {
    expect(deriveCashflowNature("EXTERNAL", "IN")).toBe("EXTERNAL_IN");
    expect(deriveCashflowNature("EXTERNAL", "OUT")).toBe("BUSINESS_OUT");
    expect(deriveCashflowNature("INTERNAL", "OUT")).toBe("BUSINESS_OUT");
    expect(deriveCashflowNature("INTERNAL", "IN")).toBe("BUSINESS_IN");
    expect(deriveCashflowNature("BUSINESS", "IN")).toBe("BUSINESS_IN");
    expect(deriveCashflowNature("BUSINESS", "OUT")).toBe("BUSINESS_OUT");
  });

  it("独立流水选内部调拨 → 提交被前端拦截，不发必 422 的请求", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    await ui.click(await screen.findByRole("button", { name: /新增流水/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    // 资金性质 dropdown 序号 2（弹窗 select 顺序：0 资金池 / 1 收支方向 / 2 资金性质 / 3 核算属性）选「内部调拨」
    await pickSelect(modal, 2, /内部调拨/);
    await ui.type(modal.querySelector("#occurred_on") ?? modal, "2026-10-17");
    await ui.type(modal.querySelector("#category") ?? modal, "TRANSFER");
    await ui.type(modal.querySelector("#amount") ?? modal, "300.00");
    await ui.type(modal.querySelector("#note") ?? modal, "内部调拨");
    await ui.click(screen.getByRole("button", { name: /提交/ }));
    await waitFor(() => expect(vi.mocked(cashflowsApi.create)).not.toHaveBeenCalled());
    expect(await screen.findByText(/内部调拨请通过/)).toBeInTheDocument();
  });





  it("已入账且无关联流水 → 冲销调用 cashflowsApi.reverse", async () => {
    const approved = [{ id: 7, flow_no: "CF-A-07", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "300.00", source: "MANUAL", fund_nature: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST", status: "APPROVED" }];
    resolveMock(vi.mocked(cashflowsApi.list), { items: approved, total: approved.length, total_in: "0.00", total_out: "300.00" });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    await ui.click(await screen.findByRole("button", { name: /冲\s*销/ }));
    const modal = modalContent();
    await ui.type(modal.querySelector("#reversed_on") ?? modal, "2026-10-18");
    await ui.type(modal.querySelector("#reason") ?? modal, "重复入账");
    await ui.click(screen.getByRole("button", { name: /确认冲销/ }));
    await waitFor(() => expect(vi.mocked(cashflowsApi.reverse)).toHaveBeenCalled());
    const [id, payload] = vi.mocked(cashflowsApi.reverse).mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(7);
    expect(payload.reason).toBe("重复入账");
  });

  it("冲销成功后原流水不再提供重复冲销入口，并展示反向流水", async () => {
    const approved = { id: 7, flow_no: "CF-A-07", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "300.00", source: "MANUAL", fund_nature: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST", status: "APPROVED" };
    const reversal = { ...approved, id: 8, flow_no: "CF-REV-08", category: "REVERSAL", direction: "IN", accounting_attribute: "REVERSAL", reversal_of_id: 7 };
    let mainListCalls = 0;
    vi.mocked(cashflowsApi.list).mockImplementation(async (params) => {
      if (params?.direction) return { items: [], total: 0, total_in: "0.00", total_out: "0.00" };
      mainListCalls += 1;
      return mainListCalls === 1
        ? { items: [approved], total: 1, total_in: "0.00", total_out: "300.00" }
        : { items: [approved, reversal], total: 2, total_in: "300.00", total_out: "300.00" };
    });
    resolveMockOnce(vi.mocked(cashflowsApi.reverse), reversal);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    await screen.findByText("CF-A-07");
    await ui.click(await screen.findByRole("button", { name: /冲\s*销/ }));
    const modal = modalContent();
    await ui.type(modal.querySelector("#reversed_on") ?? modal, "2026-10-18");
    await ui.type(modal.querySelector("#reason") ?? modal, "重复入账");
    await ui.click(screen.getByRole("button", { name: /确认冲销/ }));

    await waitFor(() => expect(vi.mocked(cashflowsApi.reverse)).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: /^冲\s*销$/ })).toBeNull());
    expect(screen.getByText("CF-REV-08")).toBeInTheDocument();
  });

  it("冲销失败时保留弹窗和表单，并显示可重试错误", async () => {
    const approved = [{ id: 7, flow_no: "CF-A-07", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "300.00", source: "MANUAL", fund_nature: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST", status: "APPROVED" }];
    vi.mocked(cashflowsApi.list).mockImplementation(async (params) => params?.direction
      ? { items: [], total: 0, total_in: "0.00", total_out: "0.00" }
      : { items: approved, total: 1, total_in: "0.00", total_out: "300.00" });
    vi.mocked(cashflowsApi.reverse).mockRejectedValueOnce(new Error("冲销接口暂时不可用"));
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
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
    resolveMockOnce(vi.mocked(transfersApi.create), { id: 200, transfer_id: "TRF-200" });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(await screen.findByRole("button", { name: /资金池划转/ }));
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
    expect(vi.mocked(transfersApi.create)).not.toHaveBeenCalled();
  });

  it("对账状态列显示未核销/已核销（对齐后端 ReconciliationStatus 语义）", async () => {
    vi.mocked(reconciliationsApi.list).mockResolvedValue([
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
    resolveMockOnce(vi.mocked(reconciliationsApi.create), { id: 210 });
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
    await waitFor(() => expect(vi.mocked(reconciliationsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(reconciliationsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.unmatched_flow_ids).toEqual([1, 2]);
  });

  it("新增对账预检：命中唯一约束（池+账户+日期）时阻断提交并提示调整", async () => {
    const warningSpy = vi.spyOn(message, "warning").mockReturnValue(undefined as never);
    // 初始加载即带入一条「同池+同日期+同账户」记录，模拟重复对账场景。
    vi.mocked(reconciliationsApi.list).mockResolvedValueOnce([
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
    expect(vi.mocked(reconciliationsApi.create)).not.toHaveBeenCalled();
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
    vi.mocked(poolsApi.list).mockResolvedValue([
      { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "OWNED", status: "ACTIVE" },
      { id: 2, code: "POOL-B", name: "托管池", pool_type: "DEPOSIT", ownership: "CUSTODY", status: "ACTIVE" },
    ]);
    resolveMock(vi.mocked(poolsApi.balances), {
      items: [
        { ...balance, pool_id: 1, pool_code: "POOL-A" },
        { ...balance, pool_id: 2, pool_code: "POOL-B" },
      ],
      totals: { pool_count: 2, cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00", owned_cash_balance: "800.00" },
    });
    renderLight(<FundsPage />, { user: "admin" });
    expect(await screen.findByText("自有权益合计")).toBeInTheDocument();
    // 两池现金头寸各 800.00，但只有 OWNED 的 POOL-A 计入 → 服务端给出 800.00。
    const card = screen.getByText("自有权益合计").closest(".ui-stat");
    expect(within(card as HTMLElement).getByText("800.00")).toBeInTheDocument();
    expect(screen.queryByText(/自有权益仅计归属为「自有」的池/)).not.toBeInTheDocument();
  });

  it("对账差异核销提交调用 reconciliationsApi.resolve", async () => {
    vi.mocked(reconciliationsApi.list).mockResolvedValueOnce([{
      id: 21, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN", unmatched_flow_ids: [1],
    }]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /核销/ }));
    const modal = modalContent();
    await ui.type(modal.querySelector("#reason") ?? modal, "已补录漏记流水");
    await ui.click(screen.getByRole("button", { name: /确认核销/ }));
    await waitFor(() => expect(vi.mocked(reconciliationsApi.resolve)).toHaveBeenCalledWith(21, "已补录漏记流水"));
  });

  it("押金释放提交调用 depositsApi.release", async () => {
    resolveMockOnce(vi.mocked(depositsApi.release), { id: 11 });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "工作室支出" }));
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
