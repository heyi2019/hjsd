import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { FundsPage } from "./FundsPage";
import { resolveMock } from "../test/mock-api";

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
    "all",
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
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.listColumnsApi.all).mockResolvedValue([]);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools);
  resolveMock(vi.mocked(catalog.poolsApi.balance), balance);
  resolveMock(vi.mocked(catalog.depositsApi.list), deposits);
  resolveMock(vi.mocked(catalog.cashflowsApi.list), { items: cashflows, total: cashflows.length });
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
