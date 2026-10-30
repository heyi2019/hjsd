import { appMessage as message } from "../shared/ui/appFeedback";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { FundsPage, deriveCashflowNature } from "./FundsPage";
import { resolveMock, resolveMockOnce } from "../test/mock-api";

import * as catalog from "../shared/api/catalog";
import { seedOptionSets, seedOrderFormFields } from "../test/formFieldsSeed";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  seedOrderFormFields(catalog);
  seedOptionSets(catalog);
});

vi.mock("../shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api/catalog")>();
  const METHODS = [
    "list", "get", "create", "update", "patch", "post", "postEvent", "remove",
    "setStatus", "setActive", "resolve", "release", "loss", "repair", "settle", "approve", "reject",
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
const balance = {
  income: "1000.00",
  expense: "200.00",
  cash_balance: "800.00",
  deposit_held: "100.00",
  available: "700.00",
};
const deposits = [
  { id: 11, pool_id: 1, counterparty_id: 99, source_order_id: 7, paid_amount: "500.00", returned_amount: "200.00", status: "HELD", expected_release_on: "2026-11-01" },
];
const cashflows = [
  { id: 1, flow_no: "HS0001-CF-BUY-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "500.00", order_no: "HS0001", source: "ORDER_EVENT", fund_nature: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST" },
  { id: 2, flow_no: "HS0001-CF-SELL-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_IN", category: "SELL", direction: "IN", amount: "800.00", order_no: "HS0001", source: "ORDER_EVENT", fund_nature: "BUSINESS", accounting_attribute: "SELF_REVENUE" },
  { id: 3, flow_no: "HS0001-CF-CXL-01", pool_id: 1, occurred_on: "2026-10-18", nature: "BUSINESS_OUT", category: "CXL", direction: "OUT", amount: "500.00", order_no: "HS0001", source: "ORDER_EVENT", status: "APPROVED", reviewed_by: "admin", reviewed_at: "2026-10-18T09:30:00", reversal_of_id: 1, fund_nature: "BUSINESS", accounting_attribute: "REVERSAL" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools);
  resolveMock(vi.mocked(catalog.poolsApi.balance), balance);
  resolveMock(vi.mocked(catalog.depositsApi.list), deposits);
  resolveMock(vi.mocked(catalog.cashflowsApi.list), { items: cashflows, total: cashflows.length });
  vi.mocked(catalog.periodLocksApi.list).mockResolvedValue([]);
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
  it("新增流水（本方经营 + 收入）→ nature=BUSINESS_IN", async () => {
    resolveMockOnce(vi.mocked(catalog.cashflowsApi.create), { id: 100 });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    await ui.click(await screen.findByRole("button", { name: /新增流水/ }));
    const modal = modalContent();
    await pickSelect(modal, 0, /经营主池/);
    await ui.type(modal.querySelector("#occurred_on") ?? modal, "2026-10-17");
    await ui.type(modal.querySelector("#category") ?? modal, "SELL");
    await ui.type(modal.querySelector("#amount") ?? modal, "300.00");
    await ui.type(modal.querySelector("#note") ?? modal, "测试收入");
    await ui.click(screen.getByRole("button", { name: /提交/ }));
    await waitFor(() => expect(vi.mocked(catalog.cashflowsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(catalog.cashflowsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.nature).toBe("BUSINESS_IN");
    expect(payload.fund_nature).toBe("BUSINESS");
  });

  // nature 口径矩阵走纯函数单测（deriveCashflowNature，毫秒级），不再为每个口径
  // 重复整页挂载 + 弹窗全链路（原 3 条用例各 ~1s，2026-10-27 实测重构）；
  // 弹窗→提交→payload 的接线正确性由下方「本方经营 + 收入」1 条全链路用例守护。
  it("nature 口径矩阵：外部/内部/本方经营按资金性质与流向推导", () => {
    expect(deriveCashflowNature("EXTERNAL", "IN")).toBe("EXTERNAL_IN");
    expect(deriveCashflowNature("EXTERNAL", "OUT")).toBe("EXTERNAL_IN");
    expect(deriveCashflowNature("INTERNAL", "OUT")).toBe("INTERNAL");
    expect(deriveCashflowNature("INTERNAL", "IN")).toBe("INTERNAL");
    expect(deriveCashflowNature("BUSINESS", "IN")).toBe("BUSINESS_IN");
    expect(deriveCashflowNature("BUSINESS", "OUT")).toBe("BUSINESS_OUT");
  });





  it("已入账且无关联流水 → 冲销调用 cashflowsApi.reverse", async () => {
    const approved = [{ id: 7, flow_no: "CF-A-07", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "300.00", source: "MANUAL", fund_nature: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST", status: "APPROVED" }];
    resolveMock(vi.mocked(catalog.cashflowsApi.list), { items: approved, total: approved.length });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    await ui.click(screen.getByRole("tab", { name: "流水" }));
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

  it("资金池划转提交调用 transfersApi.create", async () => {
    resolveMockOnce(vi.mocked(catalog.transfersApi.create), { id: 200, transfer_id: "TRF-200" });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
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

  it("对账状态列显示未核销/已核销（对齐后端 ReconciliationStatus 语义）", async () => {
    vi.mocked(catalog.reconciliationsApi.list).mockResolvedValue([
      { id: 31, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN" },
      { id: 32, pool_id: 1, reconciled_on: "2026-10-17", account_label: "经营账户", system_balance: "800.00", statement_balance: "800.00", difference: "0.00", status: "RESOLVED" },
    ]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    expect(await screen.findByText("未核销")).toBeInTheDocument();
    expect(screen.getByText("已核销")).toBeInTheDocument();
    // 不再出现质量域语义的「未结算/已处置」
    expect(screen.queryByText("已处置")).toBeNull();
  });



  it("新增对账提交：未达流水 ID 按逗号解析为数组", async () => {
    resolveMockOnce(vi.mocked(catalog.reconciliationsApi.create), { id: 210 });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByText(/POOL-A/);
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
    await screen.findByText(/POOL-A/);
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
    await screen.findByText(/POOL-A/);
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    expect(await screen.findByText(/系统余额口径：截至对账日期「已入账」流水的累计/)).toBeInTheDocument();
  });

  it("总览统计卡展示自有权益合计（仅 OWNED 归属池计入）", async () => {
    // 注意用 mockResolvedValue 而非 Once：Tabs 不卸载非激活面板，池列表会被多个面板消费。
    vi.mocked(catalog.poolsApi.list).mockResolvedValue([
      { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "OWNED", status: "ACTIVE" },
      { id: 2, code: "POOL-B", name: "托管池", pool_type: "DEPOSIT", ownership: "CUSTODY", status: "ACTIVE" },
    ]);
    renderLight(<FundsPage />, { user: "admin" });
    expect(await screen.findByText("自有权益合计")).toBeInTheDocument();
    // balance mock 两池现金头寸均为 800.00，仅 POOL-A（OWNED）计入权益 → 800.00。
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
    await screen.findByText(/POOL-A/);
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
    await screen.findByText(/POOL-A/);
    await ui.click(screen.getByRole("tab", { name: "押金" }));
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
