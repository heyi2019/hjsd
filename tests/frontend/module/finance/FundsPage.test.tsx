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
    "reverse", "close", "convert", "detail", "allocations", "setAllocations", "cancel", "voidRecord",
    "supersede", "expireSweep",
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
  { id: 1, status: "APPROVED", flow_no: "HS0001-CF-BUY-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "500.00", order_no: "HS0001", source: "ORDER_EVENT", fund_nature: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST" },
  { id: 2, status: "APPROVED", flow_no: "HS0001-CF-SELL-01", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_IN", category: "SELL", direction: "IN", amount: "800.00", order_no: "HS0001", source: "ORDER_EVENT", fund_nature: "BUSINESS", accounting_attribute: "SELF_REVENUE" },
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
  resolveMock(vi.mocked(catalog.cashflowsApi.list), { items: cashflows, total: cashflows.length, total_in: "800.00", total_out: "500.00" });
  vi.mocked(catalog.reconciliationsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([]);
  // 内嵌 RebatesPanel 本套件不覆盖：同步抛错，与改造前「工厂未导出 rebatesApi」的行为一致
  vi.mocked(catalog.rebatesApi.list).mockImplementation(() => {
    throw new Error("rebatesApi 不在本套件覆盖范围");
  });
});
async function pickSelect(modal: HTMLElement, index: number, title: RegExp) {
  await ui.click(modal.querySelectorAll(".ant-select-selector")[index] as Element);
  // 多个 Select 的下拉都挂在 body 上且历史下拉不销毁 → 必须限定在「最后打开的那个」
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  const current = dropdowns[dropdowns.length - 1] as HTMLElement;
  const option = await within(current).findByTitle(title);
  await ui.click(option);
}

describe("FundsPage：资金池卡片", () => {
  it("资金池列表按列表字段配置排序", async () => {
    vi.mocked(catalog.listColumnsApi.all).mockResolvedValueOnce([{
      code: "FUND_POOLS",
      label: "资金中心·资金池",
      columns: [
        { key: "available", label: "可用余额", locked: false, is_visible: true, sort_order: 0 },
        { key: "pool_code", label: "资金池", locked: false, is_visible: true, sort_order: 10 },
      ],
    }]);

    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    const headers = Array.from(document.querySelectorAll(".ant-table-thead tr:first-child th"))
      .map((header) => header.textContent?.trim())
      .filter(Boolean);
    expect(headers[0]).toBe("可用余额");
  });

  it("渲染资金池与可用余额", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    expect(await screen.findByRole("cell", { name: /POOL-A/ })).toBeInTheDocument();
    expect(screen.getAllByText("700.00").length).toBeGreaterThanOrEqual(1);
  });

  it("后端不可达 → 错误条落地", async () => {
    vi.mocked(catalog.poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<FundsPage />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("FE-228：资金池主数据失败时总览不可用且划转入口禁用", async () => {
    vi.mocked(catalog.poolsApi.list).mockRejectedValueOnce(new Error("pools down"));
    renderLight(<FundsPage />, { user: "admin" });

    expect(await screen.findByText("资金池卡片")).toBeInTheDocument();
    expect(screen.getByText("现金头寸合计").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByRole("button", { name: /资金池划转/ })).toBeDisabled();
  });

  it("FE-261：完整资金划转配对后不显示单边异常", async () => {
    vi.mocked(catalog.cashflowsApi.list).mockResolvedValueOnce({
      items: [
        { ...cashflows[0], id: 31, transfer_id: "TRF-PAIRED-01", direction: "OUT" },
        { ...cashflows[0], id: 32, transfer_id: "TRF-PAIRED-01", direction: "IN", pool_id: 2 },
      ],
      total: 2,
    } as never);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "异常" }));

    expect(await screen.findByText("暂无单边划转异常")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /修复划转/ })).not.toBeInTheDocument();
  });

  it("FE-229：资金流水失败时统计不可用、筛选和新增入口禁用", async () => {
    vi.mocked(catalog.cashflowsApi.list).mockRejectedValueOnce(new Error("cashflows down"));
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));

    expect(await screen.findByText("资金流水数据不可用，请点击“查询”或页面顶部的“重新加载”。")).toBeInTheDocument();
    expect(screen.getByText("总收入").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByRole("button", { name: /新增流水/ })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "流水方向" })).toBeDisabled();
  });

  it("FE-230：对账失败时显示明确空态并禁用新增", async () => {
    vi.mocked(catalog.reconciliationsApi.list).mockRejectedValueOnce(new Error("reconciliations down"));
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));

    expect(await screen.findByText("资金对账数据不可用，请点击重新加载")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增对账/ })).toBeDisabled();
  });
});

