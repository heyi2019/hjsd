import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { OrdersPage } from "@/business/OrdersPage";
import { useLedgerList } from "@/business/orders/useLedgerList";

import { installmentsApi } from "@/shared/api/installments.api";
const installmentListFixture = vi.fn<(params?: import("@/shared/api/installments.api").InstallmentListParams) => Promise<import("@/shared/api/types/installments").Installment[]>>();
import { orderTypesApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { customersApi, counterpartiesApi } from "@/shared/api/customers.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { poolsApi } from "@/shared/api/pools.api";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { installmentTotals, inventoryLedgerResponse, orderLedgerSummary, pageResponse } from "@fixtures/api-responses";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/profitAllocation.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

// 订单台账测试不覆盖库存面板本身；库存面板有独立回归，主页面测试用轻量桩避免重复挂载整套库存依赖。
vi.mock("@/business/inventory/InventoryPanel", () => ({
  InventoryPanel: ({ active = true, createAction }: { active?: boolean; createAction?: import("react").ReactNode }) => active ? <div data-testid="inventory-panel-test-stub"><div className="ant-card-head">库存中心{createAction}</div></div> : null,
}));

const orders = [
  {
    id: 1,
    order_no: "HS-2026-0001",
    order_type: "HS",
    trade_date: "2026-10-01",
    status: "ACTIVE",
    account_business_mode: "SELF",
    account_game_type: "原神",
    account_game_account: "seller-001",
    account_status: "WAITING",
    party_name: "卖家甲",
    party_source: "同行推荐",
    sale_amount: "1234.00",
    last_event_type: "BUY",
    inventory_operator: "入库员",
    inventory_entry_at: "2026-10-01T09:30:00",
    cost_amount: "100.00",
    sale_operator: "售卖员",
    sale_at: "2026-10-17T16:45:00",
  },
  { id: 2, order_no: "TH-2026-0002", order_type: "TH", trade_date: "2026-10-02", status: "COMPLETED" },
];
const types = [{ id: 1, code: "HS", name: "回收", is_active: true }];

function setupLedgerApi(source: unknown[] = orders) {
  const filterRows = (params?: Parameters<typeof ordersApi.listPage>[0]) => source.filter((row) => {
    const item = row as Record<string, unknown>;
    const keyword = params?.keyword?.trim();
    if (keyword && !Object.values(item).some((value) => typeof value === "string" && value.includes(keyword))) return false;
    if (params?.order_type && item.order_type !== params.order_type) return false;
    if (params?.business_mode && item.business_mode !== params.business_mode) return false;
    if (params?.game_type && item.account_game_type !== params.game_type) return false;
    if (params?.account_status && item.account_status !== params.account_status) return false;
    return true;
  });

  vi.mocked(ordersApi.listPage).mockImplementation(async (params) => {
    const rows = filterRows(params);
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? 10;
    return pageResponse(rows.slice(offset, offset + limit), { total: rows.length, limit, offset }) as never;
  });
  vi.mocked(ordersApi.ledgerSummary).mockImplementation(async (params) => {
    const rows = filterRows(params);
    const facets = filterRows({ ...params, order_type: undefined });
    const countBy = (key: string, source = rows) => source.reduce<Record<string, number>>((counts, row) => {
      const value = (row as Record<string, unknown>)[key];
      if (typeof value === "string") counts[value] = (counts[value] ?? 0) + 1;
      return counts;
    }, {});
    return {
      total_count: rows.length,
      in_progress_count: rows.filter((row) => ["ACTIVE", "INSTALLMENT"].includes(String((row as Record<string, unknown>).status))).length,
      completed_count: rows.filter((row) => (row as Record<string, unknown>).status === "COMPLETED").length,
      cancelled_count: rows.filter((row) => (row as Record<string, unknown>).status === "CANCELLED").length,
      type_total: facets.length,
      status_counts: countBy("status"),
      type_counts: countBy("order_type", facets),
      game_types: [...new Set(rows.map((row) => (row as Record<string, unknown>).account_game_type).filter((value): value is string => typeof value === "string"))],
    } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seedOptionSets();
  seedOrderFormFields();
  setupLedgerApi();
  vi.mocked(customersApi.options).mockResolvedValue([]);
  vi.mocked(counterpartiesApi.list).mockResolvedValue([]);
  vi.mocked(orderTypesApi.list).mockResolvedValue(types);
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "管理员", is_active: true },
  ]);
  installmentListFixture.mockResolvedValue([]);
  vi.mocked(installmentsApi.page).mockImplementation(async ({ limit, offset, sort_desc, ...filters }) => {
    const rows = await installmentListFixture(filters);
    const sorted = [...rows].sort((a, b) => sort_desc ? b.id - a.id : a.id - b.id);
    return pageResponse(sorted.slice(offset, offset + limit), { total: sorted.length, limit, offset });
  });
});

async function openLedger(user?: string) {
  renderLight(<OrdersPage />, user ? { user } : undefined);
  await ui.click(await screen.findByRole("tab", { name: "订单台账" }));
  await waitFor(() => expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThanOrEqual(1));
  await waitFor(() => expect(vi.mocked(ordersApi.ledgerSummary)).toHaveBeenCalled());
}

