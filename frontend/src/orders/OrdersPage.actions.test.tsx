import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { message } from "antd";
import { renderLight } from "../test/render";
import { OrdersPage } from "./OrdersPage";

import * as catalog from "../shared/api/catalog";
import * as client from "../shared/api/client";
import type { Installment, InstallmentCancelResult, Order, OrderLink, ProfitAllocation } from "../shared/api/catalog";

let ui: ReturnType<typeof userEvent.setup>;

vi.mock("../shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api/catalog")>();
  const METHODS = [
    "list", "get", "create", "update", "patch", "post", "postEvent", "cancel", "remove",
    "setStatus", "setActive", "resolve", "release", "settle", "approve", "reject",
    "reverse", "close", "convert", "detail", "allocations", "setAllocations",
    "balance", "executionDetail", "updateProfile", "updateExecution", "merge", "search",
    "orderSnapshot", "links", "createLink", "deleteLink",
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

// openAllocations 会调用 api.get("/users") 拉取收益人；normalizeError 必须保留真实实现。
vi.mock("../shared/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api/client")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  };
});

vi.mock("../../accounts/InventoryPanel", () => ({ InventoryPanel: () => null }));
vi.mock("../../installments/InstallmentsPanel", () => ({ InstallmentsPanel: () => null }));

// CreateBusinessModal 用桩替换：暴露 open/onClose/onCreated 三个口，用于覆盖回调分支。
vi.mock("./CreateBusinessModal", () => ({
  CreateBusinessModal: (props: {
    open: boolean;
    onClose: () => void;
    onCreated: () => Promise<void>;
    initialOrderType?: string;
  }) =>
    props.open ? (
      <div data-testid="create-stub">
        <button type="button" onClick={props.onClose}>关闭新建弹窗</button>
        <button type="button" onClick={() => void props.onCreated()}>模拟新建成功</button>
      </div>
    ) : null,
}));

const order1: Order = {
  id: 1,
  order_no: "HS-2026-0001",
  order_type: "HS",
  capital_type: "SELF",
  trade_date: "2026-10-01",
  status: "ACTIVE",
  business_mode: "SELF",
  account_game_type: "原神",
  account_game_account: "seller-001",
  account_platform: "安卓",
  account_status: "IN_STOCK",
  party_name: "卖家甲",
  party_source: "同行推荐",
  event_total: "1234.00",
  last_event_type: "BUY",
  account_id: 5,
};
const order2: Order = {
  id: 2,
  order_no: "DG-2026-0002",
  order_type: "DG",
  capital_type: "ZERO",
  trade_date: "2026-10-02",
  status: "COMPLETED",
  business_mode: "DISTRIBUTION",
};
const order3: Order = {
  id: 3,
  order_no: "DFQ-2026-0003",
  order_type: "DFQ",
  capital_type: "CREDIT",
  trade_date: "2026-10-03",
  status: "ACTIVE",
  installment_principal: "12000.00",
  installment_paid: "3000.00",
  installment_periods: 6,
};
const orders = [order1, order2];
const link1: OrderLink = {
  id: 77,
  source_order_id: 2,
  source_order_no: "DG-2026-0002",
  target_order_id: 1,
  target_order_no: "HS-2026-0001",
  relation_type: "SOURCE",
  direction: "SOURCE",
  split_ratio: "50",
  split_amount: null,
  note: "来源单",
  created_at: "2026-10-01T10:00:00",
};
const types = [{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }];

const installment: Installment = {
  id: 11,
  inst_no: "INS-1",
  order_id: 3,
  contract_type: "INSTALLMENT",
  principal: "12000.00",
  down_payment: "0.00",
  service_fee: "0.00",
  periods: 6,
  per_period_service_fee: "0.00",
  per_period: "2000.00",
  paid_amount: "3000.00",
  status: "ACTIVE",
};
const installmentCancelResult: InstallmentCancelResult = {
  installment,
  order_status: "CANCELLED",
  refund_amount: "3000.00",
  reversed_amount: "3000.00",
  cancel_event_ids: [1],
};

