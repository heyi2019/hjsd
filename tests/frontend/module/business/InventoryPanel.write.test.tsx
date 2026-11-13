import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { InventoryPanel } from "@/stocks/InventoryPanel";
import { InventoryRebateModal } from "@/stocks/InventoryRebateModal";
import { InventoryConsignmentModal } from "@/stocks/InventoryConsignmentModal";
import { OrderDetailDeliverySection } from "@/stocks/OrderDetailDeliverySection";

import type { Account } from "@/shared/api/types/accounts";
import { counterpartiesApi, customersApi } from "@/shared/api/customers.api";
import { installmentsApi } from "@/shared/api/installments.api";
import { orderFormFieldsApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { rebatesApi } from "@/shared/api/rebates.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { resolveMock } from "@fixtures/mock-api";
import { seedOptionSets } from "@fixtures/formFieldsSeed";
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
vi.mock("@/shared/api/quality.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

const accounts = [
  { id: 1, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "A平台", status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, source_order_no: "TH-2026-0002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

beforeEach(() => {
  clearOptionSetsCache();
  vi.clearAllMocks();
  seedOptionSets();
  vi.mocked(stocksApi.list).mockResolvedValue(accounts);
  vi.mocked(stocksApi.inventoryStats).mockResolvedValue({ account_count: 1, occupied_cost: "100.00", over_7d_count: 0, over_30d_count: 0 });
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
    rate: "5.00",
    base_amount: "1000.00",
    status: "OPEN",
    collected_on: "2026-10-17",
    operator: "何一",
  }] as never);
  resolveMock(vi.mocked(installmentsApi.create), { id: 41 });
  resolveMock(vi.mocked(stocksApi.executionDetail), {
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
  resolveMock(vi.mocked(stocksApi.updateProfile), accounts[0]);
  vi.mocked(employeesApi.list).mockResolvedValue([{ id: 1, username: "alice", display_name: "小明", is_active: true }, { id: 2, username: "bob", display_name: "小红", is_active: true }]);
});

describe("InventoryPanel：写入与长路径", () => {
  it("库存编辑通过弹窗保存账号资料", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    fireEvent.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "编辑" }));
    // 内联编辑：点「编辑」就地展开该行进入编辑态（无弹窗），核心字段可直接改。
    const input = await screen.findByLabelText("编辑游戏账号/产品");
    fireEvent.change(input, { target: { value: "updated-account" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(vi.mocked(stocksApi.updateProfile)).toHaveBeenCalledWith(1, expect.objectContaining({
      game_account: "updated-account",
    })));
  });

  it("寄售登记到来源订单，不创建 DG 代挂订单", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.executionDetail).mockResolvedValueOnce({
      account: accounts[0],
      orders: [{
        order_id: 21,
        order_no: "HS0001",
        order_type: "HS",
        trade_date: "2026-10-15",
        status: "ACTIVE",
        events: [],
      }],
    } as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "运营" }));
    await ui.click(screen.getByRole("menuitem", { name: "寄售（上架）" }));
    expect(await screen.findByText("登记寄售")).toBeInTheDocument();

    await ui.click(screen.getAllByRole("combobox", { name: "寄售平台" })[0]);
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: "确认上架" }));

    await waitFor(() => expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalledWith(21, expect.objectContaining({
      event_type: "OPERATE",
      operation_type: "CONSIGNMENT",
      form_extra_scope: "CONSIGN",
    })));
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
  });

  it("返点按买入与售出订单区分类型并登记", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
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

    await waitFor(() => expect(vi.mocked(rebatesApi.create)).toHaveBeenCalled());
    expect(vi.mocked(rebatesApi.create).mock.calls[0][0]).toMatchObject({
      source_order_id: 23,
      rebate_type: "SELL",
      base_amount: "350.00",
      channel: "卖号返点",
    });
  });

  it("编辑返点明细后通知上层刷新订单详情与统计（#9）", async () => {
    const onCreated = vi.fn();
    resolveMock(vi.mocked(rebatesApi.update), {
      id: 41, rebate_no: "HS0001-RB01", source_order_id: 21, rebate_type: "BUY",
      rate: "5.00", base_amount: "1200.00", status: "OPEN", collected_on: "2026-10-17", operator: "何一",
    });
    renderLight(<InventoryRebateModal account={accounts[0]} onClose={() => undefined} onCreated={onCreated} />, { user: "admin" });
    expect(await screen.findByText("返点明细")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const title = await screen.findByText(/编辑返点 · HS0001-RB01/);
    const editModal = title.closest(".ant-modal-content") as HTMLElement;
    expect(editModal).toBeTruthy();
    // editForm 打开时已用该行返点值预填（金额/比例/日期均合法），直接保存即走 submitEdit 刷新路径。
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
    resolveMock(vi.mocked(stocksApi.executionDetail), {
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
    source_order_no: "DG-2026-0003",
    game_account: "acc-3",
    game_type: "手游",
    status: "IN_STOCK",
  } as unknown as Account;

  function renderConsignment() {
    return renderLight(
      <InventoryConsignmentModal account={consignAccount} onClose={vi.fn()} onCreated={vi.fn()} />,
      { user: "admin" },
    );
  }

  it("原订单寄售事件的已上架记录展示平台名", async () => {
    vi.mocked(stocksApi.executionDetail).mockResolvedValue({
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
            form_extra: { consignment_platform: "盼之", listed_at: "2026-10-12T09:10:00" },
          }],
        },
      ],
    } as never);

    renderConsignment();

    expect(await screen.findByText("盼之")).toBeInTheDocument();
  });

  it("寄售平台从原订单寄售事件读取", async () => {
    vi.mocked(stocksApi.executionDetail).mockResolvedValue({
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
            form_extra: { consignment_platform: "寄售平台A", listed_at: "2026-10-12T09:10:00" },
          }],
        },
      ],
    } as never);

    renderConsignment();

    expect(await screen.findByText("寄售平台A")).toBeInTheDocument();
  });

  it("账号处于 VOID 时，已上架记录为空且无旧平台残留", async () => {
    vi.mocked(stocksApi.executionDetail).mockResolvedValue({
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

  it("FE-266：交付负责人回显员工姓名，未加载时不泄露原始 ID", async () => {
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
    await waitFor(() => expect(screen.getByText("负责人信息加载中")).toBeInTheDocument());
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

describe("InventoryPanel：账号台账编辑态时间联动", () => {
  it("三个时间都可改，改任一项联动预览，保存带整单平移天数", async () => {
    const detail = {
      account: accounts[0],
      orders: [{
        order_id: 21,
        order_no: "HS0001",
        order_type: "HS",
        trade_date: "2026-10-15",
        created_at: "2026-10-15T10:19:00",
        status: "ACTIVE",
        events: [{
          id: 31, event_no: "EV0001", event_type: "BUY", amount: "100.00",
          occurred_on: "2026-10-15", occurred_at: "2026-10-15T10:20:00",
          portion: "PRINCIPAL", is_posted: true, operator: "admin",
          cashflow: { flow_no: "CF0001", pool_name: "利润池", occurred_on: "2026-10-15", occurred_at: "2026-10-15T10:20:00", direction: "OUT", nature: "BUSINESS_OUT", category: "BUY", amount: "100.00" },
        }, {
          id: 32, event_no: "EV0002", event_type: "SELL", amount: "200.00",
          occurred_on: "2026-10-17", occurred_at: "2026-10-17",
          portion: "GROSS", is_posted: true, operator: "admin",
        }],
        cashflows: [], customers: [], counterparties: [], rebates: [], extra_values: {},
      }],
      finance_summary: { cashflow_income: "0", rebate_income: "0", total_income: "0", total_expense: "100.00", net_amount: "-100.00" },
    };
    vi.mocked(stocksApi.executionDetail).mockResolvedValue(detail as never);
    resolveMock(vi.mocked(stocksApi.updateExecution), { ok: true });

    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    fireEvent.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "编辑" }));

    const created = await screen.findByLabelText("编辑订单创建时间");
    const sold = screen.getByLabelText("编辑售出时间");
    const flow = screen.getByLabelText("编辑流水时间");
    // 时间字段现已按分钟级展示（format YYYY-MM-DD HH:mm），基准含真实分钟。
    expect((created as HTMLInputElement).value).toBe("2026-10-15 10:19");
    expect((sold as HTMLInputElement).value).toBe("2026-10-17 00:00");
    expect((flow as HTMLInputElement).value).toBe("2026-10-15 10:20");

    // antd DatePicker 把输入文本同步进内部 state 是异步的：change 后立刻同步 keyDown
    // 会读到旧 inputValue，导致 onChange 偶发不触发（曾随机红 4/6）。改用真实异步交互。
    const user = userEvent.setup();
    await user.clear(sold);
    await user.type(sold, "2026-10-20 00:00");
    await user.keyboard("{Enter}");
    await waitFor(
      () => expect(screen.getByText(/整单时间轴平移 4320 分钟/)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect((screen.getByLabelText("编辑订单创建时间") as HTMLInputElement).value).toBe("2026-10-18 10:19");
    expect((screen.getByLabelText("编辑流水时间") as HTMLInputElement).value).toBe("2026-10-18 10:20");

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(vi.mocked(stocksApi.updateExecution)).toHaveBeenCalledWith(1, expect.objectContaining({
      time_shift: { delta_minutes: 4320 },
    })));
  });
});
