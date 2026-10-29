import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";
import { InventorySaleModal } from "./InventorySaleModal";

import * as catalog from "../shared/api/catalog";
import { resolveMock, resolveMockOnce } from "../test/mock-api";
import { seedOptionSets, seedOrderFormFields } from "../test/formFieldsSeed";
vi.mock("../shared/api/catalog")

const accounts = [
  { id: 1, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "A平台", status: "IN_STOCK", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, source_order_no: "TH-2026-0002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields(catalog);
  seedOptionSets(catalog);
  vi.mocked(catalog.stocksApi.list).mockResolvedValue(accounts);
  resolveMock(vi.mocked(catalog.ordersApi.create), { id: 21 });
  resolveMock(vi.mocked(catalog.ordersApi.postEvent), {});
  resolveMock(vi.mocked(catalog.customersApi.list), [{ id: 7, display_name: "买家A", status: "ACTIVE" }]);
  resolveMock(vi.mocked(catalog.poolsApi.list), [{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }]);
  resolveMock(vi.mocked(catalog.employeesApi.list), [{ id: 1, username: "admin", display_name: "管理员", is_active: true }]);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(catalog.rebatesApi.create), { id: 31 });
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

it("库存分期售出展示最后一期尾差", async () => {
  const ui = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<InventorySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  await ui.type(screen.getByLabelText("售出金额"), "1000");
  await ui.click(screen.getByText("分期付款"));
  await ui.clear(screen.getByLabelText("分期期数"));
  await ui.type(screen.getByLabelText("分期期数"), "3");
  expect(await screen.findByText("最后一期：333.32 元")).toBeInTheDocument();
  expect(screen.getByLabelText("第 1 期到期日")).toBeInTheDocument();
  expect(screen.getByLabelText("第 2 期到期日")).toBeInTheDocument();
  expect(screen.getByLabelText("第 3 期到期日")).toBeInTheDocument();
});

it("售出时用建单参与方填写新买家并将其关联到订单", async () => {
  const ui = userEvent.setup({ pointerEventsCheck: 0 });
  resolveMock(vi.mocked(catalog.customersApi.list), []);
  resolveMock(vi.mocked(catalog.customersApi.create), {
    customer: { id: 8, customer_no: "C0008", display_name: "新买家", status: "ACTIVE" },
    duplicate_candidates: [],
  });
  renderLight(<InventorySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });

  expect(document.querySelector(".recovery-order-modal")).toBeTruthy();
  expect(await screen.findByText("订单编号")).toBeInTheDocument();
  expect(screen.getByText("HS-2026-0001")).toBeInTheDocument();
  expect(screen.getByText("游戏类型")).toBeInTheDocument();
  expect(screen.getByText("游戏账号")).toBeInTheDocument();
  expect(await screen.findByText("买家信息")).toBeInTheDocument();
  expect(screen.getByText("资金流水")).toBeInTheDocument();
  expect(screen.getByText(/中介类型/)).toBeInTheDocument();
  await ui.type(screen.getByLabelText("客户昵称"), "新买家");
  await ui.type(screen.getByLabelText("售出金额"), "350");
  await ui.click(screen.getByLabelText("收款资金账户"));
  await ui.click(await screen.findByText(/利润池（HJ_PROFIT）/));
  fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

  await waitFor(() => expect(vi.mocked(catalog.customersApi.create)).toHaveBeenCalledWith(expect.objectContaining({
    display_name: "新买家",
  })));
  expect(vi.mocked(catalog.ordersApi.create)).toHaveBeenCalledWith(expect.objectContaining({
    customer_roles: [{ customer_id: 8, role: "BUYER" }],
  }));
});

describe("InventoryPanel：写入与长路径", () => {
it("自营在库账号可以售出并登记 HS 售出事件", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    const sellButton = screen.getAllByRole("button", { name: "售出" }).find((button) => !(button as HTMLButtonElement).disabled);
    expect(sellButton).toBeDefined();
    fireEvent.click(sellButton as HTMLElement);
    expect(await screen.findByText("售出账号")).toBeInTheDocument();

    const modal = screen.getByText("售出账号").closest(".ant-modal-content") as HTMLElement;
    await ui.type(screen.getByLabelText("客户昵称"), "买家A");
    await ui.type(screen.getByPlaceholderText("请输入金额"), "350");
    await ui.click(modal.querySelectorAll(".ant-select-selector")[0] as Element);
    await ui.click(await screen.findByText(/利润池（HJ_PROFIT）/));
    fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(vi.mocked(catalog.ordersApi.create)).toHaveBeenCalled());
    expect(vi.mocked(catalog.ordersApi.create).mock.calls[0][0]).toMatchObject({
      order_type: "HS",
      account_id: 1,
      customer_roles: [{ customer_id: 7, role: "BUYER" }],
    });
    expect(vi.mocked(catalog.ordersApi.postEvent)).toHaveBeenCalledWith(21, expect.objectContaining({
      event_type: "SELL",
      amount: "350",
      pool_id: 3,
      portion: "PROFIT",
    }));
  });

