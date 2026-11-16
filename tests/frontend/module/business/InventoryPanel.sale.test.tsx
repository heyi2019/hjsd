import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { InventoryPanel } from "@/stocks/InventoryPanel";
import { RecoverySaleModal, PickupSaleModal, ConsignmentSaleModal } from "@/stocks/sale";

import { counterpartiesApi, customersApi } from "@/shared/api/customers.api";
import { installmentsApi } from "@/shared/api/installments.api";
import { orderFormFieldsApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { rebatesApi } from "@/shared/api/rebates.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";
import { seedOptionSets, seedOrderFormFields } from "@fixtures/formFieldsSeed";
vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");

const accounts = [
  { id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "A平台", status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, source_order_no: "TH-2026-0002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields();
  seedOptionSets();
  vi.mocked(stocksApi.inventoryLedger).mockResolvedValue({
    items: [{
      account: accounts[0],
      order: {
        id: 21,
        order_no: "HS-2026-0001",
        order_type: "HS",
        capital_type: "SELF",
        trade_date: "2026-10-01",
        account_id: 1,
        account_status: "WAITING",
        status: "ACTIVE",
      },
    }],
    total: 1,
    facet_total: 1,
    type_counts: { RECOVERY: 1 },
    game_types: [],
    stats: { account_count: 1, occupied_cost: "100.00", over_7d_count: 0, over_30d_count: 0 },
  } as never);
  resolveMock(vi.mocked(ordersApi.postEvent), {});
  resolveMock(vi.mocked(ordersApi.addCustomerRole), { id: 21 });
  resolveMock(vi.mocked(customersApi.list), [{ id: 7, display_name: "买家A", status: "ACTIVE" }]);
  resolveMock(vi.mocked(poolsApi.list), [{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }]);
  resolveMock(vi.mocked(employeesApi.list), [{ id: 1, username: "admin", display_name: "管理员", is_active: true }]);
  vi.mocked(counterpartiesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(rebatesApi.create), { id: 31 });
  resolveMock(vi.mocked(installmentsApi.previewSalePlan), {
    per_period_service_fee: "0",
    per_period: "600",
  });
  resolveMock(vi.mocked(installmentsApi.create), { id: 41 });
  resolveMock(vi.mocked(installmentsApi.pay), { id: 51 });
});

it("售出时把新买家关联到来源单而非新建订单", async () => {
  const ui = userEvent.setup({ pointerEventsCheck: 0 });
  resolveMock(vi.mocked(customersApi.list), []);
  resolveMock(vi.mocked(customersApi.create), {
    customer: { id: 8, customer_no: "C0008", display_name: "新买家", status: "ACTIVE" },
    duplicate_candidates: [],
  });
  renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });

  expect(await screen.findByText("买家信息")).toBeInTheDocument();
  expect(screen.getByText("资金明细")).toBeInTheDocument();
  await ui.type(screen.getByLabelText("客户昵称"), "新买家");
  await ui.type(screen.getByLabelText("售出金额"), "350");
  await ui.click(screen.getByLabelText("资金账户"));
  await ui.click(await screen.findByText(/利润池/));
  fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

  await waitFor(() => expect(vi.mocked(customersApi.create)).toHaveBeenCalledWith(expect.objectContaining({
    display_name: "新买家",
  })));
  expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
  expect(vi.mocked(ordersApi.addCustomerRole)).toHaveBeenCalledWith(21, {
    customer_id: 8,
    role: "BUYER",
  });
  expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalledWith(21, expect.objectContaining({
    event_type: "SELL",
    amount: "350",
    pool_id: 3,
    portion: "PROFIT",
  }));
});

