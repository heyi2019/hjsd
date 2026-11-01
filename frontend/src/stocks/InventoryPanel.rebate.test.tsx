import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";
import { InventoryRebateModal } from "./InventoryRebateModal";

import * as catalog from "../shared/api/catalog";
import { resolveMock } from "../test/mock-api";
import { seedOptionSets } from "../test/formFieldsSeed";
import { clearOptionSetsCache } from "../shared/lib/optionSets";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  clearOptionSetsCache();
});

vi.mock("../shared/api/catalog")

const accounts = [
  { id: 1, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "A平台", status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, source_order_no: "TH-2026-0002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

beforeEach(() => {
  vi.clearAllMocks();
  seedOptionSets(catalog);
  vi.mocked(catalog.stocksApi.list).mockResolvedValue(accounts);
  resolveMock(vi.mocked(catalog.ordersApi.create), { id: 21 });
  resolveMock(vi.mocked(catalog.ordersApi.postEvent), {});
  resolveMock(vi.mocked(catalog.customersApi.list), [{ id: 7, display_name: "买家A", status: "ACTIVE" }]);
  resolveMock(vi.mocked(catalog.poolsApi.list), [{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }]);
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(catalog.rebatesApi.create), { id: 31 });
  vi.mocked(catalog.rebatesApi.list).mockResolvedValue([{
    id: 41,
    rebate_no: "HS0001-RB01",
    source_order_id: 21,
    rebate_type: "BUY",
    channel: "买号返点",
    rate: "5.00",
    base_amount: "1000.00",
    status: "OPEN",
    collected_on: "2026-10-17",
    operator: "何一",
  }]);
  resolveMock(vi.mocked(catalog.installmentsApi.create), { id: 41 });
  resolveMock(vi.mocked(catalog.stocksApi.executionDetail), {
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
  resolveMock(vi.mocked(catalog.stocksApi.updateProfile), accounts[0]);
});

describe("InventoryPanel：写入与长路径", () => {
it("寄售展示中介平台配置和精确到分钟的上架时间", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "寄售" }));
    expect(await screen.findByText("登记寄售")).toBeInTheDocument();
    expect(screen.getByLabelText("上架时间").getAttribute("value")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(screen.getByText(/每次确认只登记一个平台/)).toBeInTheDocument();
    expect(await screen.findByText("已上架记录")).toBeInTheDocument();
  });

it("返点按买入与售出订单区分类型并登记", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "返点" }));
    expect(await screen.findByText("登记返点")).toBeInTheDocument();
    expect(screen.queryByText(/关联业务订单创建后即可登记返点/)).toBeNull();
    expect(screen.getByLabelText("买号返点（对应回收/提号）")).toBeChecked();
    expect(screen.getByLabelText("卖号返点（对应售出）")).toBeEnabled();
    await ui.click(screen.getByLabelText("卖号返点（对应售出）"));
    expect(screen.getByLabelText("买号返点（对应回收/提号）")).not.toBeChecked();
    expect(screen.getByLabelText("卖号返点（对应售出）")).toBeChecked();
    await ui.click(screen.getByLabelText("买号返点（对应回收/提号）"));
    expect(screen.getByLabelText("买号返点（对应回收/提号）")).toBeChecked();
    expect(screen.getByLabelText("卖号返点（对应售出）")).not.toBeChecked();
    await ui.click(screen.getByLabelText("卖号返点（对应售出）"));
    await ui.click(screen.getByRole("button", { name: "确认登记" }));

    await waitFor(() => expect(vi.mocked(catalog.rebatesApi.create)).toHaveBeenCalled());
    expect(vi.mocked(catalog.rebatesApi.create).mock.calls[0][0]).toMatchObject({
      source_order_id: 23,
      rebate_type: "SELL",
      base_amount: "350.00",
      channel: "卖号返点",
    });
  });

it("登记返点弹窗展示关联订单的返点明细", async () => {
  renderLight(<InventoryRebateModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  expect(await screen.findByText("返点明细")).toBeInTheDocument();
  expect(screen.getByText("HS0001-RB01")).toBeInTheDocument();
  expect(screen.getByText("何一")).toBeInTheDocument();
  expect(document.querySelector(".adaptive-business-modal.business-registration-modal")).toBeTruthy();
  expect(document.querySelectorAll(".rebate-core-fields > .ant-form-item")).toHaveLength(4);
  expect(screen.getByLabelText("操作人")).toBeInTheDocument();
  expect(document.querySelector(".inventory-rebate-details .ant-table-pagination")).toBeNull();
  expect(screen.queryByText("已结算")).toBeNull();
  expect(screen.queryByText("未结算")).toBeNull();
});

it("操作人接口失败时显示错误，不伪造空操作人列表", async () => {
  vi.mocked(catalog.employeesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" } as unknown as never);
  renderLight(<InventoryRebateModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  await waitFor(() => expect(document.querySelector(".ui-error-banner")).toBeTruthy());
  expect(screen.getByLabelText("操作人")).toBeInTheDocument();
});

it("提号分销已登记 BUY 后可登记买号返点", async () => {
  resolveMock(vi.mocked(catalog.stocksApi.executionDetail), {
    account: accounts[1],
    orders: [{
      order_id: 22, order_no: "TH0002", order_type: "TH", trade_date: "2026-10-15", created_at: "2026-10-15T10:19:00", status: "ACTIVE",
      events: [{ id: 32, event_no: "EV0002", event_type: "BUY", amount: "200.00", occurred_on: "2026-10-15", occurred_at: "2026-10-15T10:20:00", portion: "PRINCIPAL", is_posted: true, operator: "admin" }],
    }],
  });
  renderLight(<InventoryRebateModal account={accounts[1]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  expect(await screen.findByLabelText("买号返点（对应回收/提号）")).toBeChecked();
});
});
