import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { OrdersPage } from "@/orders/OrdersPage";

import * as catalog from "@/shared/api/catalog";
import { seedOptionSets, seedOrderFormFields } from "@fixtures/formFieldsSeed";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("@/shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/catalog")>();
  const METHODS = [
    "list", "get", "create", "update", "patch", "post", "postEvent", "cancel", "remove",
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

const orders = [
  {
    id: 1,
    account_id: 1,
    order_no: "HS-2026-0001",
    order_type: "HS",
    trade_date: "2026-10-01",
    status: "ACTIVE",
    account_game_type: "原神",
    account_game_account: "seller-001",
    account_platform: "安卓",
    account_status: "WAITING",
    party_name: "卖家甲",
    party_source: "同行推荐",
    event_total: "1234.00",
    last_event_type: "BUY",
    inventory_operator: "入库员",
    inventory_entry_at: "2026-10-01T09:30:00",
    sale_operator: "售卖员",
    sale_at: "2026-10-17T16:45:00",
  },
  { id: 2, order_no: "TH-2026-0002", order_type: "TH", trade_date: "2026-10-02", status: "COMPLETED" },
];
const types = [{ id: 1, code: "HS", name: "回收", is_active: true }];

beforeEach(() => {
  vi.clearAllMocks();
  seedOptionSets(catalog);
  seedOrderFormFields(catalog);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue(orders);
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(types);
  vi.mocked(catalog.stocksApi.list).mockResolvedValue([]);
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "管理员", is_active: true },
  ]);
  vi.mocked(catalog.installmentsApi.list).mockResolvedValue([]);
});

async function openLedger(user?: string) {
  renderLight(<OrdersPage />, user ? { user } : undefined);
  await ui.click(await screen.findByRole("tab", { name: "订单台账" }));
  await waitFor(() => expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThanOrEqual(1));
}