it("代挂账号售出按货源类型生成 DG 订单", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    resolveMockOnce(vi.mocked(catalog.stocksApi.list), [
      { id: 5, game_account: "acc-5", platform: "A平台", status: "IN_STOCK", cost_amount: "50.00", inventory_type: "CONSIGNMENT" },
    ]);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-5");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出账号")).toBeInTheDocument();
    const modal = screen.getByText("售出账号").closest(".ant-modal-content") as HTMLElement;
    await ui.type(screen.getByLabelText("客户昵称"), "买家A");
    await ui.type(screen.getByPlaceholderText("请输入金额"), "200");
    await ui.click(modal.querySelectorAll(".ant-select-selector")[0] as Element);
    await ui.click(await screen.findByText(/利润池（HJ_PROFIT）/));
    fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));
    await waitFor(() => expect(vi.mocked(catalog.ordersApi.create)).toHaveBeenCalled());
    expect(vi.mocked(catalog.ordersApi.create).mock.calls[0][0]).toMatchObject({
      order_type: "DG",
      account_id: 5,
      customer_roles: [{ customer_id: 7, role: "CONSIGNOR" }],
    });
    expect(vi.mocked(catalog.ordersApi.postEvent)).toHaveBeenCalledWith(21, expect.objectContaining({
      event_type: "SELL",
      amount: "200",
      pool_id: 3,
      portion: "PROFIT",
    }));
  });

it("代挂账号出售时选择分期，建立库存分期出售合同而不是直接 SELL", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    resolveMockOnce(vi.mocked(catalog.stocksApi.list), [
      { id: 5, game_account: "acc-5", platform: "A平台", status: "IN_STOCK", cost_amount: "50.00", inventory_type: "CONSIGNMENT" },
    ]);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-5");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    const modal = screen.getByText("售出账号").closest(".ant-modal-content") as HTMLElement;
    await ui.type(screen.getByLabelText("客户昵称"), "买家A");
    await ui.type(screen.getByPlaceholderText("请输入金额"), "200");
    fireEvent.click(screen.getByText("分期付款"));
    await ui.clear(screen.getByLabelText("分期期数"));
    await ui.type(screen.getByLabelText("分期期数"), "2");
    await ui.clear(screen.getByLabelText("每期金额"));
    await ui.type(screen.getByLabelText("每期金额"), "100");
    fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.create)).toHaveBeenCalled());
    expect(vi.mocked(catalog.installmentsApi.create).mock.calls[0][0]).toMatchObject({
      order_id: 21,
      contract_type: "STOCK_SALE",
      principal: "200",
    });
    expect(vi.mocked(catalog.ordersApi.postEvent)).not.toHaveBeenCalled();
  });

it("提号库存从库存中心售出时统一按库存分期出售", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    resolveMockOnce(vi.mocked(catalog.stocksApi.list), [
      { id: 6, game_account: "pickup-acc", platform: "B平台", status: "IN_STOCK", cost_amount: "0.00", inventory_type: "PICKUP" },
    ]);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("pickup-acc");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出账号")).toBeInTheDocument();
    const modal = screen.getByText("售出账号").closest(".ant-modal-content") as HTMLElement;
    await ui.type(screen.getByLabelText("客户昵称"), "买家A");
    await ui.type(screen.getByPlaceholderText("请输入金额"), "1200");
    fireEvent.click(screen.getByText("分期付款"));
    await ui.clear(screen.getByLabelText("分期期数"));
    await ui.type(screen.getByLabelText("分期期数"), "2");
    await ui.clear(screen.getByLabelText("每期金额"));
    await ui.type(screen.getByLabelText("每期金额"), "600");
    fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(vi.mocked(catalog.installmentsApi.create)).toHaveBeenCalledWith(expect.objectContaining({
      order_id: 21,
      contract_type: "STOCK_SALE",
      principal: "1200",
    })));
    expect(vi.mocked(catalog.ordersApi.create).mock.calls[0][0]).toMatchObject({ order_type: "TH", account_id: 6 });
    expect(vi.mocked(catalog.ordersApi.postEvent)).not.toHaveBeenCalled();
  });

it("售出取消交易不在库存中心提供入口", async () => {
    resolveMockOnce(vi.mocked(catalog.stocksApi.list), [{ ...accounts[1], inventory_type: "PICKUP" }]);
    renderLight(<InventoryPanel />, { user: "admin" });
    await waitFor(() => expect(screen.queryByText("acc-2")).toBeNull());
    expect(screen.getByText("暂无账号")).toBeInTheDocument();
    expect(vi.mocked(catalog.ordersApi.postEvent)).not.toHaveBeenCalled();
  });
});
