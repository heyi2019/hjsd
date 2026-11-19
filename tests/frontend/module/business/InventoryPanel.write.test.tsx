import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { InventoryPanel } from "@/business/stocks/InventoryPanel";
import { RecoverySaleModal, PickupSaleModal, ConsignmentSaleModal } from "@/business/stocks/sale";
import { InventoryRebateModal } from "@/business/stocks/rebate";
import { OrderConsignmentModal } from "@/business/operations/consignment";
import { OrderDetailDeliverySection } from "@/business/OrderDetailView/OrderDetailDeliverySection";

import type { Account } from "@/shared/api/types/accounts";
import { counterpartiesApi, customersApi } from "@/shared/api/customers.api";
import { installmentsApi } from "@/shared/api/installments.api";
import { orderFormFieldsApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { rebatesApi } from "@/shared/api/rebates.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { resolveMock } from "@fixtures/mock-api";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { inventoryLedgerResponse } from "@fixtures/api-responses";
import { clearOptionSetsCache } from "@/shared/lib/optionSets";
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

const accounts = [
  { id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "A平台", status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, source_order_id: 22, source_order_no: "TH-2026-0002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  clearOptionSetsCache();
  vi.clearAllMocks();
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
  resolveMock(vi.mocked(ordersApi.addCustomerRole), { id: 21 });
  resolveMock(vi.mocked(customersApi.page), { items: [{ id: 7, display_name: "买家A", status: "ACTIVE" }], total: 1, limit: 500, offset: 0 });
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
});
describe("InventoryPanel：写入与长路径", () => {
  it("代挂在库账号不再提供独立取消入口", async () => {
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse([{
      account: { ...accounts[0], inventory_type: "CONSIGNMENT" },
      order: {
        id: 21,
        order_no: "DG-2026-0001",
        order_type: "DG",
        trade_date: "2026-10-15",
        account_id: 1,
        account_status: "WAITING",
        status: "ACTIVE",
      },
    }], {
      type_counts: { CONSIGNMENT: 1 },
      game_types: ["王者荣耀"],
      stats: { account_count: 1, occupied_cost: "0.00", over_7d_count: 0, over_30d_count: 0 },
    }) as never);

    renderLight(<InventoryPanel />, { user: "admin" });
    const row = await screen.findByText("acc-1");
    expect(within(row.closest("tr") as HTMLElement).queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("库存中心资金收支与订单台账展示同一订单的资金明细和操作人", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");

    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "资金收支" }));

    const modal = await screen.findByRole("dialog", { name: /资金收支 · HS0001/ });
    expect(within(modal).getByText("资金明细")).toBeInTheDocument();
    expect(within(modal).getByRole("table", { name: "资金明细表" })).toHaveTextContent("支出");
    expect(within(modal).getByRole("table", { name: "资金明细表" })).toHaveTextContent("100.00");
    expect(within(modal).getByRole("table", { name: "资金明细表" })).toHaveTextContent("admin");
    expect(within(modal).getByLabelText("操作人")).toBeInTheDocument();
  });

  it("库存编辑直接展开详情，账户资料保持只读", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("button", { name: "保存修改" })).toBeInTheDocument();
    expect(screen.queryByLabelText("编辑游戏账号/产品")).toBeNull();
  });

  it("首次编辑库存账号只读取一次来源订单详情", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");

    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "编辑" }));

    await screen.findByRole("button", { name: "保存修改" });
    expect(ordersApi.executionDetail).toHaveBeenCalledTimes(1);
    expect(ordersApi.executionDetail).toHaveBeenCalledWith(21);
  });

  it("寄售提交成功后无需等详情刷新即可通知页面关闭", async () => {
    const detail = { account: accounts[0], orders: [{ order_id: 21, order_no: "HS0001", order_type: "HS", trade_date: "2026-10-15", status: "ACTIVE", events: [] }] };
    let finish!: (value: never) => void;
    const slowRefresh = new Promise<never>((resolve) => { finish = resolve; });
    vi.mocked(ordersApi.executionDetail).mockResolvedValueOnce(detail as never).mockReturnValueOnce(slowRefresh);
    const onCreated = vi.fn();
    renderLight(<OrderConsignmentModal account={accounts[0] as never} onClose={() => undefined} onCreated={onCreated} />, { user: "admin" });
    const platform = await screen.findByRole("combobox", { name: "寄售平台" });
    await waitFor(() => expect(platform).toBeEnabled());
    await ui.click(platform);
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: "确认上架" }));
    await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    await act(async () => { finish(detail as never); await slowRefresh; });
  });

  it("寄售登记到来源订单，不创建 DG 代挂订单", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "运营" }));
    await ui.click(screen.getByRole("menuitem", { name: "寄售（上架）" }));
    expect(await screen.findByText("登记寄售")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "操作人" }).closest(".ant-select")).toHaveTextContent("管理员"));

    await ui.click(screen.getAllByRole("combobox", { name: "寄售平台" })[0]);
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: "确认上架" }));

    await waitFor(() => expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalledWith(21, expect.objectContaining({
      event_type: "OPERATE",
      operation_type: "CONSIGNMENT",
      form_extra_scope: "CONSIGN",
      operator_user_ids: [1],
    })));
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
  });

  it("返点按买入与售出订单区分类型并登记", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "返点" }));
    expect(await screen.findByText("登记返点")).toBeInTheDocument();
    expect(screen.queryByLabelText("返点日期")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("返点比例")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "比例" })).not.toBeInTheDocument();
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
    await ui.clear(screen.getByLabelText("返点金额"));
    await ui.type(screen.getByLabelText("返点金额"), "350.00");
    await ui.click(screen.getByRole("button", { name: "确认登记" }));

    await waitFor(() => expect(vi.mocked(rebatesApi.create)).toHaveBeenCalled());
    expect(vi.mocked(rebatesApi.create).mock.calls[0][0]).toMatchObject({
      source_order_id: 21,
      rebate_type: "SELL",
      amount: "350.00",
      channel: "卖号返点",
    });
  });

  it("编辑返点明细后通知上层刷新订单详情与统计（#9）", async () => {
    const onCreated = vi.fn();
    resolveMock(vi.mocked(rebatesApi.update), {
      id: 41, rebate_no: "HS0001-RB01", source_order_id: 21, rebate_type: "BUY",
      amount: "1200.00", status: "OPEN", collected_on: "2026-10-17", operator: "何一",
    });
    renderLight(<InventoryRebateModal account={accounts[0]} onClose={() => undefined} onCreated={onCreated} />, { user: "admin" });
    expect(await screen.findByText("返点明细")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const title = await screen.findByText(/编辑返点 · HS0001-RB01/);
    const editModal = title.closest(".ant-modal-content") as HTMLElement;
    expect(editModal).toBeTruthy();
    // editForm 打开时已用该行返点值预填（金额/日期均合法），直接保存即走 submitEdit 刷新路径。
    // 不依赖 MoneyInput 内部 id：自定义控件可能不转发 id，按 id 定位会拿到 null。
    await userEvent.click(within(editModal).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(rebatesApi.update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("返点不可删除/作废：无删除入口，退回走资金中心录入支出（2026-11-12 裁决）", async () => {
    renderLight(<InventoryRebateModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    expect(await screen.findByText("返点明细")).toBeInTheDocument();

    // 返点明细行只保留「编辑」，不再有「删除」按钮。
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    // 注册接口不再暴露 remove（DELETE /rebates/{id} 已撤销）。
    expect(rebatesApi).not.toHaveProperty("remove");
  });

  it("操作人接口失败时显示错误，不伪造空操作人列表", async () => {
    vi.mocked(employeesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" } as unknown as never);
    renderLight(<InventoryRebateModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ui-error-banner")).toBeTruthy());
  });

  it("提号分销已登记 BUY 后可登记买号返点", async () => {
    resolveMock(vi.mocked(ordersApi.executionDetail), {
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
// 原 InventoryConsignmentModal.test.tsx：只读 executionDetail，「已上架记录」的平台名来源（L234）
describe("InventoryConsignmentModal 已上架记录平台展示（L234）", () => {
  const consignAccount = {
    id: 1,
    source_order_id: 22,
    source_order_no: "DG-2026-0003",
    game_account: "acc-3",
    game_type: "手游",
    status: "IN_STOCK",
  } as unknown as Account;

  function renderConsignment() {
    return renderLight(
      <OrderConsignmentModal account={consignAccount} onClose={vi.fn()} onCreated={vi.fn()} />,
      { user: "admin" },
    );
  }

  it("原订单寄售事件的已上架记录展示平台名", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [
        {
          order_id: 22,
          order_type: "HS",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          events: [{
            id: 901,
            event_type: "OPERATE",
            operation_type: "CONSIGNMENT",
            form_extra: { consignment_platforms: ["盼之"], listed_at: "2026-10-12T09:10:00" },
          }],
        },
      ],
    } as never);

    renderConsignment();

    expect(await screen.findByText("盼之")).toBeInTheDocument();
  });

  it("已上架平台不再出现在新增上架选项", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: { id: 1, status: "WAITING" }, orders: [{
      order_id: 22, status: "ACTIVE", events: [{ id: 901, event_type: "OPERATE", operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["盼之"] } }],
    }] } as never);
    renderConsignment();
    await screen.findByText("盼之");
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "寄售平台" }).closest(".ant-select-selector")!);
    expect(await screen.findByText("千寻", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    expect(screen.queryByText("盼之", { selector: ".ant-select-item-option-content" })).toBeNull();
  });

  it("平台下架后可重新选择上架", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: { id: 1, status: "WAITING" }, orders: [{
      order_id: 22, status: "ACTIVE", events: [
        { id: 901, event_type: "OPERATE", operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["盼之"] } },
        { id: 902, event_type: "OPERATE", operation_type: "UNLIST", form_extra: { consignment_event_id: 901, consignment_platforms: ["盼之"], platform_unlist_scope: "PLATFORM" } },
      ],
    }] } as never);
    renderConsignment();
    await screen.findByText("暂无上架记录");
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "寄售平台" }).closest(".ant-select-selector")!);
    expect(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("寄售平台从原订单寄售事件读取", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [
        {
          order_id: 22,
          order_type: "HS",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          events: [{
            id: 902,
            event_type: "OPERATE",
            operation_type: "CONSIGNMENT",
            form_extra: { consignment_platforms: ["寄售平台A"], listed_at: "2026-10-12T09:10:00" },
          }],
        },
      ],
    } as never);

    renderConsignment();

    expect(await screen.findByText("寄售平台A")).toBeInTheDocument();
  });

  it("已上架记录限制为弹窗内滚动，不继续撑高寄售弹窗", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [{
        order_id: 22,
        order_no: "DG-2026-0003",
        order_type: "DG",
        status: "ACTIVE",
        trade_date: "2026-10-12",
        created_at: "2026-10-12T09:10:00",
        events: Array.from({ length: 12 }, (_, index) => ({
          id: 920 + index,
          event_type: "OPERATE",
          operation_type: "CONSIGNMENT",
          form_extra: { consignment_platforms: [`寄售平台${index + 1}`], listed_at: `2026-10-${String(index + 1).padStart(2, "0")}T09:10:00` },
        })),
      }],
    } as never);

    renderConsignment();

    await screen.findByText("寄售平台12");
    const recordsBody = document.querySelector<HTMLElement>(".inventory-consignment-records-table .ant-table-body");
    expect(recordsBody).toHaveStyle({ maxHeight: "180px", overflowY: "scroll" });
  });

  it("没有足够明细时不预留固定滚动高度", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [{
        order_id: 22,
        order_no: "DG-2026-0003",
        order_type: "DG",
        status: "ACTIVE",
        trade_date: "2026-10-12",
        created_at: "2026-10-12T09:10:00",
        events: [],
      }],
    } as never);

    renderConsignment();

    await screen.findByText("暂无上架记录");
    expect(document.querySelector(".inventory-consignment-records-table .ant-table-body")).toBeNull();
  });

  it("没有上架明细时使用共享紧凑空态", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [{
        order_id: 22,
        order_no: "DG-2026-0003",
        order_type: "DG",
        status: "ACTIVE",
        trade_date: "2026-10-12",
        created_at: "2026-10-12T09:10:00",
        events: [],
      }],
    } as never);

    renderConsignment();

    await screen.findByText("暂无上架记录");
    expect(document.querySelector(".inventory-consignment-records-table .ant-table-body")).toBeNull();
    expect(document.querySelector(".inventory-consignment-records-table .ui-datatable__empty")).toBeTruthy();
  });

  it("账号处于 VOID 时，已上架记录为空且无旧平台残留", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "VOID" },
      orders: [
        {
          order_id: 22,
          order_type: "DG",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          counterparties: [{ id: 11, display_name: "寄售平台A", role: "PLATFORM" }],
        },
      ],
    } as never);

    renderConsignment();

    expect(await screen.findByText("已上架记录")).toBeInTheDocument();
    // VOID 账号按源码逻辑清空列表；不得渲染平台名
    await waitFor(() => expect(screen.queryByText("寄售平台A")).not.toBeInTheDocument());
  });
});

