import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { InventoryPanel } from "@/stocks/InventoryPanel";
import { InventoryRebateModal } from "@/stocks/InventoryRebateModal";
import { InventoryConsignmentModal } from "@/stocks/InventoryConsignmentModal";
import { OrderDetailDeliverySection } from "@/stocks/OrderDetailDeliverySection";

import type { Account } from "@/shared/api/catalog";
import * as catalog from "@/shared/api/catalog";
import { resolveMock } from "@fixtures/mock-api";
import { seedOptionSets } from "@fixtures/formFieldsSeed";
import { clearOptionSetsCache } from "@/shared/lib/optionSets";
vi.mock("@/shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/catalog")>();
  const METHODS = [
    "list", "get", "create", "update", "patch", "post", "postEvent", "remove",
    "setStatus", "setActive", "resolve", "release", "settle", "approve", "reject",
    "reverse", "close", "convert", "detail", "allocations", "setAllocations",
    "balance", "executionDetail", "inventoryStats", "updateProfile", "updateExecution", "merge", "search",
  ];
  const mk = (api: Record<string, unknown>) => {
    const o: Record<string, unknown> = { ...api };
    for (const m of METHODS) {
      if (m in o) o[m] = vi.fn();
    }
    return o;
  };
  const out: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(actual)) {
    const v = (actual as Record<string, unknown>)[key];
    if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).some((x) => typeof x === "function")) {
      out[key] = mk(v as Record<string, unknown>);
    }
  }
  return out as unknown as typeof actual;
});

