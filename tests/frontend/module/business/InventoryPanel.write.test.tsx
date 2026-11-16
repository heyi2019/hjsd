import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { InventoryPanel } from "@/stocks/InventoryPanel";
import { InventoryRebateModal } from "@/stocks/rebate";
import { OrderConsignmentModal } from "@/orders/operations/consignment";
import { OrderDetailDeliverySection } from "@/orders/OrderDetailView/OrderDetailDeliverySection";

import type { Account } from "@/shared/api/types/accounts";
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
        capital_type: "SELF",
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
  resolveMock(vi.mocked(customersApi.list), [{ id: 7, display_name: "买家A", status: "ACTIVE" }]);
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
        cashflow: { flow_no: "CF0001", pool_name: "利润池", occurred_on: "2026-10-15", direction: "OUT", nature: "BUSINESS_OUT", category: "BUY", amount: "100.00" },
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
        capital_type: "ZERO",
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