describe("OrdersPage：四类订单台账", () => {
  it.each([["employee", false], ["operator", true], ["viewer", false]] as const)("%s 订单动作入口与事件及导出权限一致", async (role, allowed) => {
    await openLedger(role);
    const row = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))!.closest("tr") as HTMLElement;
    expect(Boolean(within(row).queryByRole("button", { name: "售出" }))).toBe(allowed);
    expect(Boolean(within(row).queryByRole("button", { name: "运营" }))).toBe(allowed);
    expect(Boolean(screen.queryByRole("button", { name: "导出" }))).toBe(allowed);
  });
  it("筛选失败后清除旧订单，避免在新条件下操作旧结果", async () => {
    await openLedger("admin");
    vi.mocked(ordersApi.listPage).mockRejectedValueOnce(new Error("订单查询失败"));
    fireEvent.change(screen.getByLabelText("搜索订单"), { target: { value: "不存在" } });
    await ui.click(screen.getByRole("button", { name: "执行订单搜索" }));
    expect(await screen.findByText(/订单查询失败/)).toBeVisible();
    expect(screen.queryByText("HS-2026-0001")).not.toBeInTheDocument();
  });

  it("刷新同时更新统计，末页不足时回到有效页，普通翻页不重读统计", async () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      ...orders[0], id: index + 1, order_no: `HS-ITEM-${index + 1}`,
    }));
    setupLedgerApi(rows);
    function Probe() {
      const ledger = useLedgerList({ active: true, initialMine: false });
      return <><button onClick={() => ledger.setPage(2)}>第二页</button>
        <button onClick={() => void ledger.load()}>刷新</button>
        <span>{`页码:${ledger.page}`}</span><span>{`统计:${ledger.ledgerSummary?.total_count ?? "等待"}`}</span>
        <span>{ledger.orders.map((item) => item.order_no).join(",")}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await screen.findByText("统计:11");
    await ui.click(screen.getByRole("button", { name: "第二页" }));
    await screen.findByText("HS-ITEM-11");
    expect(ordersApi.ledgerSummary).toHaveBeenCalledTimes(1);
    rows.pop();
    await ui.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByText("页码:1");
    expect(await screen.findByText("统计:10")).toBeVisible();
    expect(screen.getByText(/HS-ITEM-1,/)).toBeVisible();
  });

  it("订单写入完成后刷新当前筛选和统计，不恢复写入前的视图", async () => {
    let finishWrite: (() => Promise<void>) | undefined;
    function Probe() {
      const ledger = useLedgerList({ active: true, initialMine: false });
      return <><button onClick={() => { finishWrite = ledger.load; }}>开始写入</button>
        <button onClick={() => ledger.setOrderTypeFilter("TH")}>筛选提号</button>
        <button onClick={() => void finishWrite?.()}>写入完成</button>
        <span>{`订单:${ledger.orders.map((item) => item.order_no).join(",")}`}</span>
        <span>{`统计:${ledger.ledgerSummary?.total_count ?? "等待"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await screen.findByText("订单:HS-2026-0001,TH-2026-0002");
    await ui.click(screen.getByRole("button", { name: "开始写入" }));
    await ui.click(screen.getByRole("button", { name: "筛选提号" }));
    await screen.findByText("订单:TH-2026-0002");
    await screen.findByText("统计:1");
    const previousCalls = vi.mocked(ordersApi.listPage).mock.calls.length;
    await ui.click(screen.getByRole("button", { name: "写入完成" }));
    await waitFor(() => expect(ordersApi.listPage).toHaveBeenCalledTimes(previousCalls + 1));
    expect(ordersApi.listPage).toHaveBeenLastCalledWith(expect.objectContaining({ order_type: "TH" }));
    expect(ordersApi.ledgerSummary).toHaveBeenLastCalledWith(expect.objectContaining({ order_type: "TH" }));
    expect(screen.getByText("订单:TH-2026-0002")).toBeInTheDocument();
  });

  it("较早的统计响应不能覆盖刷新后的统计", async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof ordersApi.ledgerSummary>>) => void;
    vi.mocked(ordersApi.ledgerSummary).mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
    vi.mocked(ordersApi.ledgerSummary).mockResolvedValueOnce(orderLedgerSummary({ total_count: 3 }));
    function Probe() {
      const ledger = useLedgerList({ active: true, initialMine: false });
      return <><button onClick={() => void ledger.load()}>刷新</button>
        <span>{`统计:${ledger.ledgerSummary?.total_count ?? "等待"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await waitFor(() => expect(ordersApi.ledgerSummary).toHaveBeenCalledTimes(1));
    await ui.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("统计:3")).toBeVisible();
    await act(async () => finishOld(orderLedgerSummary({ total_count: 1 })));
    expect(screen.getByText("统计:3")).toBeVisible();
  });
  it("汇总加载及失败时类型计数显示占位符", async () => {
    let rejectSummary!: (error: Error) => void;
    vi.mocked(ordersApi.ledgerSummary).mockImplementation(() => new Promise((_resolve, reject) => { rejectSummary = reject; }));
    renderLight(<OrdersPage initialTab="ledger" />);
    await waitFor(() => expect(ordersApi.ledgerSummary).toHaveBeenCalled());
    expect(screen.getByText("全部 —")).toBeInTheDocument();
    await act(async () => rejectSummary(new Error("汇总加载失败")));
    expect(screen.getByText("全部 —")).toBeInTheDocument();
    expect(screen.queryByText("全部 0")).not.toBeInTheDocument();
  });

  it("点击搜索立即查询当前关键词和统计", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => { renderLight(<OrdersPage initialTab="ledger" />); });
      vi.mocked(ordersApi.listPage).mockClear();
      vi.mocked(ordersApi.ledgerSummary).mockClear();
      fireEvent.change(screen.getByRole("searchbox", { name: "搜索订单" }), { target: { value: "HS" } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "执行订单搜索" })); });
      expect(ordersApi.listPage).toHaveBeenCalledWith(expect.objectContaining({ keyword: "HS" }));
      expect(ordersApi.ledgerSummary).toHaveBeenCalledWith(expect.objectContaining({ keyword: "HS" }));
    } finally { vi.useRealTimers(); }
  });
  it("分期页仅在业务中心激活时加载并在返回时刷新", async () => {
    vi.mocked(installmentsApi.totals).mockResolvedValue(installmentTotals());
    const view = renderLight(<OrdersPage initialTab="collections" active={false} />);
    await act(async () => {});
    expect(installmentListFixture).not.toHaveBeenCalled();
    expect(installmentsApi.totals).not.toHaveBeenCalled();
    view.rerender(<OrdersPage initialTab="collections" active />);
    await waitFor(() => expect(installmentListFixture).toHaveBeenCalledTimes(1));
    expect(installmentsApi.totals).toHaveBeenCalledTimes(1);
    view.rerender(<OrdersPage initialTab="collections" active={false} initialInstallmentStatus="OVERDUE" />);
    await act(async () => {});
    expect(installmentListFixture).toHaveBeenCalledTimes(1);
    view.rerender(<OrdersPage initialTab="collections" active initialInstallmentStatus="OVERDUE" />);
    await waitFor(() => expect(installmentListFixture).toHaveBeenCalledTimes(2));
    expect(installmentListFixture).toHaveBeenLastCalledWith(expect.objectContaining({ status: "OVERDUE" }));
    expect(installmentsApi.totals).toHaveBeenCalledTimes(2);
  });

  it("订单台账翻页时请求并展示后端第二页", async () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      ...orders[0], id: index + 1, order_no: index === 10 ? "HS-PAGE2" : `HS-PAGE1-${index}`,
    }));
    setupLedgerApi(rows);
    renderLight(<OrdersPage initialTab="ledger" />, { user: "admin" });
    await screen.findByText("HS-PAGE1-0");
    await ui.click(screen.getByTitle("2"));
    expect(await screen.findByText("HS-PAGE2")).toBeVisible();
    expect(ordersApi.listPage).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 10, offset: 10 }));
    expect(screen.queryByText("HS-PAGE1-0")).toBeNull();
    await ui.click(screen.getByRole("tab", { name: "库存中心" }));
    vi.mocked(ordersApi.listPage).mockClear();
    await ui.click(screen.getByRole("tab", { name: "订单台账" }));
    expect(await screen.findByText("HS-PAGE1-0")).toBeVisible();
    expect(ordersApi.listPage).toHaveBeenCalledTimes(1);
    expect(ordersApi.listPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 0 }));
  });

  it("进入订单台账立即加载列表和统计，输入关键词时合并请求", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => { renderLight(<OrdersPage initialTab="ledger" />); });
      expect(ordersApi.ledgerSummary).toHaveBeenCalledTimes(1);
      expect(ordersApi.listPage).toHaveBeenCalledTimes(1);
      await act(async () => {
        fireEvent.change(screen.getByLabelText("搜索订单"), { target: { value: "H" } });
        fireEvent.change(screen.getByLabelText("搜索订单"), { target: { value: "HS" } });
      });
      expect(ordersApi.ledgerSummary).toHaveBeenCalledTimes(1);
      expect(ordersApi.listPage).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(249); });
      expect(ordersApi.ledgerSummary).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(ordersApi.ledgerSummary).toHaveBeenCalledTimes(2);
      expect(ordersApi.ledgerSummary).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "HS" }));
      expect(ordersApi.listPage).toHaveBeenCalledTimes(2);
      expect(ordersApi.listPage).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "HS", offset: 0 }));
      await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "回收 1" })); });
      expect(ordersApi.ledgerSummary).toHaveBeenCalledTimes(3);
      expect(ordersApi.ledgerSummary).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "HS", order_type: "HS" }));
      expect(ordersApi.listPage).toHaveBeenCalledTimes(3);
      expect(ordersApi.listPage).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "HS", order_type: "HS" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("输入订单关键词后等待期间忽略旧列表结果", async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof ordersApi.listPage>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof ordersApi.listPage>>>((resolve) => { finishOld = resolve; });
    vi.mocked(ordersApi.listPage).mockReturnValueOnce(pending);
    renderLight(<OrdersPage initialTab="ledger" />);
    await waitFor(() => expect(ordersApi.listPage).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("搜索订单"), { target: { value: "TH-2026" } });
    await act(async () => finishOld(pageResponse(orders) as never));
    expect(screen.queryByText("HS-2026-0001")).not.toBeInTheDocument();
    expect(await screen.findByText("TH-2026-0002")).toBeVisible();
  });

  // 默认夹具、只读静态 DOM，合并外壳和已下线能力边界断言，避免重复挂载。
  it("业务中心外壳：默认进库存中心、页签只留三视图", async () => {
    renderLight(<OrdersPage />);

    const inventoryTab = await screen.findByRole("tab", { name: "库存中心" });
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "业务总览" })).toBeNull();

    expect(await screen.findByRole("tab", { name: "订单台账" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "业务台账" })).toBeNull();

    for (const label of ["库存中心", "订单台账", "分期与回款"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("tab", { name: "返点" })).toBeNull();

    expect(screen.queryByText("关联筛选")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "关联状态筛选" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "关联" })).toBeNull();
  });

  it("库存中心初始加载不触发订单台账请求", async () => {
    renderLight(<OrdersPage />);

    expect(await screen.findByRole("tab", { name: "库存中心" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => {
      expect(vi.mocked(ordersApi.listPage)).not.toHaveBeenCalled();
      expect(vi.mocked(ordersApi.ledgerSummary)).not.toHaveBeenCalled();
      expect(vi.mocked(orderTypesApi.list)).not.toHaveBeenCalled();
      expect(installmentListFixture).not.toHaveBeenCalled();
      expect(vi.mocked(installmentsApi.totals)).not.toHaveBeenCalled();
    });
  });

  it("类型 Segmented 计数与「订单总量」同口径：关键词筛选后同步收窄", async () => {
    await openLedger();
    expect(screen.getByText("订单总量").closest(".ui-stat")).toHaveTextContent("2");
    // 带位数的精确正则：页面还有「全部业务 / 全部库存状态」等 Segmented，/全部/ 会命中多个。
    // antd Segmented 的 radio 文本在兄弟节点，元素自身 textContent 为空；计数体现在可访问名。
    expect(screen.getByRole("radio", { name: "全部 2" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "回收 1" })).toBeInTheDocument();

    await ui.type(screen.getByLabelText("搜索订单"), "TH-2026");
    await waitFor(() => expect(screen.getByText("订单总量").closest(".ui-stat")).toHaveTextContent("1"));
    // 旧实现用原始 orders 计数，关键词筛选后仍显示「全部 2」，与订单总量 1 自相矛盾。
    expect(screen.getByRole("radio", { name: "全部 1" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "回收 0" })).toBeInTheDocument();
  });

  it("导出与当前视图同口径：我的订单视图导出 CSV/XLSX 均带 mine=true", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ledger");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.mocked(ordersApi.exportCsv).mockResolvedValue(new Blob(["csv"]));
    vi.mocked(ordersApi.exportXlsx).mockResolvedValue(new Blob(["xlsx"]));

    renderLight(<OrdersPage initialTab="ledger" initialMine initialLedgerFilters={{ status: "IN_PROGRESS", tradeDateFrom: "2026-11-01", tradeDateTo: "2026-11-16" }} />);
    await screen.findAllByText("HS-2026-0001");

    await ui.click(screen.getByRole("button", { name: /导出/ }));
    // antd Dropdown 会同时保留上一份隐藏菜单，同文案出现多次；取最新一份直接触发。
    const csvItem = await screen.findAllByText(/导出表格/);
    fireEvent.click(csvItem[csvItem.length - 1]);
    await waitFor(() => expect(vi.mocked(ordersApi.exportCsv)).toHaveBeenCalledWith(
      expect.objectContaining({ mine: true, status: "IN_PROGRESS", trade_date_from: "2026-11-01", trade_date_to: "2026-11-16", sort_desc: true }),
    ));

    await ui.click(screen.getByRole("button", { name: "最旧在前" }));
    await ui.click(screen.getByRole("button", { name: /导出/ }));
    const xlsxItem = await screen.findAllByText(/导出工作簿/);
    fireEvent.click(xlsxItem[xlsxItem.length - 1]);
    await waitFor(() => expect(vi.mocked(ordersApi.exportXlsx)).toHaveBeenCalledWith(
      expect.objectContaining({ mine: true, status: "IN_PROGRESS", trade_date_from: "2026-11-01", trade_date_to: "2026-11-16", sort_desc: false }),
    ));
  });

  // 原 5 条用例（无流程提示 / 日期区间位置 / 订单编号与状态 / 责任时间列 / 默认视图核心列）
  // 都只用默认夹具 + openLedger 一次进入台账，全是只读断言，合并为一次挂载。
  it("订单台账默认视图：筛选区、识别列与行内业务数据", async () => {
    await openLedger();

    // 筛选栏不展示流程提示文字
    expect(screen.queryByText("状态由对应业务流程更新，点击订单后继续处理付款、入库、售出或回款")).toBeNull();

    // 搜索框右侧紧跟订单日期区间筛选
    const search = screen.getByRole("searchbox", { name: "搜索订单" });
    const startDate = screen.getAllByLabelText("订单日期区间")[0];
    expect(search.compareDocumentPosition(startDate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 订单编号与库存状态按行渲染
    expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("TH-2026-0002").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("库存状态").length).toBeGreaterThanOrEqual(1);

    // 入库 / 售卖责任时间列，且行内取数正确
    for (const label of ["入库操作人", "入库时间", "售卖操作人", "售卖时间", "业务", "业务类型"]) {
      expect(screen.getByRole("columnheader", { name: label })).toBeInTheDocument();
    }
    const dutyRow = screen.getAllByRole("row").find((item) => within(item).queryByText("HS-2026-0001") !== null)!;
    expect(within(dutyRow).getByText("入库员")).toBeInTheDocument();
    expect(within(dutyRow).getByText("2026-10-01 09:30")).toBeInTheDocument();
    expect(within(dutyRow).getByText("售卖员")).toBeInTheDocument();
    expect(within(dutyRow).getByText("2026-10-17 16:45")).toBeInTheDocument();
    expect(within(dutyRow).getByText("16天7小时15分")).toBeInTheDocument();
    expect(within(dutyRow).getByText("自营")).toBeInTheDocument();
    expect(within(dutyRow).getByText("回收")).toBeInTheDocument();

    // 默认视图下的核心识别列与取值（完整列清单属配置能力，不在前端锁死）
    for (const label of ["订单号", "售出金额", "库存状态", "操作"]) {
      expect(screen.getAllByRole("columnheader", { name: label }).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole("columnheader", { name: "日期" })).toBeNull();
    expect(document.querySelector(".orders-ledger .ant-table-content > table")).toHaveStyle({ tableLayout: "fixed" });
    const ledgerColumnWidths = Array.from(document.querySelectorAll(".orders-ledger .ant-table-content > table col")).map((column) => column.getAttribute("style"));
    expect(ledgerColumnWidths).toContain("width: var(--col-w-60);");
    expect(ledgerColumnWidths).toContain("width: var(--col-w-70);");
    for (const value of ["原神", "seller-001", "¥1,234.00", "在库"]) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
    const waitingCostRow = screen.getAllByRole("row").find((item) => within(item).queryByText("HS-2026-0001") !== null)!;
    expect(within(waitingCostRow).getByText("¥100.00")).toBeInTheDocument();
  });

  it("订单台账顶部展示当前筛选结果的订单统计卡", async () => {
    setupLedgerApi([
      ...orders,
      { id: 3, order_no: "DG-2026-0003", order_type: "DG", trade_date: "2026-10-03", status: "CANCELLED" },
    ]);

    await openLedger();

    const expectedStats = [
      ["订单总量", "3"],
      ["进行中订单", "1"],
      ["完成订单量", "1"],
      ["已取消订单", "1"],
    ];
    const ledger = screen.getByRole("tabpanel", { name: "订单台账" });
    for (const [label, value] of expectedStats) {
      const card = within(ledger).getByText(label).closest(".ui-stat") as HTMLElement | null;
      expect(card).not.toBeNull();
      expect(within(card!).getByText(value)).toBeInTheDocument();
    }
  });

  it("订单统计直接展示后端卡片数，缺失时不伪装成零", async () => {
    vi.mocked(ordersApi.ledgerSummary).mockResolvedValue({ total_count: 10, in_progress_count: 7, cancelled_count: 0, type_total: 27, status_counts: { ACTIVE: 99 }, type_counts: {}, game_types: [] } as never);
    renderLight(<OrdersPage initialTab="ledger" />);
    const inProgress = (await screen.findByText("进行中订单")).closest(".ui-stat") as HTMLElement;
    await waitFor(() => expect(inProgress).toHaveTextContent("7"));
    expect(screen.getByText("完成订单量").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByText("已取消订单").closest(".ui-stat")).toHaveTextContent("0");
    expect(screen.getByText("全部 27")).toBeInTheDocument();
  });

  it("FE-253：订单统计加载未完成时统计卡不显示可信的零", async () => {
    vi.mocked(ordersApi.ledgerSummary).mockImplementation(() => new Promise(() => undefined));
    renderLight(<OrdersPage initialTab="ledger" />);
    const ledger = await screen.findByRole("tabpanel", { name: "订单台账" });
    const card = within(ledger).getByText("订单总量").closest(".ui-stat") as HTMLElement;
    expect(within(card).getByText("—")).toBeInTheDocument();
    expect(within(card).queryByText("0")).toBeNull();
  });

  it("FE-257：台账有独立「订单状态」列，状态列仍只承载库存状态", async () => {
    setupLedgerApi([{
      ...orders[0],
      status: "INSTALLMENT",
      installment_status: "SETTLED",
      order_no: "HS-2026-INSTALLMENT-SETTLED",
    }]);
    renderLight(<OrdersPage initialTab="ledger" />);
    await screen.findAllByText("HS-2026-INSTALLMENT-SETTLED");

    const row = screen.getAllByRole("row").find((item) => within(item).queryByText("HS-2026-INSTALLMENT-SETTLED") !== null)!;
    // 库存状态列 = account_status（在库/已售/失效），不被订单状态串占
    expect(within(row).getByText("在库")).toBeInTheDocument();
    // 订单状态自成一列（H5 卡片下线后台账是唯一展示位）；合约结清状态仍由「分期与回款」页签承载
    expect(screen.getByRole("columnheader", { name: "订单状态" })).toBeInTheDocument();
    expect(within(row).getByText("分期中")).toBeInTheDocument();
    expect(within(row).queryByText("合约：已结清")).toBeNull();
  });

  it("业务中心仅保留业务作业页，不重复展示业务总览", async () => {
    installmentListFixture.mockResolvedValue([{
      id: 20,
      status: "OVERDUE",
      total_receivable: "1030.00",
      paid_amount: "400.00",
      bad_debt_amount: "0.00",
    } as never]);

    renderLight(<OrdersPage />);

    await screen.findByRole("tab", { name: "库存中心" });
    expect(screen.queryByRole("tab", { name: "业务总览" })).toBeNull();
    expect(screen.queryByRole("region", { name: "业务提醒" })).toBeNull();
  });

  it("订单搜索包含订单备注，支持按批次标记筛选", async () => {
    setupLedgerApi([
      ...orders,
      {
        id: 3,
        order_no: "DG-2026-0003",
        order_type: "DG",
        trade_date: "2026-10-03",
        status: "ACTIVE",
        note: "[批量验收] DG 分期出售",
      },
    ]);

    await openLedger();
    await ui.type(screen.getByLabelText("搜索订单"), "批量验收");

    expect((await screen.findAllByText("DG-2026-0003")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByText("HS-2026-0001")).toBeNull());
  });

  it("订单台账提供游戏类型下拉筛选", async () => {
    setupLedgerApi([
      ...orders,
      {
        id: 3,
        order_no: "DG-2026-0003",
        order_type: "DG",
        trade_date: "2026-10-03",
        status: "ACTIVE",
        account_game_type: "王者荣耀",
        account_game_account: "seller-003",
      },
    ]);

    await openLedger();
    const gameTypeFilter = screen.getByRole("combobox", { name: "游戏类型筛选" });
    await ui.click(gameTypeFilter);
    const gameTypeOption = (await screen.findAllByText("王者荣耀")).find((element) => element.classList.contains("ant-select-item-option-content"));
    expect(gameTypeOption).toBeDefined();
    await ui.click(gameTypeOption!);

    const ledger = screen.getByRole("tabpanel", { name: "订单台账" });
    await waitFor(() => expect(within(ledger).queryByText("HS-2026-0001")).toBeNull());
    expect(within(ledger).getAllByText("DG-2026-0003").length).toBeGreaterThan(0);
  });

  it("订单台账提供库存状态下拉筛选", async () => {
    setupLedgerApi([
      { ...orders[0], account_status: "WAITING" },
      { ...orders[1], id: 3, order_no: "TH-2026-0003", account_status: "SOLD" },
    ]);

    await openLedger();
    const inventoryStatusFilter = screen.getByRole("combobox", { name: "库存状态筛选" });
    await ui.click(inventoryStatusFilter);
    await ui.click(screen.getByText("已售", { selector: ".ant-select-item-option-content" }));

    const ledger = screen.getByRole("tabpanel", { name: "订单台账" });
    await waitFor(() => expect(within(ledger).queryByText("HS-2026-0001")).toBeNull());
    expect(within(ledger).getAllByText("TH-2026-0003").length).toBeGreaterThan(0);
  });

  it("订单台账深链按状态和日期加载", async () => {
    renderLight(
      <OrdersPage
        initialTab="ledger"
        initialLedgerFilters={{ status: "COMPLETED", tradeDateFrom: "2026-11-01", tradeDateTo: "2026-11-16" }}
      />,
    );

    await waitFor(() => expect(vi.mocked(ordersApi.listPage)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "COMPLETED", trade_date_from: "2026-11-01", trade_date_to: "2026-11-16" }),
    ));
    expect(screen.getByText("订单状态：已完成")).toBeInTheDocument();
    await ui.click(screen.getByLabelText("清除订单状态筛选"));
    await waitFor(() => expect(vi.mocked(ordersApi.listPage)).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ status: "COMPLETED" }),
    ));
  });

  it("分润订单深链自动搜索订单并在切换目标时更新", async () => {
    setupLedgerApi();
    const view = renderLight(<OrdersPage initialTab="ledger" initialLedgerFilters={{ keyword: "TH-2026-0002" }} />);
    await waitFor(() => expect(ordersApi.listPage).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "TH-2026-0002", offset: 0 })));
    expect(screen.getByPlaceholderText(/搜索订单/)).toHaveValue("TH-2026-0002");
    view.rerender(<OrdersPage initialTab="ledger" initialLedgerFilters={{ keyword: "HS-2026-0001" }} />);
    await waitFor(() => expect(ordersApi.listPage).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "HS-2026-0001", offset: 0 })));
    expect(screen.getByPlaceholderText(/搜索订单/)).toHaveValue("HS-2026-0001");
  });

  it("我的订单深链展示当前入库和售出操作人", async () => {
    renderLight(<OrdersPage initialTab="ledger" initialMine />, { user: "admin" });

    await waitFor(() => expect(vi.mocked(ordersApi.listPage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ mine: true }),
    ));
    for (const label of ["入库负责人筛选", "售出操作人筛选"]) {
      const filter = screen.getByRole("combobox", { name: label });
      await ui.click(filter);
      await waitFor(() => {
        const listboxes = screen.getAllByRole("listbox");
        expect(within(listboxes[listboxes.length - 1]).getByRole("option", { name: "管理员" })).toHaveAttribute("aria-selected", "true");
      });
      await ui.click(filter);
    }
  });

  it("订单台账提供入库负责人和售出操作人多选筛选", async () => {
    await openLedger();

    const inventoryOperatorFilter = screen.getByRole("combobox", { name: "入库负责人筛选" });
    await ui.click(inventoryOperatorFilter);
    await ui.click(screen.getByText("管理员", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(ordersApi.listPage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ inventory_operator_ids: [1] }),
    ));

    const saleOperatorFilter = screen.getByRole("combobox", { name: "售出操作人筛选" });
    await ui.click(saleOperatorFilter);
    const saleOperatorOptions = screen.getAllByText("管理员", { selector: ".ant-select-item-option-content" });
    const saleOperatorOption = saleOperatorOptions[saleOperatorOptions.length - 1];
    expect(saleOperatorOption).toBeDefined();
    await ui.click(saleOperatorOption!);
    await waitFor(() => expect(vi.mocked(ordersApi.listPage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ inventory_operator_ids: [1], sale_operator_ids: [1] }),
    ));
  });

  it("行展开直接复用库存中心的订单详情", async () => {
    setupLedgerApi([
      { ...orders[0], account_id: 1 },
      orders[1],
    ]);
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: {
        id: 1,
        stock_no: "KU_00001",
        game_account: "seller-001",
        game_type: "原神",
        platform: "安卓",
        status: "WAITING",
        cost_amount: "1234.00",
        created_by: "admin",
        created_at: "2026-10-01T09:30:00",
      },
      orders: [{
        order_id: 1,
        order_no: "HS-2026-0001",
        order_type: "HS",
        trade_date: "2026-10-01",
        created_at: "2026-10-01T09:30:00",
        status: "ACTIVE",
        events: [{
          id: 11,
          event_no: "EV0011",
          event_type: "BUY",
          amount: "1234.00",
          occurred_on: "2026-10-01",
          occurred_at: "2026-10-01T10:00:00",
          portion: "PRINCIPAL",
          is_posted: true,
          operator: "admin",
        }],
      }],
    } as never);

    await openLedger();
    const row = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))!.closest("tr")!;
    fireEvent.click(row.querySelector(".ant-table-row-expand-icon") as Element);

    // 与库存中心同一套详情：六个板块整块出现，而非订单摘要。
    expect(await screen.findByText("游戏账号信息")).toBeInTheDocument();
    expect(screen.getByText("运营信息")).toBeInTheDocument();
    expect(screen.getByText("资金明细")).toBeInTheDocument();
    expect(screen.getByText("操作明细")).toBeInTheDocument();
    expect(screen.getByText("参与方信息")).toBeInTheDocument();
    expect(vi.mocked(ordersApi.executionDetail)).toHaveBeenCalledWith(1, { imagePreviews: true });
  });

  it("同一账号有多张订单时，订单台账展开使用当前订单的详情上下文", async () => {
    const olderOrder = {
      ...orders[0],
      id: 8,
      order_no: "TH-2026-0174",
      order_type: "TH",
      account_id: 1,
    };
    const selectedOrder = {
      ...orders[0],
      id: 9,
      order_no: "TH-2026-0179",
      order_type: "TH",
      account_id: 1,
    };
    setupLedgerApi([olderOrder, selectedOrder]);
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: {
        id: 1,
        stock_no: "KU_00001",
        source_order_no: "TH-2026-0174",
        game_account: "seller-001",
        game_type: "原神",
        platform: "安卓",
        status: "WAITING",
        cost_amount: "1234.00",
        created_by: "admin",
        created_at: "2026-10-01T09:30:00",
      },
      orders: [
        {
          order_id: 8,
          order_no: "TH-2026-0174",
          order_type: "TH",
          trade_date: "2026-10-01",
          created_at: "2026-10-01T09:30:00",
          status: "ACTIVE",
          extra_values: { intermediary_platform: "旧平台" },
          events: [],
        },
        {
          order_id: 9,
          order_no: "TH-2026-0179",
          order_type: "TH",
          trade_date: "2026-10-02",
          created_at: "2026-10-02T09:30:00",
          status: "ACTIVE",
          extra_values: { intermediary_platform: "选中平台" },
          events: [],
        },
      ],
    } as never);

    renderLight(<OrdersPage />);
    await ui.click(await screen.findByRole("tab", { name: "订单台账" }));
    await screen.findAllByText("TH-2026-0179");
    const row = screen.getAllByText("TH-2026-0179").find((element) => element.closest("tr"))!.closest("tr")!;
    fireEvent.click(row.querySelector(".ant-table-row-expand-icon") as Element);

    expect(await screen.findByText("选中平台")).toBeInTheDocument();
    expect(screen.queryByText("旧平台")).toBeNull();
  });

  // 已完成且未关联库存账号的历史单不提供编辑；其余订单继续提供行级操作。
  it("操作列提供统一编辑、分润配置、资金收支、取消入口", async () => {
    await openLedger("admin");

    // 不再有「更多」收纳入口
    expect(screen.queryAllByRole("button", { name: "更多" })).toHaveLength(0);
    for (const label of ["编辑", "分润配置", "资金收支", "运营", "取消"]) {
      const buttons = screen.getAllByRole("button", { name: label });
      expect(buttons).toHaveLength(label === "编辑" ? 1 : 2);
      expect(buttons.every((button) => button.classList.contains("ant-btn-sm"))).toBe(true);
      expect(buttons[0]).toBeInTheDocument();
    }
    const firstRow = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))!.closest("tr")!;
    const actionLabels = Array.from(firstRow.querySelectorAll(".orders-ledger-actions button")).map((button) => button.textContent?.trim());
    expect(actionLabels.slice(0, 6)).toEqual(["售出", "运营", "返点", "资金收支", "分润配置", "编辑"]);
    expect(actionLabels.indexOf("取消")).toBeGreaterThan(actionLabels.indexOf("编辑"));
    expect(actionLabels).not.toContain("删除");
    await ui.click(within(firstRow).getByRole("button", { name: "运营" }));
    for (const label of ["寄售（上架）", "描述", "作图"]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("menuitem", { name: "下架" })).toBeNull();
  });

  it("待售代挂订单的操作入口显示下架而不是取消", async () => {
    setupLedgerApi([
      ...orders,
      {
        id: 3,
        order_no: "DG-2026-0003",
        order_type: "DG",
        trade_date: "2026-10-03",
        status: "ACTIVE",
        account_id: 9,
        account_status: "WAITING",
      },
    ]);
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 9, source_order_id: 3, source_order_no: "DG-2026-0003", inventory_type: "CONSIGNMENT", status: "WAITING", cost_amount: "0.00" },
      orders: [{
        order_id: 3,
        order_no: "DG-2026-0003",
        order_type: "DG",
        trade_date: "2026-10-03",
        status: "ACTIVE",
        active_consignments: [{ event_id: 301, platform: "寄售平台A", price: null, listed_at: "2026-10-03T10:00:00" }],
        events: [{
          id: 301,
          event_type: "OPERATE",
          operation_type: "CONSIGNMENT",
          form_extra: { consignment_platforms: ["寄售平台A"], listed_at: "2026-10-03T10:00" },
        }],
      }],
    } as never);
    await openLedger("admin");

    const row = screen.getAllByText("DG-2026-0003").find((element) => element.closest("tr"))?.closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "运营" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "下架" }));
    expect(await screen.findByText("下架")).toBeInTheDocument();
    expect(await screen.findByText("寄售平台A")).toBeInTheDocument();
    // 只断言这一行不提供「取消」入口；页面上其它行/库存中心自带「取消」按钮，不能全局查。
    expect(within(row as HTMLElement).queryByText("取消")).toBeNull();
  });

  it("回收订单有活跃寄售记录时运营菜单显示下架（与库存中心对齐）", async () => {
    setupLedgerApi([{ ...orders[0], account_id: 1 }]);
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, source_order_id: 1, source_order_no: "HS-2026-0001", inventory_type: "RECOVERY", status: "WAITING", cost_amount: "100.00" },
      orders: [{
        order_id: 1,
        order_no: "HS-2026-0001",
        order_type: "HS",
        trade_date: "2026-10-01",
        status: "ACTIVE",
        active_consignments: [{ event_id: 29, platform: "千寻", price: null, listed_at: "2026-11-01T10:00:00" }],
        events: [{
          id: 29,
          event_type: "OPERATE",
          operation_type: "CONSIGNMENT",
          form_extra: { consignment_platforms: ["千寻"], listed_at: "2026-11-01T10:00" },
        }],
      }],
    } as never);
    await openLedger("admin");

    const row = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))?.closest("tr");
    expect(row).not.toBeNull();
    await ui.click(within(row as HTMLElement).getByRole("button", { name: "运营" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "下架" })).toBeInTheDocument());
  });

  it("运营下拉在详情缓存过期后仍反映最新寄售记录", async () => {
    const account = { id: 1, source_order_id: 1, source_order_no: "HS-2026-0001", inventory_type: "RECOVERY", status: "WAITING", cost_amount: "100.00" };
    const baseOrder = { order_id: 1, order_no: "HS-2026-0001", order_type: "HS", trade_date: "2026-10-01", status: "ACTIVE" };
    const stale = { account, orders: [{ ...baseOrder, events: [], active_consignments: [] }] };
    const fresh = {
      account,
      orders: [{
        ...baseOrder,
        active_consignments: [{ event_id: 29, platform: "千寻", price: null, listed_at: "2026-11-19T21:25:00" }],
        events: [{ id: 29, event_type: "OPERATE", operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["千寻"], listed_at: "2026-11-19T21:25" } }],
      }],
    };
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(stale as never);
    setupLedgerApi([{ ...orders[0], account_id: 1 }]);
    await openLedger("admin");

    // 先展开行，让台账缓存一份「无寄售」的旧详情。
    const row = screen.getAllByText("HS-2026-0001").find((e) => e.closest("tr"))?.closest("tr");
    fireEvent.click(row!.querySelector(".ant-table-row-expand-icon") as Element);
    await waitFor(() => expect(ordersApi.executionDetail).toHaveBeenCalledWith(1, { imagePreviews: true }));

    // 随后在别处登记了寄售；回到台账点开运营下拉应拿到最新详情并显示下架。
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(fresh as never);
    const refreshedRow = screen.getAllByText("HS-2026-0001").find((e) => e.closest("tr"))?.closest("tr");
    await ui.click(within(refreshedRow as HTMLElement).getByRole("button", { name: "运营" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "下架" })).toBeInTheDocument());
  });

  it("平台下架后已展开的订单台账详情显示新的下架记录", async () => {
    const account = { id: 1, source_order_id: 1, source_order_no: "HS-2026-0001", inventory_type: "RECOVERY", status: "WAITING", cost_amount: "100.00" };
    const listing = { id: 29, event_type: "OPERATE", operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["千寻"], listed_at: "2026-11-01T10:00" } };
    const order = { order_id: 1, order_no: "HS-2026-0001", order_type: "HS", trade_date: "2026-10-01", status: "ACTIVE" };
    const before = { account, orders: [{ ...order, active_consignments: [{ event_id: 29, platform: "千寻", price: null, listed_at: "2026-11-01T10:00:00" }], events: [listing] }] };
    const after = { account, orders: [{ ...order, active_consignments: [], events: [listing, {
      id: 30, event_type: "OPERATE", operation_type: "UNLIST", reason: "平台停售", form_extra: { consignment_event_id: 29, consignment_platforms: ["千寻"], platform_unlist_scope: "PLATFORM" },
    }] }] };
    let unlisted = false;
    vi.mocked(ordersApi.executionDetail).mockImplementation(async () => (unlisted ? after : before) as never);
    vi.mocked(ordersApi.postEvent).mockImplementationOnce(async () => { unlisted = true; return {} as never; });
    setupLedgerApi([{ ...orders[0], account_id: 1 }]);
    await openLedger("admin");

    const row = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))!.closest("tr")!;
    fireEvent.click(row.querySelector(".ant-table-row-expand-icon") as Element);
    await waitFor(() => expect(document.querySelector(".order-detail__section--operation")).toHaveTextContent("千寻"));
    await ui.click(within(row).getByRole("button", { name: "运营" }));
    await ui.click(await screen.findByRole("menuitem", { name: "下架" }));
    await ui.click(await screen.findByRole("combobox", { name: "下架平台" }));
    await ui.click(await screen.findByText(/千寻（上架于/, { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("下架原因"), "平台停售");
    await ui.click(screen.getByRole("button", { name: "确认下架" }));

    await waitFor(() => expect(document.querySelector(".order-detail__section--operation")).toHaveTextContent("千寻 / 下架原因：平台停售"));
  });

  it("代挂从本系统出库后已展开的订单台账详情显示出库记录", async () => {
    const account = { id: 9, source_order_id: 3, source_order_no: "DG-2026-0003", inventory_type: "CONSIGNMENT", status: "WAITING", created_at: "2026-10-03T10:00:00" };
    const order = { order_id: 3, order_no: "DG-2026-0003", order_type: "DG", trade_date: "2026-10-03", status: "ACTIVE" };
    const before = { account, orders: [{ ...order, events: [] }] };
    const after = { account: { ...account, status: "VOID" }, orders: [{ ...order, status: "CANCELLED", events: [{
      id: 31, event_type: "OPERATE", operation_type: "UNLIST", reason: "代挂结束", form_extra: { platform_unlist_scope: "SYSTEM" },
    }] }] };
    let unlisted = false;
    vi.mocked(ordersApi.executionDetail).mockImplementation(async () => (unlisted ? after : before) as never);
    vi.mocked(ordersApi.inventoryOffsale).mockImplementationOnce(async () => { unlisted = true; return { ok: true }; });
    setupLedgerApi([...orders, { id: 3, order_no: "DG-2026-0003", order_type: "DG", trade_date: "2026-10-03", status: "ACTIVE", account_id: 9, account_status: "WAITING" }]);
    await openLedger("admin");

    const row = screen.getAllByText("DG-2026-0003").find((element) => element.closest("tr"))!.closest("tr")!;
    fireEvent.click(row.querySelector(".ant-table-row-expand-icon") as Element);
    await waitFor(() => expect(document.querySelector(".order-detail__section--operation")).toBeInTheDocument());
    await ui.click(within(row).getByRole("button", { name: "运营" }));
    await ui.click(await screen.findByRole("menuitem", { name: "下架" }));
    await ui.click(await screen.findByRole("combobox", { name: "下架平台" }));
    await ui.click(await screen.findByText(/本系统（上架于/, { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("下架原因"), "代挂结束");
    await ui.click(screen.getByRole("button", { name: "确认出库" }));

    await waitFor(() => expect(document.querySelector(".order-detail__section--operation")).toHaveTextContent("本系统 / 下架原因：代挂结束"));
  });

  it("已售代挂改走取消，不再引导到下架", async () => {
    const soldConsignment = {
      id: 4,
      order_no: "DG-2026-0004",
      order_type: "DG",
      trade_date: "2026-10-04",
      status: "COMPLETED",
      account_id: 10,
      account_status: "SOLD",
    };
    setupLedgerApi([...orders, soldConsignment]);
    vi.mocked(ordersApi.get).mockResolvedValue({
      ...soldConsignment,
      events: [{ id: 401, order_id: 4, event_no: "EV-401", event_type: "SELL", amount: "500.00", is_posted: true, cancellable_amount: "500.00" }],
    } as never);
    // 打开取消弹窗前会并行拉资金账户与员工；未 mock 时 poolList 为 undefined，
    // openCancelTransaction 内部抛错被 catch 吞掉 → 弹窗不出现。
    vi.mocked(poolsApi.list).mockResolvedValue([
      { id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" },
    ] as never);
    await openLedger("admin");

    const row = screen.getAllByText("DG-2026-0004").find((element) => element.closest("tr"))?.closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(screen.queryByText("下架")).toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "取消" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByText("取消 · DG-2026-0004")).toBeInTheDocument();
    expect(within(modal).getByLabelText("退款金额")).toBeInTheDocument();
    expect(within(modal).getByLabelText("付款账户")).toBeInTheDocument();
    expect(within(modal).getByLabelText("取消原因")).toBeInTheDocument();
    expect(within(modal).queryByLabelText("售出流水")).toBeNull();
    expect(within(modal).queryByLabelText("退款操作人")).toBeNull();
  });

  it("加载失败时展示错误条", async () => {
    vi.mocked(ordersApi.listPage).mockRejectedValue({ isAxiosError: true, message: "Network Error" });
    renderLight(<OrdersPage />);
    await ui.click(await screen.findByRole("tab", { name: "订单台账" }));
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("无关的订单类型接口失败不应影响订单台账", async () => {
    let rejectTypes!: (reason: Error) => void;
    const typesRequest = new Promise<Awaited<ReturnType<typeof orderTypesApi.list>>>((_, reject) => { rejectTypes = reject; });
    void typesRequest.catch(() => {});
    vi.mocked(orderTypesApi.list).mockReturnValue(typesRequest);
    await openLedger();
    await act(async () => { rejectTypes(new Error("订单类型读取失败")); await Promise.resolve(); });
    expect(screen.queryByText(/订单类型读取失败/)).not.toBeInTheDocument();
    expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThan(0);
  });

  it("新建订单菜单提供回收、提号、代挂三个表单", async () => {
    renderLight(<OrdersPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "订单台账" });
    await ui.click(screen.getByRole("button", { name: /新建订单/ }));
    for (const label of ["新建回收订单", "新建提号订单", "新建代挂订单"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  it("库存中心和订单台账的新建订单位于容器标题右侧", async () => {
    renderLight(<OrdersPage />, { user: "admin" });
    const trigger = await screen.findByRole("button", { name: "新建订单" });
    expect(trigger.closest(".ant-card-head")).toHaveTextContent("库存中心");
    await ui.click(screen.getByRole("tab", { name: "订单台账" }));
    expect((await screen.findByRole("button", { name: "新建订单" })).closest(".ant-card-head")).toHaveTextContent("订单台账");
  });

  it("移除没有明确业务含义的通用登记事件入口", async () => {
    renderLight(<OrdersPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "订单台账" });
    expect(screen.queryByRole("button", { name: /登记事件/ })).toBeNull();
  });

  it("订单操作通过取消按钮进入取消并提交原因", async () => {
    vi.mocked(ordersApi.get).mockResolvedValue({ ...orders[0], events: [] });
    vi.mocked(ordersApi.cancel).mockResolvedValue({ ...orders[0], status: "CANCELLED" });
    vi.mocked(poolsApi.list).mockResolvedValue([
      { id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" },
    ] as never);

    await openLedger("admin");
    // 默认页签是库存中心（保持挂载），首个「取消」按钮不属于台账行 —— 必须按行定位。
    const row = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))?.closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "取消" }));

    expect(await screen.findByText("取消 · HS-2026-0001")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("取消原因"), { target: { value: "客户取消" } });
    fireEvent.click(screen.getByRole("button", { name: /确认取消/ }));

    await waitFor(() => expect(vi.mocked(ordersApi.cancel)).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ reason: "客户取消" }),
    ));
  });

  it("未售且有买入流水的取消复用库存中心的退款弹窗", async () => {
    vi.mocked(ordersApi.get).mockResolvedValue({
      ...orders[0],
      events: [{ id: 101, event_no: "EV-101", event_type: "BUY", amount: "100.00", pool_id: 3, is_posted: true, cancellable_amount: "100.00" }],
    } as never);
    vi.mocked(poolsApi.list).mockResolvedValue([
      { id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" },
    ] as never);

    await openLedger("admin");
    fireEvent.click(screen.getAllByRole("button", { name: "取消" })[0]);

    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("退回金额")).toBeInTheDocument();
    expect(within(modal).getByLabelText("收款账户")).toBeInTheDocument();
    expect(within(modal).getByLabelText("取消原因")).toBeInTheDocument();
    expect(modal).toHaveTextContent("取消后账号退出库存，原有资金收支仍计入利润。");
    expect(within(modal).queryByLabelText("入账金额")).toBeNull();
    expect(within(modal).queryByLabelText("入账账户")).toBeNull();
  });

});

