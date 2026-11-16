import { beforeEach, vi } from "vitest";
import { cashflowsApi } from "@/shared/api/cashflows.api";
import { orderCashflowsApi } from "@/shared/api/orderCashflows.api";
import { counterpartiesApi, customersApi } from "@/shared/api/customers.api";
import { installmentsApi } from "@/shared/api/installments.api";
import { ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { rebatesApi } from "@/shared/api/rebates.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { resolveMock } from "@fixtures/mock-api";
import { seedOptionSets, seedOrderFormFields } from "@fixtures/formFieldsSeed";

export const accounts = [
  { id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", stock_no: "KU_00001", game_account: "acc-1", platform: "A平台", status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, source_order_id: 22, source_order_no: "TH-2026-0002", stock_no: "KU_00002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

// 库存编号（KU 编码）专项 fixture：含 DG 代挂衍生账号，供 InventoryPanel.stockNo 测试覆盖多业务类型。
// 与共享 `accounts` 解耦，避免影响台账统计类断言（在库/已售计数依赖 accounts 条数）。
export const stockNoAccounts = [
  { id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", stock_no: "KU_00001", game_account: "acc-1", platform: "A平台", status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00" },
  { id: 2, source_order_id: 22, source_order_no: "TH-2026-0002", stock_no: "KU_00002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
  { id: 3, source_order_id: 23, source_order_no: "DG-2026-0003", stock_no: "KU_00003", game_account: "acc-3", platform: "C平台", status: "WAITING", inventory_type: "CONSIGNMENT", cost_amount: "300.00", buy_date: "2026-10-03", created_by: "admin", created_at: "2026-10-03T09:30:00" },
  { id: 4, source_order_id: 24, source_order_no: "TH-2026-0004", stock_no: "KU_00004", game_account: "acc-4", platform: "D平台", status: "WAITING", inventory_type: "PICKUP", cost_amount: "400.00", buy_date: "2026-10-04", created_by: "admin", created_at: "2026-10-04T09:30:00" },
];

export const resetInventoryPanelMocks = () => {
  vi.clearAllMocks();
  vi.mocked(stocksApi.list).mockResolvedValue(accounts);
  vi.mocked(stocksApi.inventoryLedger).mockResolvedValue({
    items: [{
      account: accounts[0],
      order: {
        id: 21,
        order_no: "HS-2026-0001",
        order_type: "HS",
        capital_type: "SELF",
        trade_date: "2026-10-15",
        account_id: 1,
        account_status: "WAITING",
        status: "ACTIVE",
      },
    }],
    total: 1,
    facet_total: 1,
    type_counts: { RECOVERY: 1 },
    game_types: ["王者荣耀"],
    stats: { account_count: 1, occupied_cost: "100.00", over_7d_count: 0, over_30d_count: 0 },
  } as never);
  vi.mocked(ordersApi.list).mockResolvedValue([{
    id: 21,
    order_no: "HS-2026-0001",
    order_type: "HS",
    capital_type: "SELF",
    trade_date: "2026-10-15",
    account_id: 1,
    account_status: "WAITING",
    status: "ACTIVE",
  }, {
    id: 23,
    order_no: "TH0003",
    order_type: "TH",
    capital_type: "PEER",
    trade_date: "2026-10-16",
    account_id: 3,
    account_status: "WAITING",
    status: "ACTIVE",
  }, {
    id: 24,
    order_no: "TH0004",
    order_type: "TH",
    capital_type: "PEER",
    trade_date: "2026-10-17",
    account_id: 4,
    account_status: "WAITING",
    status: "ACTIVE",
  }] as never);
  // T19/T20：建单表单字段与选项词典改为从配置读取，测试需默认种子，否则下拉无选项。
  seedOrderFormFields();
  seedOptionSets();
  resolveMock(vi.mocked(ordersApi.create), { id: 21 });
  resolveMock(vi.mocked(ordersApi.postEvent), {});
  resolveMock(vi.mocked(orderCashflowsApi.create), {});
  resolveMock(vi.mocked(customersApi.list), [{ id: 7, display_name: "买家A", status: "ACTIVE" }]);
  resolveMock(vi.mocked(poolsApi.list), [{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }]);
  vi.mocked(counterpartiesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(rebatesApi.create), { id: 31 });
  resolveMock(vi.mocked(rebatesApi.list), []);
  resolveMock(vi.mocked(installmentsApi.create), { id: 41 });
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "管理员", is_active: true },
  ]);
  const executionDetail = {
    account: accounts[0],
    // 财务汇总由后端下发：
    // 支出 100.00 = CF0001，收入 1350.00 = 回款 350.00 + 返点金额 1000.00。
    finance_summary: {
      cashflow_income: "350.00",
      rebate_income: "1000.00",
      total_income: "1350.00",
      total_expense: "100.00",
      net_amount: "1250.00",
    },
    orders: [{
      order_id: 21,
      order_no: "HS0001",
      order_type: "HS",
      trade_date: "2026-10-15",
      created_at: "2026-10-15T10:19:00",
      status: "ACTIVE",
      events: [{
        id: 31,
        event_no: "EV0001",
        event_type: "BUY",
        amount: "100.00",
        cancellable_amount: "100.00",
        occurred_on: "2026-10-15",
        occurred_at: "2026-10-15T10:20:00",
        portion: "PRINCIPAL",
        is_posted: true,
        operator: "admin",
        cashflow: { flow_no: "CF0001", pool_name: "利润池", occurred_on: "2026-10-15", direction: "OUT", nature: "BUSINESS_OUT", category: "BUY", amount: "100.00" },
      }, {
        id: 33,
        event_no: "EV0003",
        event_type: "CANCEL",
        amount: "0.00",
        cancellable_amount: "0.00",
        occurred_on: "2026-10-17",
        occurred_at: "2026-10-17T11:35:00",
        portion: "GROSS",
        is_posted: true,
        operator: "admin",
      }],
      rebates: [{
        id: 41,
        rebate_no: "HS0001-RB01",
        rebate_type: "BUY",
        channel: "买号返点",
        rate: "5.00",
        amount: "1000.00",
        status: "OPEN",
        collected_on: "2026-10-17",
        collected_at: "2026-10-17T12:30:00",
      }],
    }, {
      order_id: 22,
      order_no: "DG0001",
      order_type: "DG",
      trade_date: "2026-10-12",
      created_at: "2026-10-12T09:10:00",
      status: "ACTIVE",
      counterparties: [{ id: 11, display_name: "寄售平台A", role: "PLATFORM" }],
      events: [],
    }, {
      order_id: 23,
      order_no: "HS0002",
      order_type: "HS",
      trade_date: "2026-10-16",
      created_at: "2026-10-16T16:44:00",
      status: "ACTIVE",
      events: [{
        id: 34,
        event_no: "EV0004",
        event_type: "SELL",
        amount: "350.00",
        cancellable_amount: "350.00",
        occurred_on: "2026-10-16",
        occurred_at: "2026-10-16T16:45:00",
        portion: "PROFIT",
        is_posted: true,
        operator: "admin",
        cashflow: { flow_no: "CF0002", pool_name: "利润池", occurred_on: "2026-10-16", direction: "IN", nature: "BUSINESS_IN", category: "SELL", amount: "350.00" },
      }],
    }],
  };
  // 展开详情走订单级接口；测试夹具复用同一份明细快照，但不改变生产端的请求路径。
  vi.mocked(ordersApi.executionDetail).mockImplementation(async (orderId) => {
    const detail = executionDetail as any;
    const order = detail?.orders?.find((item: { order_id: number }) => item.order_id === orderId);
    if (!order) return detail as never;
    const flows = [
      ...(order.events ?? []).flatMap((event: { cashflow?: { direction: string; amount: string } | null }) => event.cashflow ? [event.cashflow] : []),
      ...(order.cashflows ?? []),
    ];
    const cashflowIncome = flows.filter((flow: { direction: string }) => flow.direction === "IN").reduce((sum: number, flow: { amount: string }) => sum + Number(flow.amount), 0);
    const totalExpense = flows.filter((flow: { direction: string }) => flow.direction === "OUT").reduce((sum: number, flow: { amount: string }) => sum + Number(flow.amount), 0);
    const rebateIncome = (order.rebates ?? []).reduce((sum: number, rebate: { amount: string }) => sum + Number(rebate.amount), 0);
    return {
      ...detail,
      orders: [order],
      finance_summary: {
        cashflow_income: cashflowIncome.toFixed(2),
        rebate_income: rebateIncome.toFixed(2),
        total_income: (cashflowIncome + rebateIncome).toFixed(2),
        total_expense: totalExpense.toFixed(2),
        net_amount: (cashflowIncome + rebateIncome - totalExpense).toFixed(2),
      },
    } as never;
  });
  resolveMock(vi.mocked(stocksApi.updateProfile), accounts[0]);
};

export const setupInventoryPanelMocks = () => {
  beforeEach(() => resetInventoryPanelMocks());
};