// —— 原 OrderDetailDeliverySection.test.tsx ——
// 订单详情「交付明细」区块：只读 props + 字段定义，无页面级挂载。
describe("OrderDetailDeliverySection", () => {
  beforeEach(() => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
  });
  it("FE-265：订单详情回显交易平台、中介类型和包赔类型", async () => {
    const detail = {
      orders: [{
        order_id: 21,
        order_no: "HS-FE265",
        order_type: "HS",
        created_at: "2026-11-02T10:00:00",
        extra_values: {
          intermediary_platform: "盼之",
          intermediary_type: "包赔",
          compensation_type: "续保",
        },
        events: [],
      }],
    };

    renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE265" } as never} detail={detail as never} />,
      { user: "admin" },
    );

    await waitFor(() => {
      expect(screen.getByText("盼之")).toBeInTheDocument();
      expect(screen.getByText("包赔")).toBeInTheDocument();
      expect(screen.getByText("续保")).toBeInTheDocument();
    });
  });

  it("编辑态交易平台、中介类型和包赔类型可以下拉选择", async () => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValueOnce([
      {
        id: 1, order_type_code: "HS", field_key: "intermediary_platform", label: "交易平台", field_type: "SELECT",
        options: [{ value: "盼之", label: "盼之" }, { value: "其他", label: "其他" }], required: false, is_active: true, sort_order: 1, locked: false, is_custom: false,
      },
      {
        id: 2, order_type_code: "HS", field_key: "intermediary_type", label: "中介类型", field_type: "SELECT",
        options: [{ value: "普中", label: "普中" }, { value: "包赔", label: "包赔" }], required: false, is_active: true, sort_order: 2, locked: false, is_custom: false,
      },
      {
        id: 3, order_type_code: "HS", field_key: "compensation_type", label: "包赔类型", field_type: "SELECT",
        options: [{ value: "首保", label: "首保" }, { value: "续保", label: "续保" }], required: false, is_active: true, sort_order: 3, locked: false, is_custom: false,
      },
    ] as never);
    const onOrderExtraChange = vi.fn();
    const detail = {
      orders: [{
        order_id: 25,
        order_no: "HS-FE268",
        order_type: "HS",
        created_at: "2026-11-02T10:00:00",
        extra_values: { intermediary_platform: "盼之", intermediary_type: "普中", compensation_type: "首保" },
        events: [],
      }],
    };

    renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "HS-FE268" } as never}
        detail={detail as never}
        editing
        onOrderExtraChange={onOrderExtraChange}
      />,
      { user: "admin" },
    );

    const platform = await screen.findByRole("combobox", { name: "编辑交易平台" });
    await ui.click(platform);
    await ui.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(25, "intermediary_platform", "其他");

    const intermediaryType = screen.getByRole("combobox", { name: "编辑中介类型" });
    await ui.click(intermediaryType);
    await ui.click(await screen.findByText("包赔", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(25, "intermediary_type", "包赔");

    const compensationType = screen.getByRole("combobox", { name: "编辑包赔类型" });
    await ui.click(compensationType);
    await ui.click(await screen.findByText("续保", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(25, "compensation_type", "续保");
  });

  it("编辑态交付操作人选择器保持可读宽度", async () => {
    renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "HS-FE269" } as never}
        detail={{
          orders: [{ order_id: 26, order_no: "HS-FE269", order_type: "HS", created_at: "2026-11-02T10:00:00", extra_values: {}, events: [] }],
        } as never}
        editing
        employees={[{ id: 7, username: "lisi", display_name: "李三（三三）", is_active: true }]}
      />,
      { user: "admin" },
    );

    const responsible = await waitFor(() => {
    const select = document.querySelector<HTMLElement>('.ant-select[aria-label="编辑交付操作人"]');
      expect(select).toBeInTheDocument();
      return select as HTMLElement;
    });
    expect(responsible).toHaveClass("order-detail__delivery-responsible");

    const searchInput = responsible.querySelector<HTMLInputElement>(".ant-select-selection-search-input");
    expect(searchInput).toBeInTheDocument();
    await ui.click(searchInput!);
    await ui.type(searchInput!, "李");
    expect(await screen.findByText("李三（三三）", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("FE-266：交付操作人回显员工姓名，未加载时不泄露原始 ID", async () => {
    const detail = {
      orders: [{
        order_id: 22,
        order_no: "HS-FE266",
        order_type: "HS",
        created_at: "2026-11-02T10:00:00",
        extra_values: { delivery_responsible_ids: [7] },
        events: [],
      }],
    };

    const { unmount } = renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "HS-FE266" } as never}
        detail={detail as never}
        employees={[{ id: 7, username: "lisi", display_name: "李三（三三）", is_active: true }]}
      />,
      { user: "admin" },
    );

    await waitFor(() => expect(screen.getByText("李三（三三）")).toBeInTheDocument());
    expect(screen.queryByText("7")).not.toBeInTheDocument();
    unmount();

    renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE266" } as never} detail={detail as never} />,
      { user: "admin" },
    );
    await waitFor(() => expect(screen.getByText("操作人信息加载中")).toBeInTheDocument());
    expect(screen.queryByText("7")).not.toBeInTheDocument();
  });

  it("FE-267：买号和卖号交付都回显手机号绑定人", async () => {
    const detail = {
      orders: [
        {
          order_id: 23,
          order_no: "HS-FE267",
          order_type: "HS",
          created_at: "2026-11-02T10:00:00",
          extra_values: { bound_phone: "13800000001", bound_phone_owner: "买家负责人" },
          events: [],
        },
        {
          order_id: 24,
          order_no: "DG-FE267",
          order_type: "DG",
          created_at: "2026-11-02T11:00:00",
          extra_values: { bound_phone: "13800000002", bound_phone_owner: "卖出负责人" },
          events: [{ event_type: "SELL", id: 1, amount: "1", occurred_on: "2026-11-02" }],
        },
      ],
    };

    renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE267" } as never} detail={detail as never} />,
      { user: "admin" },
    );

    await waitFor(() => {
      expect(screen.getByText("买家负责人")).toBeInTheDocument();
      expect(screen.getByText("卖出负责人")).toBeInTheDocument();
      expect(screen.getByText("13800000001")).toBeInTheDocument();
      expect(screen.getByText("13800000002")).toBeInTheDocument();
    });
  });

  it("FE-268：仅有代挂订单时卖号交付仍展示交付表格", async () => {
    const detail = {
      orders: [{
        order_id: 25,
        order_no: "DG-FE268",
        order_type: "DG",
        created_at: "2026-11-02T10:00:00",
        extra_values: {
          intermediary_platform: "盼之",
          intermediary_type: "普中",
          compensation_type: "首保",
          delivery_responsible_ids: [1],
        },
        events: [],
      }],
    };

    renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "DG-FE268" } as never}
        detail={detail as never}
        employees={[{ id: 1, username: "admin", display_name: "管理员", is_active: true }]}
      />,
      { user: "admin" },
    );

    await waitFor(() => expect(screen.getAllByText("盼之").length).toBeGreaterThan(0));
  });
});