describe("FundsPage：押金占用", () => {
  it("删除独立押金页，押金逻辑并入工作室支出", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });

    expect(screen.queryByRole("tab", { name: "押金" })).not.toBeInTheDocument();
    await ui.click(screen.getByRole("tab", { name: "工作室支出" }));
    // 断言「押金占用」这一整块（卡片标题 + 新增入口）落在工作室支出面板内，而不是靠
    // 别处（如已卸载的总览 StatRow）凑出现次数。Tabs 开了 destroyOnHidden，未激活面板
    // 不会留在 DOM，故此处必须是面板内的唯一一份。
    const studioPanel = await screen.findByRole("tabpanel");
    expect(within(studioPanel).getByText("押金占用")).toBeInTheDocument();
    expect(within(studioPanel).getByRole("button", { name: /新增占用/ })).toBeInTheDocument();
  });

  it("押金列表渲染金额与剩余（占用-已释放）", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "工作室支出" }));
    expect(screen.queryByText("押金编号")).not.toBeInTheDocument();
    expect(screen.getAllByText("300.00").length).toBeGreaterThanOrEqual(1); // 500-200
  });

  it("押金明细展示对手方、来源订单和预计释放日", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "工作室支出" }));
    expect(screen.getByText("#99")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
    expect(screen.getByText("2026-11-01")).toBeInTheDocument();
  });
});

describe("FundsPage：资金流水", () => {
  it("资金流水录入不再提供资金池账户选择", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    await ui.click(await screen.findByRole("button", { name: /新增流水/ }));

    expect(screen.queryByText("资金池账户")).not.toBeInTheDocument();
  });

  it("展示订单号、收支明细及总收入/总支出", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    expect(screen.getByText("HS0001-CF-BUY-01")).toBeInTheDocument();
    expect(screen.getAllByText("HS0001").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("总收入")).toBeInTheDocument();
    expect(screen.getByText("总支出")).toBeInTheDocument();
    expect(screen.getAllByText("本方经营").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("自营直接成本")).toBeInTheDocument();
    expect(screen.getByText("自营收入")).toBeInTheDocument();
    expect(screen.getAllByText("800.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("500.00").length).toBeGreaterThanOrEqual(1);
  });

  it("总收入/总支出取服务端合计，不再对当页明细求和", async () => {
    // 明细只回当页（limit 上限 2000），合计必须来自服务端聚合：
    // 故意让合计与两条明细之和（IN 800 / OUT 500）不同，证明卡片没在本地累加。
    vi.mocked(catalog.cashflowsApi.list).mockResolvedValue({
      items: cashflows,
      total: 5000,
      total_in: "123456.78",
      total_out: "87654.32",
    });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));

    expect((await screen.findByText("总收入")).closest(".ui-stat")).toHaveTextContent("123,456.78");
    expect(screen.getByText("总支出").closest(".ui-stat")).toHaveTextContent("87,654.32");
  });

  it("流水支持按订单号、流水号或备注关键词筛选", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    const search = screen.getByLabelText("流水搜索");
    await ui.type(search, "SELL");
    expect(screen.getByText("HS0001-CF-SELL-01")).toBeInTheDocument();
    expect(screen.queryByText("HS0001-CF-BUY-01")).not.toBeInTheDocument();
  });

  it("流水筛选区使用紧凑布局容器", async () => {
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "流水" }));
    expect(document.querySelector(".funds-cashflow-filters")).toBeInTheDocument();
  });
});

