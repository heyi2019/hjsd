import { beforeEach, vi } from "vitest";
import type { AccountExecutionDetail } from "../shared/api/catalog";
import * as catalog from "../shared/api/catalog";
import { resolveMock } from "../test/mock-api";
import { seedOptionSets, seedOrderFormFields } from "../test/formFieldsSeed";

export const accounts = [
  { id: 1, source_order_no: "HS-2026-0001", stock_no: "KU_00001", game_account: "acc-1", platform: "A平台", status: "IN_STOCK", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, source_order_no: "TH-2026-0002", stock_no: "KU_00002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

// 库存编号（KU 编码）专项 fixture：含 DG 代挂 / DFQ 代分期衍生账号，供 InventoryPanel.stockNo 测试覆盖多业务类型。
// 与共享 `accounts` 解耦，避免影响台账统计类断言（在库/已售计数依赖 accounts 条数）。
export const stockNoAccounts = [
  { id: 1, source_order_no: "HS-2026-0001", stock_no: "KU_00001", game_account: "acc-1", platform: "A平台", status: "IN_STOCK", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00" },
  { id: 2, source_order_no: "TH-2026-0002", stock_no: "KU_00002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
  { id: 3, source_order_no: "DG-2026-0003", stock_no: "KU_00003", game_account: "acc-3", platform: "C平台", status: "IN_STOCK", inventory_type: "CONSIGNMENT", cost_amount: "300.00", buy_date: "2026-10-03", created_by: "admin", created_at: "2026-10-03T09:30:00" },
  { id: 4, source_order_no: "DFQ-2026-0004", stock_no: "KU_00004", game_account: "acc-4", platform: "D平台", status: "IN_STOCK", inventory_type: "RECOVERY", cost_amount: "400.00", buy_date: "2026-10-04", created_by: "admin", created_at: "2026-10-04T09:30:00" },
];

export const resetInventoryPanelMocks = () => {
  vi.clearAllMocks();
  vi.mocked(catalog.accountsApi.list).mockResolvedValue(accounts);
  // T19/T20：建单表单字段与选项词典改为从配置读取，测试需默认种子，否则下拉无选项。
  seedOrderFormFields(catalog);
  seedOptionSets(catalog);
  resolveMock(vi.mocked(catalog.ordersApi.create), { id: 21 });
  resolveMock(vi.mocked(catalog.ordersApi.postEvent), {});
  resolveMock(vi.mocked(catalog.customersApi.list), [{ id: 7, display_name: "买家A", status: "ACTIVE" }]);
  resolveMock(vi.mocked(catalog.poolsApi.list), [{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }]);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(catalog.rebatesApi.create), { id: 31 });
  resolveMock(vi.mocked(catalog.installmentsApi.create), { id: 41 });
  resolveMock(vi.mocked(catalog.accountsApi.executionDetail), {
    account: accounts[0],
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
        base_amount: "1000.00",
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
        occurred_on: "2026-10-16",
        occurred_at: "2026-10-16T16:45:00",
        portion: "PROFIT",
        is_posted: true,
        operator: "admin",
        cashflow: { flow_no: "CF0002", pool_name: "利润池", occurred_on: "2026-10-16", direction: "IN", nature: "BUSINESS_IN", category: "SELL", amount: "350.00" },
      }],
    }],
  });
  resolveMock(vi.mocked(catalog.accountsApi.updateProfile), accounts[0]);
};

export const setupInventoryPanelMocks = () => {
  beforeEach(() => resetInventoryPanelMocks());
};

export type InventoryDetailFixture = AccountExecutionDetail;