// —— 原 OrdersPageAccountEdit.test.tsx ——
// 同一订单台账页面与接口 mock，编辑专项只保留独立 fixture 作用域。
describe("订单台账统一编辑入口（#15 需求1）", () => {
  let accountUi: ReturnType<typeof userEvent.setup>;

  const accountOrders = [
    {
      id: 1, order_no: "HS-2026-0001", order_type: "HS", trade_date: "2026-10-01", status: "ACTIVE", account_id: 99,
      account_game_type: "原神", account_game_account: "seller-001", account_status: "WAITING", party_name: "卖家甲", party_source: "同行推荐",
      sale_amount: "1234.00", last_event_type: "BUY", inventory_operator: "入库员", inventory_entry_at: "2026-10-01T09:30:00", sale_operator: "售卖员", sale_at: "2026-10-17T16:45:00",
    },
    { id: 2, order_no: "TH-2026-0002", order_type: "TH", trade_date: "2026-10-02", status: "COMPLETED" },
  ];
  const accountTypes = [{ id: 1, code: "HS", name: "回收", is_active: true }];

  beforeEach(() => {
    accountUi = userEvent.setup({ pointerEventsCheck: 0 });
    vi.clearAllMocks();
    seedOptionSets();
    seedOrderFormFields();
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse(accountOrders));
    vi.mocked(ordersApi.ledgerSummary).mockResolvedValue(orderLedgerSummary({ total_count: accountOrders.length, status_counts: { ACTIVE: 1, COMPLETED: 1 }, type_counts: { HS: 1, TH: 1 } }));
    vi.mocked(orderTypesApi.list).mockResolvedValue(accountTypes as never);
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse([]) as never);
    vi.mocked(employeesApi.list).mockResolvedValue([{ id: 1, username: "admin", display_name: "管理员", is_active: true }]);
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 99, stock_no: "KU_00001", game_account: "acc-99", game_type: "原神", status: "WAITING", inventory_type: "RECOVERY" },
      orders: [{ order_id: 1, order_no: "HS-2026-0001", order_type: "HS", trade_date: "2026-10-01", status: "ACTIVE", events: [] }],
      finance_summary: { total_income: "0", total_expense: "0", net_profit: "0" },
    } as never);
  });

  it("列表行只展示「编辑」，不再单列「编辑账号」", async () => {
    renderLight(<OrdersPage />, { user: "admin" });
    await accountUi.click(await screen.findByRole("tab", { name: "订单台账" }));
    await waitFor(() => expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThanOrEqual(1));
    const row = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))?.closest("tr");
    expect(row).not.toBeNull();
    await accountUi.click(within(row as HTMLElement).getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("button", { name: "保存修改" })).toBeInTheDocument();
    expect(screen.queryByLabelText("编辑游戏账号/产品")).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑账号" })).toBeNull();
  });

  it("首次编辑只读取一次订单执行详情，并同时供展开区与编辑器使用", async () => {
    renderLight(<OrdersPage />, { user: "admin" });
    await accountUi.click(await screen.findByRole("tab", { name: "订单台账" }));
    const row = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))?.closest("tr");
    await accountUi.click(within(row as HTMLElement).getByRole("button", { name: "编辑" }));
    await screen.findByRole("button", { name: "保存修改" });
    expect(ordersApi.executionDetail).toHaveBeenCalledTimes(1);
    expect(ordersApi.executionDetail).toHaveBeenCalledWith(1, { fresh: true });
  });

  it("只读订单详情加载员工列表并回显交付操作人", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 99, stock_no: "KU_00001", game_account: "acc-99", game_type: "原神", status: "WAITING", inventory_type: "RECOVERY" },
      orders: [{ order_id: 1, order_no: "HS-2026-0001", order_type: "HS", trade_date: "2026-10-01", status: "ACTIVE", extra_values: { delivery_responsible_ids: [1] }, events: [] }],
      finance_summary: { total_income: "0", total_expense: "0", net_profit: "0" },
    } as never);
    renderLight(<OrdersPage />, { user: "admin" });
    await accountUi.click(await screen.findByRole("tab", { name: "订单台账" }));
    const row = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))!.closest("tr")!;
    fireEvent.click(row.querySelector(".ant-table-row-expand-icon") as Element);
    await waitFor(() => expect(screen.getByText("管理员")).toBeInTheDocument());
    expect(screen.queryByText("操作人信息加载中")).toBeNull();
  });

  it("详情请求未返回时展开后编辑也复用同一请求", async () => {
    const detail = {
      account: { id: 99, stock_no: "KU_00001", game_account: "acc-99", game_type: "原神", status: "WAITING", inventory_type: "RECOVERY" },
      orders: [{ order_id: 1, order_no: "HS-2026-0001", order_type: "HS", trade_date: "2026-10-01", status: "ACTIVE", events: [] }],
      finance_summary: { total_income: "0", total_expense: "0", net_profit: "0" },
    };
    let resolveFirst: (value: unknown) => void = () => undefined;
    const firstRequest = new Promise((resolve) => { resolveFirst = resolve; });
    vi.mocked(ordersApi.executionDetail).mockImplementationOnce(() => firstRequest as never).mockResolvedValueOnce(detail as never);
    renderLight(<OrdersPage />, { user: "admin" });
    await accountUi.click(await screen.findByRole("tab", { name: "订单台账" }));
    const row = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))!.closest("tr")!;
    fireEvent.click(row.querySelector(".ant-table-row-expand-icon") as Element);
    await waitFor(() => expect(ordersApi.executionDetail).toHaveBeenCalledTimes(1));
    const refreshedRow = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))!.closest("tr")!;
    await accountUi.click(within(refreshedRow).getByRole("button", { name: "编辑" }));
    await waitFor(() => expect(ordersApi.executionDetail).toHaveBeenCalledTimes(1));
    resolveFirst(detail);
    await screen.findByRole("button", { name: "保存修改" });
    expect(ordersApi.executionDetail).toHaveBeenCalledTimes(1);
  });

  it("未关联库存账号的订单不显示「编辑账号」入口", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([
      { id: 1, order_no: "HS-2026-0001", order_type: "HS", trade_date: "2026-10-01", status: "ACTIVE", account_game_type: "原神", account_game_account: "seller-001", account_status: "WAITING" },
      { id: 2, order_no: "TH-2026-0002", order_type: "TH", trade_date: "2026-10-02", status: "COMPLETED" },
    ]) as never);
    renderLight(<OrdersPage />);
    await accountUi.click(await screen.findByRole("tab", { name: "订单台账" }));
    await waitFor(() => expect(screen.getAllByText("TH-2026-0002").length).toBeGreaterThanOrEqual(1));
    expect(screen.queryAllByRole("button", { name: "编辑账号" }).length).toBe(0);
  });

  it("未绑定库存的历史订单展开时仍可查看订单与资金明细", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([
      { id: 2, order_no: "TH-2026-0002", order_type: "TH", trade_date: "2026-10-02", status: "ACTIVE", account_id: null },
    ]) as never);
    vi.mocked(ordersApi.get).mockResolvedValue({
      id: 2, order_no: "TH-2026-0002", order_type: "TH", trade_date: "2026-10-02", status: "ACTIVE",
      account_id: null, note: "导入订单备注", account_snapshot: { game_account: "历史账号" },
      events: [], cashflows: [{ flow_no: "SR00123", pool_id: 1, occurred_on: "2026-10-03", direction: "IN", category: "OTHER", amount: "25.00", operator: "admin" }], rebates: [],
    } as never);
    renderLight(<OrdersPage />, { user: "admin" });
    await accountUi.click(await screen.findByRole("tab", { name: "订单台账" }));
    const row = (await screen.findByText("TH-2026-0002")).closest("tr")!;
    fireEvent.click(row.querySelector(".ant-table-row-expand-icon") as Element);
    expect(await screen.findByText("导入订单备注")).toBeInTheDocument();
    expect(screen.getByText("历史账号")).toBeInTheDocument();
    expect(screen.getByText("SR00123")).toBeInTheDocument();
    expect(ordersApi.executionDetail).not.toHaveBeenCalled();
  });
});