it("库存售出：成功后立即从库存列表移除账号，即使列表重拉暂时返回旧快照", async () => {
  const ui = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<InventoryPanel />, { user: "admin" });

  expect(await screen.findByText("acc-1")).toBeInTheDocument();
  await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "售出" }));
  await ui.type(screen.getByLabelText("客户昵称"), "买家A");
  await ui.type(screen.getByLabelText("售出金额"), "350");
  await ui.click(screen.getByLabelText("资金账户"));
  await ui.click(await screen.findByText(/利润池/));
  await ui.click(screen.getByRole("button", { name: /确认售出/ }));

  await waitFor(() => expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText("acc-1")).not.toBeInTheDocument());
});

describe("InventoryPanel：写入与长路径", () => {
it("代挂账号售出：全款收佣金入账、售出金额仅记录、不提供分期并挂寄售方", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce({
      items: [{ account: { ...accounts[0], id: 5, source_order_id: 21, game_account: "acc-5", inventory_type: "CONSIGNMENT" }, order: { id: 21, order_no: "DG-2026-0001", order_type: "DG", capital_type: "SELF", trade_date: "2026-10-01", account_id: 5, account_status: "WAITING", status: "ACTIVE" } }],
      total: 1, facet_total: 1, type_counts: { CONSIGNMENT: 1 }, game_types: [], stats: { account_count: 1, occupied_cost: "50.00", over_7d_count: 0, over_30d_count: 0 },
    } as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-5");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出代挂账号")).toBeInTheDocument();
    // 代挂无买入价：表单直接填利润，而非“售出价 − 买入价”。
    expect(screen.getByLabelText("利润")).toBeInTheDocument();
    expect(screen.getByLabelText("售出金额（仅记录）")).toBeInTheDocument();
    // 代挂售出仅全款，不提供分期付款选项。
    expect(screen.queryByText("付款方式")).toBeNull();
    expect(screen.queryByText("分期付款")).toBeNull();
    await ui.type(screen.getByLabelText("客户昵称"), "买家A");
    await ui.type(screen.getByPlaceholderText("请输入利润（代挂佣金）"), "200");
    await ui.type(screen.getByPlaceholderText("代挂无买入价，此处仅作记录，不计入利润"), "1000");
    await ui.click(screen.getByLabelText("资金账户"));
  await ui.click(await screen.findByText(/利润池/));
    fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));
    await waitFor(() => expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalled());
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
    // 利润=代挂佣金入账；售出金额仅作记录留存于 form_extra，不参与利润。
    expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalledWith(21, expect.objectContaining({
      event_type: "SELL",
      amount: "200",
      pool_id: 3,
      portion: "PROFIT",
      form_extra: { sale_amount: "1000" },
    }));
    expect(vi.mocked(ordersApi.addCustomerRole)).toHaveBeenCalledWith(21, { customer_id: 7, role: "CONSIGNOR" });
    expect(vi.mocked(installmentsApi.create)).not.toHaveBeenCalled();
  });

it("代挂售出复用买号交付信息块，交付负责人提交落库到来源单", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce({
      items: [{ account: { ...accounts[0], id: 5, source_order_id: 21, game_account: "acc-5", inventory_type: "CONSIGNMENT" }, order: { id: 21, order_no: "DG-2026-0001", order_type: "DG", capital_type: "SELF", trade_date: "2026-10-01", account_id: 5, account_status: "WAITING", status: "ACTIVE" } }],
      total: 1, facet_total: 1, type_counts: { CONSIGNMENT: 1 }, game_types: [], stats: { account_count: 1, occupied_cost: "50.00", over_7d_count: 0, over_30d_count: 0 },
    } as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-5");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出代挂账号")).toBeInTheDocument();
    // 复用买号的交付信息块（showIntermediary 默认开启）：含交付负责人与中介/包赔字段。
    expect(screen.getByText("交付负责人")).toBeInTheDocument();
    expect(screen.getByText("交易平台")).toBeInTheDocument();
    expect(screen.getByText("中介类型")).toBeInTheDocument();
    expect(screen.getByText("包赔类型")).toBeInTheDocument();
    await ui.click(screen.getByLabelText("交易平台"));
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("客户昵称"), "买家A");
    await ui.type(screen.getByPlaceholderText("请输入利润（代挂佣金）"), "200");
    await ui.click(screen.getByLabelText("资金账户"));
  await ui.click(await screen.findByText(/利润池/));
    fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));
    await waitFor(() => expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalled());
    // 售出表单中的交付字段（含交付负责人）随售出提交 merge 进来源单 form_extra，详情的卖号交付直接复用。
    await waitFor(() => expect(vi.mocked(ordersApi.patch)).toHaveBeenCalledWith(21, expect.objectContaining({
      form_extra: expect.objectContaining({ delivery_responsible_ids: [1], intermediary_platform: "盼之" }),
    })));
  });

