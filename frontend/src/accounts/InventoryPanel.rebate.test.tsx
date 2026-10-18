import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

const accountsList = vi.fn();
const accountsExecutionDetail = vi.fn();
const accountsUpdateProfile = vi.fn();
const ordersCreate = vi.fn();
const ordersPostEvent = vi.fn();
const customersList = vi.fn();
const poolsList = vi.fn();
const counterpartiesList = vi.fn();
const rebatesCreate = vi.fn();
const installmentsCreate = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  accountsApi: {
    list: (...a: unknown[]) => accountsList(...a),
    executionDetail: (...a: unknown[]) => accountsExecutionDetail(...a),
    updateProfile: (...a: unknown[]) => accountsUpdateProfile(...a),
  },
  ordersApi: {
    create: (...a: unknown[]) => ordersCreate(...a),
    postEvent: (...a: unknown[]) => ordersPostEvent(...a),
  },
  customersApi: { list: (...a: unknown[]) => customersList(...a) },
  poolsApi: { list: (...a: unknown[]) => poolsList(...a) },
  counterpartiesApi: { list: (...a: unknown[]) => counterpartiesList(...a) },
  rebatesApi: { create: (...a: unknown[]) => rebatesCreate(...a) },
  installmentsApi: { create: (...a: unknown[]) => installmentsCreate(...a) },
}));

const accounts = [
  { id: 1, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "A平台", status: "IN_STOCK", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, source_order_no: "TH-2026-0002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

beforeEach(() => {
  vi.clearAllMocks();
  accountsList.mockResolvedValue(accounts);
  ordersCreate.mockResolvedValue({ id: 21 });
  ordersPostEvent.mockResolvedValue({});
  customersList.mockResolvedValue([{ id: 7, display_name: "买家A", status: "ACTIVE" }]);
  poolsList.mockResolvedValue([{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }]);
  counterpartiesList.mockResolvedValue([]);
  rebatesCreate.mockResolvedValue({ id: 31 });
  installmentsCreate.mockResolvedValue({ id: 41 });
  accountsExecutionDetail.mockResolvedValue({
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
  accountsUpdateProfile.mockResolvedValue(accounts[0]);
});

describe("InventoryPanel：写入与长路径", () => {
it("寄售可以勾选寄售平台并登记 DG 业务", async () => {
    counterpartiesList.mockResolvedValueOnce([
      { id: 11, counterparty_no: "CP0011", display_name: "寄售平台A", type: "PLATFORM", status: "ACTIVE" },
      { id: 12, counterparty_no: "CP0012", display_name: "寄售平台B", type: "PLATFORM", status: "ACTIVE" },
    ]);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(screen.getAllByRole("button", { name: "寄售" })[0]);
    expect(await screen.findByText("登记寄售")).toBeInTheDocument();
    await ui.click(screen.getByLabelText("寄售平台A"));
    await ui.click(screen.getByRole("button", { name: "确认寄售" }));

    await waitFor(() => expect(ordersCreate).toHaveBeenCalled());
    expect(ordersCreate.mock.calls[0][0]).toMatchObject({
      order_type: "DG",
      account_id: 1,
      counterparty_roles: [{ counterparty_id: 11, role: "PLATFORM" }],
    });
  });

it("返点按买入与售出订单区分类型并登记", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(screen.getAllByRole("button", { name: "返点" })[0]);
    expect(await screen.findByText("登记返点")).toBeInTheDocument();
    expect(screen.getByLabelText("买号返点（对应回收）")).toBeChecked();
    expect(screen.getByLabelText("卖号返点（对应售出）")).toBeEnabled();
    await ui.click(screen.getByLabelText("卖号返点（对应售出）"));
    await ui.click(screen.getByRole("button", { name: "确认登记" }));

    await waitFor(() => expect(rebatesCreate).toHaveBeenCalled());
    expect(rebatesCreate.mock.calls[0][0]).toMatchObject({
      source_order_id: 23,
      rebate_type: "SELL",
      base_amount: "350.00",
      channel: "卖号返点",
    });
  });
});