const allocationRows: ProfitAllocation[] = [
  { id: 1, order_id: 1, user_id: 9, role: "OWNER", allocation_type: "OPERATION", allocation_rate: "40" },
];

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(catalog.ordersApi.list).mockResolvedValue(orders);
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(types);
  vi.mocked(catalog.ordersApi.get).mockResolvedValue(order1);
  vi.mocked(catalog.ordersApi.links).mockResolvedValue([link1]);
  vi.mocked(catalog.ordersApi.deleteLink).mockResolvedValue(undefined);
  vi.mocked(catalog.ordersApi.cancel).mockResolvedValue({ ...order1, status: "CANCELLED" });
  vi.mocked(catalog.ordersApi.postEvent).mockResolvedValue({
    event: { id: 2, event_no: "EV-2", order_id: 1, event_type: "CANCEL", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true },
    installment: { id: 11, inst_no: "INS-1", status: "CANCELLED" },
    cash_flows: [],
    warnings: [],
  } as never);
  vi.mocked(catalog.policyApi.allocations).mockResolvedValue({ items: allocationRows, total: allocationRows.length });
  vi.mocked(catalog.policyApi.setAllocations).mockResolvedValue({ items: allocationRows, total: allocationRows.length });
  vi.mocked(catalog.installmentsApi.list).mockResolvedValue([installment]);
  vi.mocked(catalog.installmentsApi.cancel).mockResolvedValue(installmentCancelResult);
  vi.mocked(client.api).get.mockResolvedValue({
    data: [{ id: 9, username: "lisi", display_name: "李四", is_active: true }],
  });
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
});

async function openLedger(user = "admin") {
  renderLight(<OrdersPage />, { user });
  await screen.findByRole("tab", { name: "业务台账" });
  await waitFor(() => expect(document.querySelector("tbody tr")).toBeTruthy());
}

function tableRow(orderNo: string): HTMLElement {
  const rows = Array.from(document.querySelectorAll("tbody tr")) as HTMLElement[];
  return rows.find((row) => row.textContent?.includes(orderNo))!;
}

async function openRowMenu(orderNo: string, item: string) {
  fireEvent.click(within(tableRow(orderNo)).getByRole("button", { name: /更多/ }));
  fireEvent.click(await screen.findByText(item));
}

async function modalOf(titlePattern: RegExp): Promise<HTMLElement> {
  return (await screen.findByText(titlePattern)).closest(".ant-modal-content") as HTMLElement;
}

/** 默认 Modal 的 OK 文案受 ConfigProvider locale 影响（并非稳定为「确定」），
 *  故按 antd 结构直接取 footer 主按钮；cancel 弹窗因显式 okText 仍用名称定位。 */
async function clickModalOk(modal: HTMLElement) {
  const ok = modal.querySelector(".ant-modal-footer .ant-btn-primary") as HTMLElement | null;
  expect(ok).not.toBeNull();
  fireEvent.click(ok!);
}