it("提号库存售出可选择分期出售，确立时收首付", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce({
      items: [{ account: { ...accounts[0], id: 6, source_order_id: 21, game_account: "pickup-acc", inventory_type: "PICKUP", cost_amount: "0.00" }, order: { id: 21, order_no: "TH-2026-0001", order_type: "TH", capital_type: "SELF", trade_date: "2026-10-01", account_id: 6, account_status: "WAITING", status: "ACTIVE" } }],
      total: 1, facet_total: 1, type_counts: { PICKUP: 1 }, game_types: [], stats: { account_count: 1, occupied_cost: "0.00", over_7d_count: 0, over_30d_count: 0 },
    } as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("pickup-acc");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出提号账号")).toBeInTheDocument();
    await ui.type(screen.getByLabelText("客户昵称"), "买家A");
    await ui.type(screen.getByPlaceholderText("请输入金额"), "1200");
    await ui.click(await screen.findByText("分期付款"));
    await ui.clear(screen.getByLabelText("首付金额"));
    await ui.type(screen.getByLabelText("首付金额"), "300");
    await ui.click(screen.getByLabelText("资金账户"));
  await ui.click(await screen.findByText(/利润池/));
    await ui.clear(screen.getByLabelText("分期期数"));
    await ui.type(screen.getByLabelText("分期期数"), "2");
    await ui.clear(screen.getByLabelText("每期金额"));
    await ui.type(screen.getByLabelText("每期金额"), "600");
    // 逐期到期日输入按分期期数渲染；尾差/每期金额的计算口径由 sale-plan.test.ts 覆盖。
    expect(screen.getByLabelText("第 1 期到期日")).toBeInTheDocument();
    expect(screen.getByLabelText("第 2 期到期日")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(vi.mocked(installmentsApi.create)).toHaveBeenCalledWith(expect.objectContaining({
      order_id: 21,
      contract_type: "STOCK_SALE",
      principal: "1200",
      down_payment: "300",
    })));
    // 首付在分期计划确立时通过 pay(period_no:0) 入账，金额=首付、进所选资金账户。
    await waitFor(() => expect(vi.mocked(installmentsApi.pay)).toHaveBeenCalledWith(
      41,
      expect.objectContaining({ amount: "300", period_no: 0, pool_id: 3 }),
    ));
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
    // 分期出售先登记 SELL 业务事实；首付再走分期 pay 通道登记资金明细。
    expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalledWith(21, expect.objectContaining({
      event_type: "SELL",
      sale_mode: "INSTALLMENT",
      amount: "1200",
    }));
  });

it("库存中心不为售出单提供取消入口", async () => {
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce({
      items: [], total: 0, facet_total: 0, type_counts: {}, game_types: [], stats: { account_count: 0, occupied_cost: "0.00", over_7d_count: 0, over_30d_count: 0 },
    } as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await waitFor(() => expect(screen.queryByText("acc-2")).toBeNull());
    expect(screen.getByText("暂无账号")).toBeInTheDocument();
    expect(vi.mocked(ordersApi.postEvent)).not.toHaveBeenCalled();
  });
});