describe("OrdersPage：四类订单台账", () => {
  // 原 5 条用例（无流程提示 / 日期区间位置 / 订单编号与状态 / 责任时间列 / 默认视图核心列）
  // 都只用默认夹具 + openLedger 一次进入台账，全是只读断言，合并为一次挂载。
  it("订单台账默认视图：筛选区、识别列与行内业务数据", async () => {
    await openLedger();

    // 筛选栏不展示流程提示文字
    expect(screen.queryByText("状态由对应业务流程更新，点击订单后继续处理付款、入库、售出或回款")).toBeNull();

    // 搜索框右侧紧跟订单日期区间筛选
    const search = screen.getByPlaceholderText("搜索订单号 / 游戏账号/产品 / 对方 / 备注");
    const startDate = screen.getByLabelText("订单日期区间开始日期");
    expect(screen.getByLabelText("订单日期区间结束日期")).toBeInTheDocument();
    expect(search.compareDocumentPosition(startDate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 订单编号与库存状态按行渲染
    expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("TH-2026-0002").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("库存状态").length).toBeGreaterThanOrEqual(1);

    // 入库 / 售卖责任时间列，且行内取数正确
    for (const label of ["入库负责人", "入库时间", "售卖负责人", "售卖时间"]) {
      expect(screen.getByRole("columnheader", { name: label })).toBeInTheDocument();
    }
    const dutyRow = screen.getAllByRole("row").find((item) => within(item).queryByText("HS-2026-0001") !== null)!;
    expect(within(dutyRow).getByText("入库员")).toBeInTheDocument();
    expect(within(dutyRow).getByText("2026-10-01 09:30")).toBeInTheDocument();
    expect(within(dutyRow).getByText("售卖员")).toBeInTheDocument();
    expect(within(dutyRow).getByText("2026-10-17 16:45")).toBeInTheDocument();
    expect(within(dutyRow).getByText("16天7小时15分")).toBeInTheDocument();

    // 默认视图下的核心识别列与取值（完整列清单属配置能力，不在前端锁死）
    for (const label of ["订单号", "金额", "库存状态", "日期", "操作"]) {
      expect(screen.getAllByRole("columnheader", { name: label }).length).toBeGreaterThan(0);
    }
    expect(document.querySelector(".orders-ledger .ant-table-content > table")).toHaveStyle({ tableLayout: "fixed" });
    for (const value of ["原神", "seller-001", "¥1,234.00", "在库"]) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
  });

  it("业务中心重新激活时刷新库存列表", async () => {
    const { rerender } = renderLight(<OrdersPage active={false} />);
    await screen.findByRole("tab", { name: "库存中心" });
    expect(vi.mocked(catalog.stocksApi.list)).not.toHaveBeenCalled();

    rerender(<OrdersPage active />);
    await waitFor(() => expect(vi.mocked(catalog.stocksApi.list)).toHaveBeenCalled());
  });

  it("订单台账顶部展示当前筛选结果的订单统计卡", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([
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
    expect(within(ledger).getByRole("region", { name: "订单台账表格" })).toBeInTheDocument();
    for (const [label, value] of expectedStats) {
      const card = within(ledger).getByText(label).closest(".ui-stat") as HTMLElement | null;
      expect(card).not.toBeNull();
      expect(within(card!).getByText(value)).toBeInTheDocument();
    }
  });

  it("FE-253：订单台账加载未完成时统计卡不显示可信的零", async () => {
    vi.mocked(catalog.ordersApi.list).mockImplementation(() => new Promise(() => undefined));
    renderLight(<OrdersPage initialTab="ledger" />);
    const ledger = await screen.findByRole("tabpanel", { name: "订单台账" });
    const card = within(ledger).getByText("订单总量").closest(".ui-stat") as HTMLElement;
    expect(within(card).getByText("—")).toBeInTheDocument();
    expect(within(card).queryByText("0")).toBeNull();
  });

  it("FE-257：台账有独立「订单状态」列，状态列仍只承载库存状态", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([{
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

  it("订单搜索包含订单备注，支持按批次标记筛选", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([
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

    expect(screen.getAllByText("DG-2026-0003").length).toBeGreaterThan(0);
    expect(screen.queryByText("HS-2026-0001")).toBeNull();
  });

  it("订单台账提供游戏类型下拉筛选", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([
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

  it("订单台账的类型与业务分段筛选带有明确名称", async () => {
    await openLedger();
    expect(screen.getByRole("radiogroup", { name: "类型筛选" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "业务筛选" })).toBeInTheDocument();
  });

  it("订单台账提供库存状态下拉筛选", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([
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

  it("行展开直接复用库存中心的订单详情", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([
      { ...orders[0], account_id: 1 },
      orders[1],
    ]);
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({
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
    expect(vi.mocked(catalog.stocksApi.executionDetail)).toHaveBeenCalledWith(1);
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
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([olderOrder, selectedOrder]);
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({
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

  it("操作列直接提供编辑、分润、资金收支、取消四个小号入口", async () => {
    await openLedger("admin");

    // 不再有「更多」收纳入口
    expect(screen.queryAllByRole("button", { name: "更多" })).toHaveLength(0);
    const expectedCounts = { 编辑: 1, 分润: 2, "资金收支": 2, 取消: 2 };
    for (const label of ["编辑", "分润", "资金收支", "取消"] as const) {
      const buttons = screen.getAllByRole("button", { name: label });
      // 只有关联库存账号的订单才有完整编辑入口；第二条测试订单没有 account_id。
      expect(buttons).toHaveLength(expectedCounts[label]);
      expect(buttons.every((button) => button.classList.contains("ant-btn-sm"))).toBe(true);
      expect(buttons[0]).toBeInTheDocument();
    }
  });

  it("待售代挂订单的操作入口显示下架而不是取消", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([
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
    await openLedger("admin");

    const row = screen.getAllByText("DG-2026-0003").find((element) => element.closest("tr"))?.closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "下架" }));
    expect(screen.getByRole("tab", { name: "库存中心" })).toHaveAttribute("aria-selected", "true");
    // 只断言这一行不提供「取消」入口；页面上其它行/库存中心自带「取消」按钮，不能全局查。
    expect(within(row as HTMLElement).queryByText("取消")).toBeNull();
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
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([...orders, soldConsignment]);
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
      ...soldConsignment,
      events: [{ id: 401, order_id: 4, event_no: "EV-401", event_type: "SELL", amount: "500.00", is_posted: true, cancellable_amount: "500.00" }],
    } as never);
    // 打开取消弹窗前会并行拉资金池与员工；未 mock 时 poolList 为 undefined，
    // openCancelTransaction 内部抛错被 catch 吞掉 → 弹窗不出现。
    vi.mocked(catalog.poolsApi.list).mockResolvedValue([
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
    vi.mocked(catalog.ordersApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<OrdersPage />);
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("新建订单菜单提供回收、提号、代挂三个表单", async () => {
    renderLight(<OrdersPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "订单台账" });
    await ui.click(screen.getByRole("button", { name: /新建订单/ }));
    for (const label of ["新建回收订单", "新建提号订单", "新建代挂订单"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  it("订单操作通过取消按钮进入取消并提交原因", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({ ...orders[0], events: [] });
    vi.mocked(catalog.ordersApi.cancel).mockResolvedValue({ ...orders[0], status: "CANCELLED" });
    vi.mocked(catalog.poolsApi.list).mockResolvedValue([
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

    await waitFor(() => expect(vi.mocked(catalog.ordersApi.cancel)).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ reason: "客户取消" }),
    ));
  });

  it("未售且有买入流水的取消复用库存中心的退款弹窗", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
      ...orders[0],
      events: [{ id: 101, event_no: "EV-101", event_type: "BUY", amount: "100.00", pool_id: 3, is_posted: true, cancellable_amount: "100.00" }],
    } as never);
    vi.mocked(catalog.poolsApi.list).mockResolvedValue([
      { id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" },
    ] as never);

    await openLedger("admin");
    fireEvent.click(screen.getAllByRole("button", { name: "取消" })[0]);

    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("退回金额")).toBeInTheDocument();
    expect(within(modal).getByLabelText("收款账户")).toBeInTheDocument();
    expect(within(modal).getByLabelText("取消原因")).toBeInTheDocument();
    expect(modal).toHaveTextContent("订单状态变为「取消」并退出在库统计。取消不可撤销，历史轨迹保留。");
    expect(within(modal).queryByLabelText("入账金额")).toBeNull();
    expect(within(modal).queryByLabelText("入账账户")).toBeNull();
  });

});
