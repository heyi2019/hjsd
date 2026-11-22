import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { counterpartiesApi, customersApi } from "@/shared/api/customers.api";
import { installmentsApi } from "@/shared/api/installments.api";
import { orderFormFieldsApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { rebatesApi } from "@/shared/api/rebates.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { resolveMock } from "@fixtures/mock-api";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { inventoryLedgerResponse } from "@fixtures/api-responses";
import { clearOptionSetsCache } from "@/shared/lib/optionSets";

export const accounts = [
  { id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "A平台", status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, source_order_id: 22, source_order_no: "TH-2026-0002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

export function setupInventoryWrite() {
  clearOptionSetsCache();
  vi.clearAllMocks();
  vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
  seedOptionSets();
  vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse([{
      account: accounts[0],
      order: {
        id: 21,
        order_no: "HS-2026-0001",
        order_type: "HS",
        trade_date: "2026-10-15",
        account_id: 1,
        account_status: "WAITING",
        status: "ACTIVE",
      },
    }], {
      type_counts: { RECOVERY: 1 },
      game_types: ["王者荣耀"],
      stats: { account_count: 1, occupied_cost: "100.00", over_7d_count: 0, over_30d_count: 0 },
    }) as never);
  resolveMock(vi.mocked(ordersApi.create), { id: 21 });
  resolveMock(vi.mocked(ordersApi.postEvent), {});
  resolveMock(vi.mocked(ordersApi.stockSale), {});
  resolveMock(vi.mocked(ordersApi.addCustomerRole), { id: 21 });
  resolveMock(vi.mocked(customersApi.page), { items: [{ id: 7, display_name: "买家A", status: "ACTIVE" }], total: 1, limit: 500, offset: 0 });
  vi.mocked(customersApi.options).mockResolvedValue([{ id: 7, customer_no: "C0007", display_name: "买家A" }]);
  resolveMock(vi.mocked(poolsApi.list), [{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }]);
  vi.mocked(counterpartiesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(rebatesApi.create), { id: 31 });
  vi.mocked(rebatesApi.list).mockResolvedValue([{
    id: 41,
    rebate_no: "HS0001-RB01",
    source_order_id: 21,
    rebate_type: "BUY",
    channel: "买号返点",
    amount: "1000.00",
    status: "OPEN",
    collected_on: "2026-10-17",
    operator: "何一",
  }] as never);
  resolveMock(vi.mocked(installmentsApi.create), { id: 41 });
  resolveMock(vi.mocked(installmentsApi.pay), { id: 51 });
  resolveMock(vi.mocked(installmentsApi.previewSalePlan), { per_period_service_fee: "0", per_period: "600" });
  vi.mocked(ordersApi.executionDetail).mockResolvedValue({
    account: accounts[0],
    orders: [{
      order_id: 21,
      order_no: "HS0001",
      order_type: "HS",
      trade_date: "2026-10-15",
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
        note: "回收登记",
        cashflow: { flow_no: "CF0001", pool_name: "利润池", occurred_on: "2026-10-15", direction: "OUT", category: "BUY", amount: "100.00" },
      }, {
        id: 33,
        event_no: "EV0003",
        event_type: "SELL",
        amount: "350.00",
        occurred_on: "2026-10-16",
        occurred_at: "2026-10-16T16:45:00",
        portion: "PROFIT",
        is_posted: true,
        operator: "admin",
      }],
    }],
  } as never);
  vi.mocked(employeesApi.list).mockResolvedValue([{ id: 1, username: "admin", display_name: "管理员", is_active: true }, { id: 2, username: "bob", display_name: "小红", is_active: true }]);
  return userEvent.setup({ pointerEventsCheck: 0 });
}