// —— 原 InventoryPanel.sale.test.tsx ——
// 售出、写入和详情编辑共享同一页面依赖与初始化，合并后避免重复启动重型库存页面。
describe("库存售出流程", () => {
beforeEach(() => {
  seedOrderFormFields();
});

it.each([RecoverySaleModal, PickupSaleModal, ConsignmentSaleModal])("已选售出操作人时无需等待人员重查，提交期间防止重复操作", async (SaleModal) => {
  vi.mocked(employeesApi.list).mockResolvedValueOnce([{ id: 2, username: "bob", display_name: "小红", is_active: true }]);
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<SaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  const amountLabel = SaleModal === ConsignmentSaleModal ? "利润" : "售出金额";
  await saleUi.type(await screen.findByLabelText(amountLabel), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(1));
  await saleUi.click(screen.getByLabelText("售出操作人"));
  await saleUi.click(await screen.findByText("小红", { selector: ".ant-select-item-option-content" }));
  await saleUi.click(screen.getByLabelText("交付操作人"));
  const employeeOptions = screen.getAllByText("小红", { selector: ".ant-select-item-option-content" });
  await saleUi.click(employeeOptions[employeeOptions.length - 1]);
  vi.mocked(employeesApi.list).mockReturnValue(new Promise(() => {}));
  vi.mocked(ordersApi.postEvent).mockReturnValue(new Promise(() => {}));
  const form = screen.getByLabelText(amountLabel).closest("form")!;
  fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));
  await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledTimes(1));
  fireEvent.submit(form);
  expect(employeesApi.list).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: /确认售出/ })).toHaveClass("ant-btn-loading");
  expect(ordersApi.postEvent).toHaveBeenCalledTimes(1);
});