describe("库存售出三表单分支", () => {
  it("售出表单统一使用资金明细且不增加支出", async () => {
    renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    expect(await screen.findByText("资金明细")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /增加支出/ })).not.toBeInTheDocument();
    expect(screen.queryByText("售出金额2")).not.toBeInTheDocument();
    expect(screen.queryByText("资金账户2")).not.toBeInTheDocument();
  });

  it("回收、提号、代挂三种售出表单都展示统一的交付信息", async () => {
    const deliveryLabels = ["换绑手机号", "手机号绑定人", "交易平台", "中介类型", "包赔类型", "交付负责人"];
    const cases = [
      [RecoverySaleModal, accounts[0]],
      [PickupSaleModal, { ...accounts[0], inventory_type: "PICKUP" }],
      [ConsignmentSaleModal, { ...accounts[0], inventory_type: "CONSIGNMENT" }],
    ] as const;

    for (const [Modal, account] of cases) {
      const { unmount } = renderLight(<Modal account={account} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
      expect(await screen.findByText("交付信息")).toBeInTheDocument();
      for (const label of deliveryLabels) expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("分期出售只对回收与提号开放，代挂仅全款", async () => {
    const cases = [
      [RecoverySaleModal, accounts[0], "买家信息", true],
      [PickupSaleModal, { ...accounts[0], inventory_type: "PICKUP" }, "买家信息", true],
      [ConsignmentSaleModal, { ...accounts[0], inventory_type: "CONSIGNMENT" }, "委托方信息", false],
    ] as const;

    for (const [Modal, account, buyerSection, supportsInstallment] of cases) {
      const { unmount } = renderLight(<Modal account={account} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
      await screen.findByText(buyerSection);
      if (supportsInstallment) expect(screen.getByText("付款方式")).toBeInTheDocument();
      else expect(screen.queryByText("付款方式")).toBeNull();
      unmount();
    }
  });

  it("三类售出各取独立作用域配置，互不共用", async () => {
    const cases = [
      [RecoverySaleModal, accounts[0], "SALEREC"],
      [PickupSaleModal, { ...accounts[0], inventory_type: "PICKUP" }, "SALETH"],
      [ConsignmentSaleModal, { ...accounts[0], inventory_type: "CONSIGNMENT" }, "SALEDG"],
    ] as const;

    for (const [Modal, account, scope] of cases) {
      vi.mocked(orderFormFieldsApi.list).mockClear();
      vi.mocked(orderFormFieldsApi.listSectionLabels).mockClear();
      const { unmount } = renderLight(<Modal account={account} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
      await waitFor(() => expect(orderFormFieldsApi.list).toHaveBeenCalledWith(scope, true));
      expect(vi.mocked(orderFormFieldsApi.list).mock.calls.every(([code]) => code === scope)).toBe(true);
      expect(orderFormFieldsApi.listSectionLabels).toHaveBeenCalledWith(scope);
      unmount();
    }
  });

  it("P1/FE-042：已拉黑客户不能参与库存售出", async () => {
    vi.mocked(customersApi.list).mockResolvedValueOnce([
      { id: 7, display_name: "买家A", status: "DISABLED" },
    ] as never);
    vi.mocked(poolsApi.list).mockResolvedValue([
      { id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" },
    ] as never);
    vi.mocked(employeesApi.list).mockResolvedValueOnce([
      { id: 1, username: "admin", display_name: "管理员", is_active: true },
    ] as never);
    renderLight(
      <RecoverySaleModal
        account={{ id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", game_account: "acc-1", status: "WAITING", inventory_type: "RECOVERY" } as never}
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
      { user: "admin" },
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await screen.findByText("买家信息");
    await user.type(screen.getByLabelText("客户昵称"), "买家A");
    await user.type(screen.getByLabelText("售出金额"), "350");
    await user.click(screen.getByLabelText("资金账户"));
    await user.click(await screen.findByText(/利润池/));
    await user.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(screen.getByText(/客户已拉黑，不能作为售出买家/)).toBeInTheDocument());
    expect(ordersApi.addCustomerRole).not.toHaveBeenCalled();
    expect(ordersApi.postEvent).not.toHaveBeenCalled();
  });
});