const accounts = [
  { id: 1, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "A平台", status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, source_order_no: "TH-2026-0002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

beforeEach(() => {
  clearOptionSetsCache();
  vi.clearAllMocks();
  seedOptionSets(catalog);
  vi.mocked(catalog.stocksApi.list).mockResolvedValue(accounts);
  vi.mocked(catalog.stocksApi.inventoryStats).mockResolvedValue({ account_count: 1, occupied_cost: "100.00", over_7d_count: 0, over_30d_count: 0 });
  resolveMock(vi.mocked(catalog.ordersApi.create), { id: 21 });
  resolveMock(vi.mocked(catalog.ordersApi.postEvent), {});
  resolveMock(vi.mocked(catalog.customersApi.list), [{ id: 7, display_name: "买家A", status: "ACTIVE" }]);
  resolveMock(vi.mocked(catalog.poolsApi.list), [{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }]);
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
  }] as never);
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
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([{ id: 1, username: "alice", display_name: "小明", is_active: true }, { id: 2, username: "bob", display_name: "小红", is_active: true }]);
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
    await waitFor(() => expect(vi.mocked(catalog.stocksApi.updateProfile)).toHaveBeenCalledWith(1, expect.objectContaining({
      game_account: "updated-account",
    })));
  });

  it("FE-263：寄售上架复用现有库存账号，不重复创建库存实体", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValueOnce({
      account: accounts[0],
      orders: [],
    } as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "寄售" }));
    expect(await screen.findByText("登记寄售")).toBeInTheDocument();

    await ui.click(screen.getAllByRole("combobox", { name: "寄售平台" })[0]);
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: "确认上架" }));

    await waitFor(() => expect(vi.mocked(catalog.ordersApi.create)).toHaveBeenCalledWith(expect.objectContaining({
      order_type: "DG",
      account_id: 1,
      form_extra_scope: "CONSIGN",
    })));
  });

  it("寄售展示中介平台配置和精确到分钟的上架时间", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "寄售" }));
    expect(await screen.findByText("登记寄售")).toBeInTheDocument();
    expect(screen.getByLabelText("上架时间").getAttribute("value")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(screen.getByText(/每次确认只登记一个平台/)).toBeInTheDocument();
    expect(await screen.findByText("已上架记录")).toBeInTheDocument();
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
    expect(screen.getByText("何一")).toBeInTheDocument();
    expect(document.querySelector(".adaptive-business-modal.business-registration-modal")).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".inventory-rebate-details")?.closest<HTMLElement>(".ant-modal")?.style.getPropertyValue("--resizable-modal-width")).toBe("900px");
    expect(document.querySelectorAll(".rebate-core-fields > .ant-form-item")).toHaveLength(4);
    expect(screen.getByLabelText("操作人")).toBeInTheDocument();
    expect(document.querySelector(".inventory-rebate-details .ant-table-pagination")).toBeNull();
    expect(document.querySelector(".inventory-rebate-details .orders-event-table")).toBeTruthy();
    expect(screen.getByRole("table", { name: "返点明细表" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "返点单号" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "类型" })).toBeInTheDocument();
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

  it("DG 订单已保存 consignment_platform 时，已上架记录展示平台名而非空", async () => {
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [
        {
          order_id: 22,
          order_type: "DG",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          extra_values: { consignment_platform: "盼之", listed_at: "2026-10-12T09:10:00" },
        },
      ],
    } as never);

    renderConsignment();

    expect(screen.getByText("已上架记录")).toBeInTheDocument();
    expect(await screen.findByText("盼之")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(table.closest(".ui-table-wrap")).toHaveClass("inventory-consignment-records-table");
    expect(table).toHaveTextContent("寄售价格");
    expect(table).toHaveTextContent("上架时间");
  });

  it("DG 订单无 consignment_platform 时，从 counterparties(PLATFORM) 兜底展示平台名，不再为空", async () => {
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
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

    expect(await screen.findByText("寄售平台A")).toBeInTheDocument();
  });

  it("账号处于 VOID 时，已上架记录为空且无旧平台残留", async () => {
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({
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
    vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([]);
  });
  it("交付明细每行展示 6 个字段", async () => {
    const detail = {
      orders: [{
        order_id: 21,
        order_no: "HS0001",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        form_extra: {
          bound_phone: "13800000000",
          bound_phone_owner: "买家",
          intermediary_platform: "盼之",
          intermediary_type: "普中",
          compensation_type: "首保",
          delivery_responsible_ids: [1],
        },
        extra_values: {
          bound_phone: "13800000000",
          bound_phone_owner: "买家",
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
        meta={{ sourceOrderNo: "HS0001" } as never}
        detail={detail as never}
        employees={[{ id: 1, username: "admin", display_name: "管理员", is_active: true }]}
      />,
      { user: "admin" },
    );

    await waitFor(() => {
      const table = document.querySelector(".inventory-detail__meta-table");
      expect(table).not.toBeNull();
      expect(table?.querySelectorAll("tbody > tr")).toHaveLength(1);
    });
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
          occurred_on: "2026-10-17", occurred_at: "2026-10-17T11:00:00",
          portion: "GROSS", is_posted: true, operator: "admin",
        }],
        cashflows: [], customers: [], counterparties: [], rebates: [], extra_values: {},
      }],
      finance_summary: { cashflow_income: "0", rebate_income: "0", total_income: "0", total_expense: "100.00", net_amount: "-100.00" },
    };
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue(detail as never);
    resolveMock(vi.mocked(catalog.stocksApi.updateExecution), { ok: true });

    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    fireEvent.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "编辑" }));

    const created = await screen.findByLabelText("编辑订单创建时间");
    const sold = screen.getByLabelText("编辑售出时间");
    const flow = screen.getByLabelText("编辑流水时间");
    expect((created as HTMLInputElement).value).toBe("2026-10-15");
    expect((sold as HTMLInputElement).value).toBe("2026-10-17");
    expect((flow as HTMLInputElement).value).toBe("2026-10-15");

    // antd DatePicker 把输入文本同步进内部 state 是异步的：change 后立刻同步 keyDown
    // 会读到旧 inputValue，导致 onChange 偶发不触发（曾随机红 4/6）。改用真实异步交互。
    const user = userEvent.setup();
    await user.clear(sold);
    await user.type(sold, "2026-10-20");
    await user.keyboard("{Enter}");
    await waitFor(
      () => expect(screen.getByText(/整单时间轴平移 3 天/)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect((screen.getByLabelText("编辑订单创建时间") as HTMLInputElement).value).toBe("2026-10-18");
    expect((screen.getByLabelText("编辑流水时间") as HTMLInputElement).value).toBe("2026-10-18");

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(vi.mocked(catalog.stocksApi.updateExecution)).toHaveBeenCalledWith(1, expect.objectContaining({
      time_shift: { delta_days: 3 },
    })));
  });
});