it("不填写客户时，客户名单加载中仍可售出", async () => {
  vi.mocked(customersApi.page).mockReturnValueOnce(new Promise(() => {}));
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  await saleUi.type(await screen.findByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
  await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledWith(21, expect.objectContaining({ event_type: "SELL", amount: "350" })));
  expect(customersApi.create).not.toHaveBeenCalled();
  expect(ordersApi.addCustomerRole).not.toHaveBeenCalled();
});

it("填写客户时，名单加载失败可重试后再售出", async () => {
  vi.mocked(customersApi.page).mockRejectedValueOnce(new Error("客户读取失败"));
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  expect(await screen.findByText(/客户读取失败/)).toBeInTheDocument();
  await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
  await saleUi.type(screen.getByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
  expect(customersApi.create).not.toHaveBeenCalled();
  expect(ordersApi.postEvent).not.toHaveBeenCalled();
  await saleUi.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(screen.queryByText(/客户读取失败/)).not.toBeInTheDocument());
  await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
  await waitFor(() => expect(ordersApi.addCustomerRole).toHaveBeenCalledWith(21, { customer_id: 7, role: "BUYER" }));
});

it("售出时匹配第500条以后的已有客户", async () => {
  const first = Array.from({ length: 500 }, (_, index) => ({ id: index + 1, display_name: `客户${index + 1}`, status: "ACTIVE" }));
  const last = { id: 501, display_name: "末尾买家", status: "ACTIVE" };
  vi.mocked(customersApi.list).mockResolvedValue(first as never);
  vi.mocked(customersApi.page).mockImplementation(async (params) => ({ items: params?.offset ? [last] : first, total: 501, limit: 500, offset: params?.offset ?? 0 }) as never);
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  await screen.findByText("买家信息");
  await saleUi.type(screen.getByLabelText("客户昵称"), "末尾买家");
  await saleUi.type(screen.getByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
  await waitFor(() => expect(ordersApi.addCustomerRole).toHaveBeenCalledWith(21, { customer_id: 501, role: "BUYER" }));
  expect(customersApi.create).not.toHaveBeenCalled();
});

it("售出时把新买家关联到来源单而非新建订单", async () => {
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  resolveMock(vi.mocked(customersApi.page), { items: [], total: 0, limit: 500, offset: 0 });
  resolveMock(vi.mocked(customersApi.create), {
    customer: { id: 8, customer_no: "C0008", display_name: "新买家", status: "ACTIVE" },
    duplicate_candidates: [],
  });
  renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });

  expect(await screen.findByText("买家信息")).toBeInTheDocument();
  expect(screen.getByText("资金明细")).toBeInTheDocument();
  await saleUi.type(screen.getByLabelText("客户昵称"), "新买家");
  await saleUi.type(screen.getByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

  await waitFor(() => expect(vi.mocked(customersApi.create)).toHaveBeenCalledWith(expect.objectContaining({ display_name: "新买家" })));
  expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
  expect(vi.mocked(ordersApi.addCustomerRole)).toHaveBeenCalledWith(21, { customer_id: 8, role: "BUYER" });
  expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalledWith(21, expect.objectContaining({
    event_type: "SELL", amount: "350", pool_id: 3, portion: "PROFIT", operator_user_ids: [1],
  }));
});