// —— 原 FundsPage.write.test.tsx：同页同 mock 契约（METHODS 已取并集），
// 独立成文件只是让同样的 jsdom+antd 启动多付一次。
describe("FundsPage：资金写路径", () => {
  it("新增押金占用提交后回传金额与日期", async () => {
    resolveMockOnce(vi.mocked(catalog.depositsApi.create), { id: 12 });
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "工作室支出" }));
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
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "工作室支出" }));
    await screen.findByText("300.00");
    expect(screen.getAllByRole("button", { name: /释\s*放/ }).length).toBeGreaterThanOrEqual(1);
  });

  it("对账可以钻取查看未达流水", async () => {
    vi.mocked(catalog.reconciliationsApi.list).mockResolvedValueOnce([{
      id: 21, pool_id: 1, reconciled_on: "2026-10-18", account_label: "经营账户", system_balance: "800.00", statement_balance: "900.00", difference: "100.00", status: "OPEN", unmatched_flow_ids: [1],
    }]);
    renderLight(<FundsPage />, { user: "admin" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));
    await ui.click(await screen.findByRole("button", { name: /查看未达流水/ }));
    // 未达流水弹窗按 unmatched_flow_ids 只列出对应那一条，故弹窗内精确 1 次。
    // 旧断言要求 ≥2 依赖「关闭态弹窗也被渲染」的虚假挂载（motion 桩伪造 visible），已随桩修正失效。
    const unmatchedModal = document.querySelector(".ant-modal") as HTMLElement;
    expect(within(unmatchedModal).getAllByText("HS0001-CF-BUY-01")).toHaveLength(1);
    expect(unmatchedModal.querySelectorAll("tbody tr.ant-table-row")).toHaveLength(1);
  });

  it("押金损失登记提交原金额、日期、分类和原因", async () => {
    resolveMockOnce(vi.mocked(catalog.depositsApi.loss), { id: 91 });
    renderLight(<FundsPage />, { user: "finance" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "工作室支出" }));
    await ui.click(await screen.findByRole("button", { name: /登记损失/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await ui.type(modal.querySelector("#amount") ?? modal, "100.00");
    await ui.type(modal.querySelector("#category") ?? modal, "违约损失");
    await ui.type(modal.querySelector("#reason") ?? modal, "对手方未按约返还");
    await ui.click(screen.getByRole("button", { name: /确认损失/ }));
    await waitFor(() => expect(vi.mocked(catalog.depositsApi.loss)).toHaveBeenCalled());
    expect(vi.mocked(catalog.depositsApi.loss).mock.calls[0]).toEqual([11, {
      amount: "100.00",
      lost_on: expect.any(String),
      category: "违约损失",
      reason: "对手方未按约返还",
    }]);
  });

  it("单边划转可选择对端资金池并提交修复原因", async () => {
    resolveMockOnce(vi.mocked(catalog.cashflowsApi.list), { items: [{ ...cashflows[0], transfer_id: "TRF-001" }], total: 1 });
    vi.mocked(catalog.transfersApi.repair).mockResolvedValueOnce({ transfer_id: "TRF-001" });
    renderLight(<FundsPage />, { user: "finance" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "异常" }));
    await ui.click(await screen.findByRole("button", { name: /修复划转/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, /POOL-B/);
    await ui.type(modal.querySelector("#reason") ?? modal, "补齐转入侧流水");
    await ui.click(screen.getByRole("button", { name: /确认修复/ }));
    await waitFor(() => expect(vi.mocked(catalog.transfersApi.repair)).toHaveBeenCalled());
    expect(vi.mocked(catalog.transfersApi.repair).mock.calls[0]).toEqual(["TRF-001", {
      counterpart_pool_id: 2,
      reason: "补齐转入侧流水",
    }]);
  });


  it("押金取消：PAID 押金填原因后调用 depositsApi.cancel（全额冲正由后端写）", async () => {
    vi.mocked(catalog.depositsApi.list).mockResolvedValue([
      { id: 12, pool_id: 1, paid_amount: "300.00", returned_amount: "0.00", lost_amount: "0.00", remaining_amount: "300.00", status: "PAID" },
    ] as unknown as Awaited<ReturnType<typeof catalog.depositsApi.list>>);
    resolveMockOnce(vi.mocked(catalog.depositsApi.cancel), { id: 12 });
    renderLight(<FundsPage />, { user: "finance" });
    await screen.findByRole("cell", { name: /POOL-A/ });
    await ui.click(screen.getByRole("tab", { name: "工作室支出" }));
    await ui.click(await screen.findByRole("button", { name: /取\s*消/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await waitFor(() => expect(modal).toBeTruthy());
    await ui.type(modal.querySelector("#reason") as Element, "押金登记有误");
    await ui.click(screen.getByRole("button", { name: /确认取消/ }));
    await waitFor(() => expect(vi.mocked(catalog.depositsApi.cancel)).toHaveBeenCalled(), { timeout: 5000 });
    expect(vi.mocked(catalog.depositsApi.cancel).mock.calls[0]).toEqual([12, {
      cancelled_on: expect.any(String),
      reason: "押金登记有误",
    }]);
  });
});