describe("OrdersPage：操作与筛选分支", () => {
  it("分期订单金额展示为 已付/本金 · 期数", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([order3]);
    await openLedger();
    expect(screen.getAllByText("¥3000.00/12000.00 · 6期").length).toBeGreaterThan(0);
  });

  it("类型筛选：切换 Segmented 后仅保留该类型订单", async () => {
    await openLedger();
    fireEvent.click(screen.getByRole("radio", { name: /回收/ }));
    await waitFor(() => expect(screen.queryByText("DG-2026-0002")).toBeNull());
    expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThan(0);
  });

  it("业务模式筛选：切换到分销后过滤自营订单", async () => {
    await openLedger();
    fireEvent.click(screen.getByRole("radio", { name: "分销" }));
    await waitFor(() => expect(screen.queryByText("HS-2026-0001")).toBeNull());
    expect(screen.getAllByText("DG-2026-0002").length).toBeGreaterThan(0);
  });

  it("关联筛选：选择孤儿单后仅保留 link_status=ORPHAN 的订单", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([
      { ...order1, link_status: "ORPHAN" },
      { ...order2, link_status: "LINKED" },
    ]);
    await openLedger();
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "关联状态筛选" }));
    await ui.click(await screen.findByText("孤儿单", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(screen.queryByText("DG-2026-0002")).toBeNull());
    expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThan(0);
  });

  it("切换 Tab 到分期与回款/库存中心", async () => {
    await openLedger();
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "分期与回款" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(screen.getByRole("tab", { name: "库存中心" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "库存中心" })).toHaveAttribute("aria-selected", "true"));
  });

  it("移动端订单卡片渲染完整字段", async () => {
    await openLedger();
    const list = screen.getByLabelText("订单列表");
    // 移动端卡片直接输出 account_status 原始值（未走 StatusTag 映射）
    for (const value of ["卖家甲 · 同行推荐", "原神", "seller-001", "安卓", "IN_STOCK"]) {
      expect(within(list).getAllByText(value).length).toBeGreaterThan(0);
    }
    expect(within(list).getAllByText("¥1,234.00").length).toBeGreaterThan(0);
  });

  it("移动端卡片点击查看详情打开订单抽屉", async () => {
    await openLedger();
    const list = screen.getByLabelText("订单列表");
    await ui.click(within(list).getAllByRole("button", { name: /查看详情/ })[0]);
    expect(await screen.findByText("订单详情 · HS-2026-0001")).toBeInTheDocument();
  });

  it("编辑订单：抽屉内打开编辑弹窗并提交 PATCH（成交日期+备注）", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({ ...order1 });
    vi.mocked(catalog.ordersApi.patch).mockResolvedValue({ ...order1 });
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: /查看详情/ }));
    await screen.findByText("订单详情 · HS-2026-0001");
    await ui.click(screen.getByRole("button", { name: /编辑订单/ }));
    const modal = await modalOf(/编辑订单 · HS-2026-0001/);
    await ui.clear(within(modal).getByLabelText("成交日期"));
    await ui.type(within(modal).getByLabelText("成交日期"), "2026-10-05");
    await ui.type(within(modal).getByLabelText("备注"), "补登记");
    await ui.click(within(modal).getByRole("button", { name: /保存修改/ }));
    await waitFor(() => expect(catalog.ordersApi.patch).toHaveBeenCalledWith(1, expect.objectContaining({
      trade_date: "2026-10-05",
      note: "补登记",
    })));
  });

  it("订单详情：删除关联经二次确认后调用 deleteLink 并刷新列表", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({ ...order1 });
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: /查看详情/ }));
    await screen.findByText("订单详情 · HS-2026-0001");
    await screen.findByText("关联订单");
    // 关联行随 links 异步加载：删除触发按钮出现即关联行已挂载。
    // antd Button 的 accessible name 会被加空格导致精确串失配，按 skill 约定用正则子串（同 UsersPanel 范式）。
    await ui.click(await screen.findByRole("button", { name: /删除/ }, { timeout: 8000 }));
    // 二次确认弹层打开：确认按钮（默认文案「确认」）出现，与触发按钮「删除」区分（套 UsersPanel 范式）
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() => expect(catalog.ordersApi.deleteLink).toHaveBeenCalledWith(1, 77));
    // 删除成功后重新拉取关联列表（首次为开抽屉、二次为删后刷新）
    await waitFor(() => expect(catalog.ordersApi.links).toHaveBeenCalledTimes(2));
    expect(vi.mocked(message.success).mock.calls.map((call) => call[0])).toContain("订单关联已删除");
  });

  it("订单详情：规则快照 found 时展示版本号与固化参数", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({ ...order1 });
    vi.mocked(catalog.policyApi.orderSnapshot).mockResolvedValue({
      found: true,
      snapshot: {
        policy_version_id: 7,
        policy_snapshot: { REBATE: { policy_code: "REBATE", version: 2, config: { rate: "5" } } },
      },
    });
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: /查看详情/ }));
    await screen.findByText("订单详情 · HS-2026-0001");
    expect(await screen.findByText("规则快照")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
    expect(screen.getByText("返点规则")).toBeInTheDocument();
    expect(screen.getByText(/config=\{"rate":"5"\}/)).toBeInTheDocument();
  });

  it("抽屉展示动作记录", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
      ...order1,
      events: [{ id: 101, event_no: "EV-101", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, operator: "张三" }],
    });
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: /查看详情/ }));
    await screen.findByText("订单详情 · HS-2026-0001");
    expect(screen.getByText("动作记录")).toBeInTheDocument();
    // 事件行展示编号、金额、日期+操作人（#36：明细字段不再只有动作/操作人/日期）。
    expect(screen.getByText("EV-101")).toBeInTheDocument();
    expect(screen.getByText("1,000.00")).toBeInTheDocument();
    expect(screen.getByText("2026-10-01 · 张三")).toBeInTheDocument();
  });

  it("抽屉点击去库存中心切换到库存 Tab 并关闭抽屉", async () => {
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: /查看详情/ }));
    await screen.findByText("订单详情 · HS-2026-0001");
    await ui.click(screen.getByRole("button", { name: /去库存中心/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "库存中心" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByText("订单详情 · HS-2026-0001")).toBeNull();
  });

  it("抽屉点击去分期与回款切换到分期 Tab", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([order3]);
    vi.mocked(catalog.ordersApi.get).mockResolvedValue(order3);
    await openLedger();
    await ui.click(within(tableRow("DFQ-2026-0003")).getByRole("button", { name: /查看详情/ }));
    await screen.findByText("订单详情 · DFQ-2026-0003");
    await ui.click(screen.getByRole("button", { name: /去分期与回款/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "分期与回款" })).toHaveAttribute("aria-selected", "true"));
  });

  it("利润分配：打开弹窗并预填已有比例与收益人", async () => {
    await openLedger();
    await openRowMenu("HS-2026-0001", "利润分配");
    const modal = await modalOf(/利润分配 · HS-2026-0001/);
    expect(catalog.policyApi.allocations).toHaveBeenCalledWith(1);
    expect(within(modal).getAllByLabelText("比例")).toHaveLength(4);
    expect(within(modal).getByDisplayValue("40")).toBeInTheDocument();
  });

  it("利润分配：合计非 100% 时拒绝提交", async () => {
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({ items: [], total: 0 });
    await openLedger();
    await openRowMenu("HS-2026-0001", "利润分配");
    const modal = await modalOf(/利润分配 · HS-2026-0001/);
    await clickModalOk(modal);
    await waitFor(() => expect(message.error).toHaveBeenCalledWith("四类收益比例合计必须为 100%"));
    expect(catalog.policyApi.setAllocations).not.toHaveBeenCalled();
  });

  it("利润分配：合计 100% 提交成功并只保留运营收益人", async () => {
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({ items: [], total: 0 });
    await openLedger();
    await openRowMenu("HS-2026-0001", "利润分配");
    const modal = await modalOf(/利润分配 · HS-2026-0001/);
    const rates = within(modal).getAllByLabelText("比例");
    for (const rate of rates) {
      await ui.clear(rate);
      await ui.type(rate, "25");
    }
    await clickModalOk(modal);
    await waitFor(() => expect(catalog.policyApi.setAllocations).toHaveBeenCalled());
    const [orderId, payload] = vi.mocked(catalog.policyApi.setAllocations).mock.calls[0];
    expect(orderId).toBe(1);
    expect(payload).toHaveLength(4);
    expect(payload).toEqual(expect.arrayContaining([
      expect.objectContaining({ allocation_type: "OPERATION", user_id: expect.any(Number) }),
      expect.objectContaining({ allocation_type: "BUY", user_id: null }),
    ]));
    expect(message.success).toHaveBeenCalledWith("利润分配已保存");
  });

  it("利润分配：保存失败提示错误", async () => {
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({ items: [], total: 0 });
    vi.mocked(catalog.policyApi.setAllocations).mockRejectedValue(new Error("alloc fail"));
    await openLedger();
    await openRowMenu("HS-2026-0001", "利润分配");
    const modal = await modalOf(/利润分配 · HS-2026-0001/);
    const rates = within(modal).getAllByLabelText("比例");
    for (const rate of rates) {
      await ui.clear(rate);
      await ui.type(rate, "25");
    }
    await clickModalOk(modal);
    await waitFor(() => expect(message.error).toHaveBeenCalledWith(expect.stringContaining("alloc fail")));
  });

  it("登记退款：填写金额与原因后调用 postEvent(REFUND)", async () => {
    await openLedger();
    await openRowMenu("HS-2026-0001", "登记退款");
    const modal = await modalOf(/登记退款 · HS-2026-0001/);
    await ui.type(within(modal).getByLabelText("退款金额"), "500");
    await ui.type(within(modal).getByLabelText("退款原因"), "客户取消");
    await clickModalOk(modal);
    await waitFor(() =>
      expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(1, expect.objectContaining({ event_type: "REFUND" }))
    );
    expect(message.success).toHaveBeenCalledWith("退款已登记");
  });

  it("登记退款：提交失败提示错误并关闭 loading", async () => {
    vi.mocked(catalog.ordersApi.postEvent).mockRejectedValue(new Error("refund fail"));
    await openLedger();
    await openRowMenu("HS-2026-0001", "登记退款");
    const modal = await modalOf(/登记退款 · HS-2026-0001/);
    await ui.type(within(modal).getByLabelText("退款金额"), "500");
    await ui.type(within(modal).getByLabelText("退款原因"), "客户取消");
    await clickModalOk(modal);
    await waitFor(() => expect(message.error).toHaveBeenCalledWith(expect.stringContaining("refund fail")));
  });

  it("取消交易：存在可冲销已登记动作时发起 CANCEL 冲销", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
      ...order1,
      events: [{ id: 101, event_no: "EV-101", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true }],
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消交易");
    const modal = await modalOf(/取消交易 · HS-2026-0001/);
    await ui.type(screen.getByLabelText("取消原因"), "重复登记");
    fireEvent.click(screen.getByRole("button", { name: /确认取消交易/ }));
    await waitFor(() =>
      expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ event_type: "CANCEL", offset_event_id: 101 }),
      )
    );
  });

  it("取消交易：可改选被冲销动作并按剩余可做部分冲销", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
      ...order1,
      events: [
        { id: 101, event_no: "EV-101", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true },
        { id: 102, event_no: "EV-102", order_id: 1, event_type: "SELL", amount: "500.00", occurred_on: "2026-10-02", is_posted: true },
      ],
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消交易");
    const modal = await modalOf(/取消交易 · HS-2026-0001/);
    // 默认冲销最后一笔可冲销动作（SELL EV-102，剩余 500）
    expect(within(modal).getByText("售出 · EV-102 · ¥500.00（剩余可冲 ¥500.00）")).toBeInTheDocument();
    // 改选 BUY 动作后，冲销金额自动重置为该动作剩余可冲金额
    fireEvent.mouseDown(within(modal).getByLabelText("被冲销动作"));
    await ui.click(await within(document.body).findByText(/EV-101/, { selector: ".ant-select-item-option-content" }));
    expect(within(modal).getByLabelText("冲销金额")).toHaveValue("1000.00");
    // 部分冲销：300 < 剩余 1000
    await ui.clear(within(modal).getByLabelText("冲销金额"));
    await ui.type(within(modal).getByLabelText("冲销金额"), "300");
    await ui.type(screen.getByLabelText("取消原因"), "部分冲销");
    fireEvent.click(screen.getByRole("button", { name: /确认取消交易/ }));
    await waitFor(() =>
      expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ event_type: "CANCEL", offset_event_id: 101, amount: "300" }),
      )
    );
  });

  it("取消交易：分期订单按合约取消并提示退款金额", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([order3]);
    vi.mocked(catalog.ordersApi.get).mockResolvedValue(order3);
    await openLedger();
    await openRowMenu("DFQ-2026-0003", "取消交易");
    const modal = await modalOf(/取消交易 · INS-1/);
    await ui.type(screen.getByLabelText("取消原因"), "提前结清");
    fireEvent.click(screen.getByRole("button", { name: /确认取消交易/ }));
    await waitFor(() => expect(catalog.installmentsApi.cancel).toHaveBeenCalledWith(11, expect.objectContaining({ reason: "提前结清" })));
    // money() 走千分位格式化
    expect(message.success).toHaveBeenCalledWith(expect.stringContaining("退款已登记：¥3,000.00"));
  });

  it("取消交易：分期订单无可用合约时提示", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([order3]);
    vi.mocked(catalog.ordersApi.get).mockResolvedValue(order3);
    vi.mocked(catalog.installmentsApi.list).mockResolvedValue([{ ...installment, status: "CANCELLED" }]);
    await openLedger();
    await openRowMenu("DFQ-2026-0003", "取消交易");
    await waitFor(() => expect(message.error).toHaveBeenCalledWith("未找到可取消的分期合约"));
  });

  it("取消交易：打开详情失败时提示错误", async () => {
    vi.mocked(catalog.ordersApi.get).mockRejectedValue(new Error("detail fail"));
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消交易");
    await waitFor(() => expect(message.error).toHaveBeenCalledWith(expect.stringContaining("detail fail")));
  });

  it("新建订单：选中类型后弹窗打开，关闭回调清空", async () => {
    await openLedger();
    await ui.click(screen.getByRole("button", { name: /新建订单/ }));
    fireEvent.click(await screen.findByText("新建回收订单"));
    expect(await screen.findByTestId("create-stub")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /关闭新建弹窗/ }));
    await waitFor(() => expect(screen.queryByTestId("create-stub")).toBeNull());
  });

  it("新建订单成功回调刷新列表", async () => {
    await openLedger();
    const before = vi.mocked(catalog.ordersApi.list).mock.calls.length;
    await ui.click(screen.getByRole("button", { name: /新建订单/ }));
    fireEvent.click(await screen.findByText("新建回收订单"));
    await screen.findByTestId("create-stub");
    await ui.click(screen.getByRole("button", { name: /模拟新建成功/ }));
    await waitFor(() => expect(screen.queryByTestId("create-stub")).toBeNull());
    expect(vi.mocked(catalog.ordersApi.list).mock.calls.length).toBeGreaterThan(before);
  });
});