it("库存售出：成功后立即从库存列表移除账号，即使列表重拉暂时返回旧快照", async () => {
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<InventoryPanel />, { user: "admin" });

  expect(await screen.findByText("acc-1")).toBeInTheDocument();
  await saleUi.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "售出" }));
  await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
  await saleUi.type(screen.getByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));

  await waitFor(() => expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText("acc-1")).not.toBeInTheDocument());
});

describe("库存售出三表单分支", () => {
  it("代挂账号售出：全款收佣金入账、售出金额仅记录、不提供分期并挂寄售方", async () => {
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([{
      account: { ...accounts[0], id: 5, source_order_id: 21, game_account: "acc-5", inventory_type: "CONSIGNMENT" },
      order: { id: 21, order_no: "DG-2026-0001", order_type: "DG", trade_date: "2026-10-01", account_id: 5, account_status: "WAITING", status: "ACTIVE" },
    }], { type_counts: { CONSIGNMENT: 1 }, stats: { account_count: 1, occupied_cost: "50.00", over_7d_count: 0, over_30d_count: 0 } }) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-5");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出代挂账号")).toBeInTheDocument();
    expect(screen.getByLabelText("利润")).toBeInTheDocument();
    expect(screen.getByLabelText("售出金额（仅记录）")).toBeInTheDocument();
    expect(screen.queryByText("付款方式")).toBeNull();
    expect(screen.queryByText("分期付款")).toBeNull();
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByPlaceholderText("请输入利润（代挂佣金）"), "200");
    await saleUi.type(screen.getByPlaceholderText("代挂无买入价，此处仅作记录，不计入利润"), "1000");
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
    await waitFor(() => expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalled());
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
    expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalledWith(21, expect.objectContaining({
      event_type: "SELL", amount: "200", pool_id: 3, portion: "PROFIT", form_extra: { sale_amount: "1000" },
    }));
    expect(vi.mocked(ordersApi.addCustomerRole)).toHaveBeenCalledWith(21, { customer_id: 7, role: "CONSIGNOR" });
    expect(vi.mocked(installmentsApi.create)).not.toHaveBeenCalled();
  });

  it("代挂售出复用买号交付信息块，交付操作人提交落库到来源单", async () => {
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([{
      account: { ...accounts[0], id: 5, source_order_id: 21, game_account: "acc-5", inventory_type: "CONSIGNMENT" },
      order: { id: 21, order_no: "DG-2026-0001", order_type: "DG", trade_date: "2026-10-01", account_id: 5, account_status: "WAITING", status: "ACTIVE" },
    }], { type_counts: { CONSIGNMENT: 1 }, stats: { account_count: 1, occupied_cost: "50.00", over_7d_count: 0, over_30d_count: 0 } }) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-5");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出代挂账号")).toBeInTheDocument();
    expect(screen.getByText("交付操作人")).toBeInTheDocument();
    expect(screen.getByText("交易平台")).toBeInTheDocument();
    expect(screen.getByText("中介类型")).toBeInTheDocument();
    expect(screen.getByText("包赔类型")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("交付操作人").closest(".ant-select")).toHaveTextContent("管理员"));
    await saleUi.click(screen.getByLabelText("交易平台"));
    await saleUi.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByPlaceholderText("请输入利润（代挂佣金）"), "200");
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
    await waitFor(() => expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(ordersApi.patch)).toHaveBeenCalledWith(21, expect.objectContaining({
      form_extra: expect.objectContaining({ delivery_responsible_ids: [1], intermediary_platform: "盼之" }),
    })));
  });

  it("提号库存售出可选择分期出售，确立时收首付", async () => {
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([{
      account: { ...accounts[0], id: 6, source_order_id: 21, game_account: "pickup-acc", inventory_type: "PICKUP", cost_amount: "0.00" },
      order: { id: 21, order_no: "TH-2026-0001", order_type: "TH", trade_date: "2026-10-01", account_id: 6, account_status: "WAITING", status: "ACTIVE" },
    }], { type_counts: { PICKUP: 1 }, stats: { account_count: 1, occupied_cost: "0.00", over_7d_count: 0, over_30d_count: 0 } }) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("pickup-acc");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出提号账号")).toBeInTheDocument();
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByPlaceholderText("请输入金额"), "1200");
    await saleUi.click(await screen.findByText("分期付款"));
    await saleUi.clear(screen.getByLabelText("首付金额"));
    await saleUi.type(screen.getByLabelText("首付金额"), "300");
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.clear(screen.getByLabelText("分期期数"));
    await saleUi.type(screen.getByLabelText("分期期数"), "2");
    await saleUi.clear(screen.getByLabelText("每期金额"));
    await saleUi.type(screen.getByLabelText("每期金额"), "600");
    expect(screen.getByLabelText("第 1 期到期日")).toBeInTheDocument();
    expect(screen.getByLabelText("第 2 期到期日")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(vi.mocked(installmentsApi.create)).toHaveBeenCalledWith(expect.objectContaining({
      order_id: 21, contract_type: "STOCK_SALE", principal: "1200", down_payment: "300",
    })));
    await waitFor(() => expect(vi.mocked(installmentsApi.pay)).toHaveBeenCalledWith(
      41, expect.objectContaining({ amount: "300", period_no: 0, pool_id: 3 }),
    ));
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
    expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalledWith(21, expect.objectContaining({
      event_type: "SELL", sale_mode: "INSTALLMENT", amount: "1200", operator_user_ids: [1],
    }));
  });

  it("库存中心不为售出单提供取消入口", async () => {
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([]) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await waitFor(() => expect(screen.queryByText("acc-2")).toBeNull());
    expect(screen.getByText("暂无账号")).toBeInTheDocument();
    expect(vi.mocked(ordersApi.postEvent)).not.toHaveBeenCalled();
  });

  it("售出表单统一使用资金明细且不增加支出", async () => {
    renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    expect(await screen.findByText("资金明细")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /增加支出/ })).not.toBeInTheDocument();
    expect(screen.queryByText("售出金额2")).not.toBeInTheDocument();
    expect(screen.queryByText("资金账户2")).not.toBeInTheDocument();
  });

  it("回收、提号、代挂三种售出表单都展示统一的交付信息", async () => {
    const deliveryLabels = ["换绑手机号", "手机号绑定人", "交易平台", "中介类型", "包赔类型", "交付操作人", "售出操作人"];
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
    vi.mocked(customersApi.page).mockResolvedValueOnce({ items: [{ id: 7, display_name: "买家A", status: "DISABLED" }], total: 1, limit: 500, offset: 0 } as never);
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }] as never);
    vi.mocked(employeesApi.list).mockResolvedValueOnce([{ id: 1, username: "admin", display_name: "管理员", is_active: true }] as never);
    renderLight(
      <RecoverySaleModal
        account={{ id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", game_account: "acc-1", status: "WAITING", inventory_type: "RECOVERY" } as never}
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
      { user: "admin" },
    );
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    await screen.findByText("买家信息");
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByLabelText("售出金额"), "350");
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(screen.getByText(/客户已拉黑，不能作为售出买家/)).toBeInTheDocument());
    expect(ordersApi.addCustomerRole).not.toHaveBeenCalled();
    expect(ordersApi.postEvent).not.toHaveBeenCalled();
  });
});

});
