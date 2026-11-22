import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { Form } from "antd";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { renderLight } from "@fixtures/render";
import { OrdersPage } from "@/business/OrdersPage";
import { useLedgerInlineEdit } from "@/business/orders/useLedgerInlineEdit";
import { defaultOperatorUserIds } from "@/business/shared/order-detail/editing/editor-utils";
import { CashflowModal, type CashflowTarget } from "@/finance/cashflow";

import { cashflowsApi } from "@/shared/api/cashflows.api";
import { orderCashflowsApi } from "@/shared/api/orderCashflows.api";
import { installmentsApi } from "@/shared/api/installments.api";
const installmentListFixture = vi.fn<(params?: import("@/shared/api/installments.api").InstallmentListParams) => Promise<import("@/shared/api/types/installments").Installment[]>>();
import { orderFormFieldsApi, orderTypesApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { customersApi, counterpartiesApi } from "@/shared/api/customers.api";
import { profitAllocationApi } from "@/shared/api/profitAllocation.api";
import { poolsApi } from "@/shared/api/pools.api";
import { allFormFields, seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { installmentTotals, orderLedgerSummary, pageResponse, profitAllocationResponse } from "@fixtures/api-responses";
import { today } from "@/shared/lib/format";
import * as client from "@/shared/api/client";
import type { Installment, InstallmentCancelResult } from "@/shared/api/types/installments";
import type { Order } from "@/shared/api/types/orders";
import type { ProfitAllocation } from "@/shared/api/types/profitAllocation";
import type { Pool } from "@/shared/api/types/finance";

let ui: ReturnType<typeof userEvent.setup>;

it("详情新增动作行默认当前员工", () => {
  const employees = [
    { id: 3, username: "operator", display_name: "业务员", is_active: true },
    { id: 5, username: "xiaoxuan", display_name: "小轩", is_active: true },
  ];
  expect(defaultOperatorUserIds(employees, "xiaoxuan")).toEqual([5]);
  expect(defaultOperatorUserIds(employees, "missing")).toBeUndefined();
});

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/orderCashflows.api");
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

// 操作流只验证订单台账与分期入口；库存面板由 InventoryPanel 专项测试覆盖。
vi.mock("@/business/inventory/InventoryPanel", () => ({
  InventoryPanel: ({ active = true, createAction }: { active?: boolean; createAction?: import("react").ReactNode }) => active ? <div data-testid="inventory-panel-test-stub"><div className="ant-card-head">库存中心{createAction}</div></div> : null,
}));

// openAllocations 会调用 api.get("/users") 拉取收益人；normalizeError 必须保留真实实现。
vi.mock("@/shared/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/client")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
    currentUser: vi.fn(),
  };
});
// 订单页的台账编排与分期入口保留真实组件；库存面板本身由独立专项覆盖。

// CreateBusinessModal 用桩替换：暴露 open/onClose/onCreated 三个口，用于覆盖回调分支。
vi.mock("@/business/shared/order-create/CreateBusinessModal", () => ({
  CreateBusinessModal: (props: {
    open: boolean;
    onClose: () => void;
    onCreated: () => Promise<void>;
    initialOrderType?: string;
  }) =>
    props.open ? (
      <div data-testid="create-stub">
        <button type="button" onClick={props.onClose}>关闭新建弹窗</button>
        <button type="button" onClick={() => { props.onClose(); void props.onCreated(); }}>模拟新建成功</button>
      </div>
    ) : null,
}));

// 本文件局部覆盖 rc-motion：尊重传入的 visible（open=false 时弹层真正卸载），
// 使受控 Dropdown「选中后收起」在 jsdom 中可被观测（否则会落到全局 motion-stub 的
// 强制 visible:true，弹层永远残留、aria-expanded 恒为 null，无法判定收起）。
// 注意：打开的 Modal/下拉仍按 open=true 渲染内容，不影响其余用例。
vi.mock("rc-motion", async () => {
  const React = await import("react");
  const CSSMotion = React.forwardRef<unknown, any>(function CSSMotion(
    { children, visible, ...rest },
    ref,
  ) {
    const isVisible = visible !== undefined ? Boolean(visible) : true;
    if (!isVisible) return null;
    const content =
      typeof children === "function"
        ? children({ ...rest, visible: true }, ref)
        : children;
    if (React.isValidElement(content) && ref) {
      return React.cloneElement(content as React.ReactElement<any>, { ref });
    }
    return (content ?? null) as React.ReactNode;
  });
  const CSSMotionList = React.forwardRef<unknown, any>(function CSSMotionList(props, _ref) {
    const { keys = [], children, className, style } = props;
    const parsed = (Array.isArray(keys) ? keys : []).map((k: any) =>
      k && typeof k === "object" ? k : { key: k },
    );
    const items = parsed.map((item: any, index: number) => {
      const nodeRef = React.createRef<unknown>();
      const rendered =
        typeof children === "function"
          ? children({ ...item, index }, nodeRef)
          : children;
      return (
        <React.Fragment key={item?.key ?? index}>
          {rendered ?? null}
        </React.Fragment>
      );
    });
    return <div className={className} style={style}>{items}</div>;
  });
  const Provider = ({ children }: { children?: React.ReactNode }) => children ?? null;
  return { CSSMotion, CSSMotionList, Provider, default: CSSMotion };
});

const order1: Order = {
  id: 1,
  order_no: "HS-2026-0001",
  order_type: "HS",
  trade_date: "2026-10-01",
  status: "ACTIVE",
  business_mode: "SELF",
  account_game_type: "原神",
  account_game_account: "seller-001",
  account_status: "WAITING",
  party_name: "卖家甲",
  party_source: "同行推荐",
  sale_amount: "1234.00",
  last_event_type: "BUY",
  sale_at: "2026-10-02T16:45:00",
  account_id: 5,
};
const order2: Order = {
  id: 2,
  order_no: "DG-2026-0002",
  order_type: "DG",
  trade_date: "2026-10-02",
  status: "COMPLETED",
  business_mode: "DISTRIBUTION",
};
const order3: Order = {
  id: 3,
  order_no: "HS-2026-0003",
  order_type: "HS",
  trade_date: "2026-10-03",
  status: "ACTIVE",
  sale_amount: "12000.00",
  installment_principal: "12000.00",
  installment_paid: "3000.00",
  installment_periods: 6,
};
const orders = [order1, order2];
const types = [{ id: 1, code: "HS", name: "回收", is_active: true }];

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
  total_receivable: "12000.00",
  remaining_receivable: "12000.00",
  status: "ACTIVE",
  operation_operators: [],
  order: {
    id: 3,
    order_no: "HS-2026-0003",
    order_type: "HS",
    trade_date: "2026-10-03",
  },
  schedules: [],
  dispositions: [],
  available_actions: ["pay", "cancel", "settle_early", "default"],
};
const installmentCancelResult: InstallmentCancelResult = {
  installment,
  order_status: "CANCELLED",
  refund_amount: "3000.00",
  reversed_amount: "3000.00",
  cancel_event_ids: [1],
};

// 按人头自由分配的存量数据：不带 allocation_type 时弹窗走「按人」视图。
const allocationRows: ProfitAllocation[] = [
  { id: 1, order_id: 1, user_id: 9, role: "OWNER", allocation_type: null, allocation_rate: "40" },
];
// 按操作四项的存量数据：带 allocation_type 时弹窗走「买号/售出/运营/公司」视图。
const actionAllocationRows: ProfitAllocation[] = [
  { id: 1, order_id: 1, user_id: null, role: "BUYER", allocation_type: "BUY", allocation_rate: "30" },
  { id: 2, order_id: 1, user_id: null, role: "SALES", allocation_type: "SELL", allocation_rate: "40" },
  { id: 3, order_id: 1, user_id: 9, role: "SERVICE", allocation_type: "OPERATION", allocation_rate: "20" },
  { id: 4, order_id: 1, user_id: null, role: "OWNER", allocation_type: "COMPANY", allocation_rate: "10" },
];

beforeEach(() => {
  seedOptionSets();
  seedOrderFormFields();
  vi.mocked(customersApi.options).mockResolvedValue([]);
  vi.mocked(counterpartiesApi.list).mockResolvedValue([]);
  vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse(orders));
  vi.mocked(ordersApi.ledgerSummary).mockResolvedValue(orderLedgerSummary({
    total_count: orders.length,
    status_counts: { ACTIVE: 1, COMPLETED: 1, CANCELLED: 0 },
    type_counts: { HS: 1, DG: 1 },
    game_types: ["原神"],
  }));
  vi.mocked(orderTypesApi.list).mockResolvedValue(types);
  vi.mocked(poolsApi.list).mockResolvedValue([
    { id: 7, code: "HJ_INVEST", name: "投资款荷包", pool_type: "INVEST", status: "ACTIVE" },
  ]);
  vi.mocked(ordersApi.get).mockResolvedValue(order1);
  vi.mocked(ordersApi.executionDetail).mockResolvedValue({
    account: { id: order1.account_id, stock_no: "KU_00001", game_account: "seller-001", game_type: "原神", status: "WAITING", inventory_type: "RECOVERY" },
    orders: [{ order_id: order1.id, order_no: order1.order_no, order_type: order1.order_type, trade_date: order1.trade_date, status: order1.status, events: [] }],
    finance_summary: { total_income: "0", total_expense: "0", net_profit: "0" },
  } as never);
  vi.mocked(ordersApi.cancel).mockResolvedValue({ ...order1, status: "CANCELLED" });
  vi.mocked(ordersApi.inventoryOffsale).mockResolvedValue({ ok: true });
  vi.mocked(ordersApi.postEvent).mockResolvedValue({
    event: { id: 2, event_no: "EV-2", order_id: 1, event_type: "CANCEL", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, cancellable_amount: "0.00" },
    installment: { id: 11, inst_no: "INS-1", status: "CANCELLED" },
    cash_flows: [],
    warnings: [],
  } as never);
  vi.mocked(profitAllocationApi.allocations).mockResolvedValue(profitAllocationResponse(allocationRows, { order_profit: "5000.00" }));
  vi.mocked(profitAllocationApi.set).mockResolvedValue(profitAllocationResponse(allocationRows, { order_profit: "5000.00" }));
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 9, username: "lisi", display_name: "李四", is_active: true },
    { id: 11, username: "recovery", display_name: "回收员", is_active: true },
    { id: 22, username: "seller", display_name: "售出员", is_active: true },
    { id: 33, username: "operator", display_name: "运营员", is_active: true },
  ]);
  installmentListFixture.mockResolvedValue([installment]);
  vi.mocked(installmentsApi.page).mockImplementation(async ({ limit, offset, sort_desc, ...filters }) => {
    const rows = await installmentListFixture(filters);
    const sorted = [...rows].sort((a, b) => sort_desc ? b.id - a.id : a.id - b.id);
    return pageResponse(sorted.slice(offset, offset + limit), { total: sorted.length, limit, offset });
  });
  vi.mocked(installmentsApi.totals).mockResolvedValue(installmentTotals());
  vi.mocked(installmentsApi.cancel).mockResolvedValue(installmentCancelResult);
  vi.mocked(client.currentUser).mockResolvedValue({ id: 9, username: "lisi", role: "operator", display_name: "李四" });
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
});

async function openLedger(user = "admin") {
  // 该操作流校验当前用户会被默认带入操作人；显式开启真实会话同步，
  // 其余组件测试仍保持默认隔离本地后端。
  renderLight(<OrdersPage />, { user, syncDevUser: true });
  await ui.click(await screen.findByRole("tab", { name: "订单台账" }));
  await waitFor(() => expect(document.querySelector("tbody tr")).toBeTruthy());
}

function tableRow(orderNo: string): HTMLElement {
  const rows = Array.from(document.querySelectorAll("tbody tr")) as HTMLElement[];
  return rows.find((row) => row.textContent?.includes(orderNo))!;
}

async function openRowMenu(orderNo: string, item: string) {
  fireEvent.click(within(tableRow(orderNo)).getByRole("button", { name: item }));
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
  it("订单预览使用缩略图，进入编辑前重新读取原图", async () => {
    const original = "data:image/png;base64,original";
    const preview = "data:image/jpeg;base64,thumbnail";
    const selected = { ...order1, id: 1, account_id: 1 };
    vi.mocked(ordersApi.executionDetail).mockImplementation(async (_id, options) => ({
      account: { id: 1, source_order_id: 1, account_images: [options?.imagePreviews ? preview : original] },
      image_previews: Boolean(options?.imagePreviews),
      orders: [],
    }) as never);
    function Probe() {
      const ledger = useLedgerInlineEdit();
      return <><Form form={ledger.invEditExtraForm} /><button onClick={() => void ledger.loadLedgerOrderDetail(1)}>展开</button>
        <button onClick={() => void ledger.openLedgerEditor(selected)}>编辑</button>
        <span>{`预览:${ledger.ledgerOrderDetails[1]?.account.account_images?.[0] ?? "无"}`}</span>
        <span>{`草稿:${ledger.editingAccount?.account_images?.[0] ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "展开" }));
    await screen.findByText(`预览:${preview}`);
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByText(`草稿:${original}`);
    expect(ordersApi.executionDetail).toHaveBeenCalledWith(1, { imagePreviews: true });
    expect(ordersApi.executionDetail).toHaveBeenCalledWith(1, { fresh: true });
  });
  it("订单保存失败后，之前等待加载的其他订单不能覆盖当前草稿", async () => {
    let resolveSecond!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const second = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { resolveSecond = resolve; });
    const firstOrder = { ...order1, id: 1, account_id: 1 };
    const secondOrder = { ...order1, id: 2, account_id: 2 };
    const snapshot = (id: number) => ({ account: { id, source_order_id: id }, orders: [], detail_view: { finance_rows: [] } }) as never;
    vi.mocked(ordersApi.executionDetail).mockImplementation((id) => id === 2 ? second : Promise.resolve(snapshot(1)));
    vi.mocked(ordersApi.updateExecution).mockRejectedValueOnce(new Error("保存失败"));
    function Probe() {
      const ledger = useLedgerInlineEdit();
      return <><Form form={ledger.invEditExtraForm} /><button onClick={() => void ledger.openLedgerEditor(firstOrder)}>编辑甲</button>
        <button onClick={() => void ledger.openLedgerEditor(secondOrder)}>编辑乙</button>
        <button onClick={() => ledger.updateEditingAccount({ account_description: "甲的草稿" })}>修改甲</button>
        <button onClick={() => void ledger.saveInline()}>保存甲</button>
        <span>{`编辑:${ledger.inlineEditId ?? "无"},草稿:${ledger.editingAccount?.account_description ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑甲" }));
    await screen.findByText("编辑:1,草稿:无");
    await ui.click(screen.getByRole("button", { name: "修改甲" }));
    await ui.click(screen.getByRole("button", { name: "编辑乙" }));
    await ui.click(screen.getByRole("button", { name: "保存甲" }));
    await waitFor(() => expect(ordersApi.updateExecution).toHaveBeenCalledTimes(1));
    await act(async () => resolveSecond(snapshot(2)));
    expect(screen.getByText("编辑:1,草稿:甲的草稿")).toBeInTheDocument();
  });
  it("订单台账连续编辑不同行时，只打开最后选择的订单", async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { resolveFirst = resolve; });
    const firstOrder = { ...order1, id: 1, account_id: 1 };
    const secondOrder = { ...order1, id: 2, account_id: 2 };
    const snapshot = (id: number) => ({ account: { id, source_order_id: id }, orders: [] }) as never;
    vi.mocked(ordersApi.executionDetail).mockImplementation((id) => id === 1 ? first : Promise.resolve(snapshot(2)));
    function Probe() {
      const ledger = useLedgerInlineEdit();
      return <><Form form={ledger.invEditExtraForm} /><button onClick={() => void ledger.openLedgerEditor(firstOrder)}>编辑甲</button>
        <button onClick={() => void ledger.openLedgerEditor(secondOrder)}>编辑乙</button>
        <span>{`展开:${ledger.expandedOrderIds.join(",")},编辑:${ledger.inlineEditId ?? "无"},草稿:${ledger.editingAccount?.id ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑甲" }));
    await ui.click(screen.getByRole("button", { name: "编辑乙" }));
    await screen.findByText("展开:2,编辑:2,草稿:2");
    await act(async () => resolveFirst(snapshot(1)));
    expect(screen.getByText("展开:2,编辑:2,草稿:2")).toBeInTheDocument();
  });

  it("订单台账切换展开行后，待加载的编辑不能抢回展开状态", async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { resolveFirst = resolve; });
    const firstOrder = { ...order1, id: 1, account_id: 1 };
    const secondOrder = { ...order1, id: 2, account_id: 2 };
    const snapshot = (id: number) => ({ account: { id, source_order_id: id }, orders: [] }) as never;
    vi.mocked(ordersApi.executionDetail).mockImplementation((id) => id === 1 ? first : Promise.resolve(snapshot(2)));
    function Probe() {
      const ledger = useLedgerInlineEdit();
      return <><Form form={ledger.invEditExtraForm} /><button onClick={() => void ledger.openLedgerEditor(firstOrder)}>编辑甲</button>
        <button onClick={() => ledger.handleLedgerExpand(true, secondOrder)}>展开乙</button>
        <span>{`展开:${ledger.expandedOrderIds.join(",")},编辑:${ledger.inlineEditId ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑甲" }));
    await ui.click(screen.getByRole("button", { name: "展开乙" }));
    await screen.findByText("展开:2,编辑:无");
    await act(async () => resolveFirst(snapshot(1)));
    expect(screen.getByText("展开:2,编辑:无")).toBeInTheDocument();
  });
  it.each(["success", "failure"])("订单详情强制刷新后忽略更早请求的%s结果", async (oldResult) => {
    let resolveOld!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    let rejectOld!: (error: Error) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const detail = (description: string) => ({ account: { id: 1, account_description: description }, orders: [] }) as never;
    vi.mocked(ordersApi.executionDetail).mockReturnValueOnce(oldRequest).mockResolvedValueOnce(detail("最新详情"));
    function Probe() {
      const ledger = useLedgerInlineEdit();
      return <><button onClick={() => void ledger.loadLedgerOrderDetail(1)}>读取</button>
        <button onClick={() => void ledger.loadLedgerOrderDetail(1, true)}>刷新</button>
        <span>{ledger.ledgerOrderDetails[1]?.account.account_description}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "读取" }));
    await ui.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("最新详情")).toBeInTheDocument();
    await act(async () => { if (oldResult === "failure") rejectOld(new Error("过时请求失败")); else resolveOld(detail("过时详情")); });
    expect(screen.getByText("最新详情")).toBeInTheDocument();
    expect(screen.queryByText("过时详情")).not.toBeInTheDocument();
    expect(message.error).not.toHaveBeenCalled();
  });
  it("分期订单展示售出金额而不是买入金额合计", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([order3]));
    await openLedger();
    expect(screen.getAllByText("¥12,000.00").length).toBeGreaterThan(0);
  });

  it("类型筛选：切换 Segmented 后仅保留该类型订单", async () => {
    vi.mocked(ordersApi.listPage).mockImplementation(async (params) => pageResponse(params?.order_type === "HS" ? [order1] : orders));
    await openLedger();
    fireEvent.click(screen.getByRole("radio", { name: /回收/ }));
    await waitFor(() => expect(screen.queryByText("DG-2026-0002")).toBeNull());
    expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThan(0);
  });

  it("业务模式筛选：切换到分销后过滤自营订单", async () => {
    vi.mocked(ordersApi.listPage).mockImplementation(async (params) => pageResponse(params?.business_mode === "DISTRIBUTION" ? [order2] : orders));
    await openLedger();
    fireEvent.click(screen.getByRole("radio", { name: "分销" }));
    await waitFor(() => expect(screen.queryByText("HS-2026-0001")).toBeNull());
    expect(screen.getAllByText("DG-2026-0002").length).toBeGreaterThan(0);
  });

  it("切换 Tab 到分期与回款/库存中心", async () => {
    await openLedger();
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "分期与回款" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(screen.getByRole("tab", { name: "库存中心" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "库存中心" })).toHaveAttribute("aria-selected", "true"));
  });

  // 逾期标记是全局动作（后端按 as_of 扫描全部合约），入口从分期面板收敛到
  // 订单页「分期与回款」Tab 的右上角，这两个用例随功能入口一起从 InstallmentsPanel.flows 迁入。
  it("切走再切回「分期与回款」会重拉分期列表（切入即刷新）", async () => {
    installmentListFixture.mockResolvedValue([]);
    await openLedger();
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));
    await waitFor(() => expect(installmentListFixture).toHaveBeenCalled());
    // 首次切入只靠挂载 load，不自增 refreshKey（避免双请求）
    expect(installmentListFixture).toHaveBeenCalledTimes(1);
    const callsAfterFirstEntry = installmentListFixture.mock.calls.length;

    fireEvent.click(screen.getByRole("tab", { name: "订单台账" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "订单台账" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));

    await waitFor(() =>
      expect(installmentListFixture.mock.calls.length).toBeGreaterThan(callsAfterFirstEntry),
    );
  });

  it("标记逾期失败时提示错误且允许重试", async () => {
    installmentListFixture.mockResolvedValue([]);
    vi.mocked(installmentsApi.markOverdue).mockRejectedValueOnce(new Error("逾期标记失败"));
    await openLedger();
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));
    const button = await screen.findByRole("button", { name: /标记逾期/ });
    await ui.click(button);
    await waitFor(() => expect(message.error).toHaveBeenCalledWith(expect.stringContaining("逾期标记失败")));
    expect(button).not.toHaveClass("ant-btn-loading");
    vi.mocked(installmentsApi.markOverdue).mockResolvedValueOnce({ marked: 1 });
    await ui.click(button);
    await waitFor(() => expect(message.success).toHaveBeenCalledWith("已标记 1 笔逾期"));
  });

  // 原两条（有新增 / 无新增）是同一条「标记逾期」路径的两个分支，合并为一次挂载逐次点击。
  it("标记逾期：有新增提示笔数并刷新列表，无新增提示当前无新增", async () => {
    installmentListFixture.mockResolvedValue([]);
    vi.mocked(installmentsApi.markOverdue).mockResolvedValue({ marked: 3 });
    await openLedger();
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));
    await waitFor(() => expect(installmentListFixture).toHaveBeenCalled());
    const callsBefore = installmentListFixture.mock.calls.length;

    await ui.click(screen.getByRole("button", { name: /标记逾期/ }));

    await waitFor(() => expect(installmentsApi.markOverdue).toHaveBeenCalled());
    expect(message.success).toHaveBeenCalledWith("已标记 3 笔逾期");
    // installmentRefreshKey 自增 → 分期面板重新 load
    await waitFor(() => expect(screen.getByRole("tab", { name: "分期与回款" })).toBeInTheDocument());
    expect(installmentListFixture.mock.calls.length).toBeGreaterThan(callsBefore);

    // 分支二：本次标记 0 笔
    vi.mocked(installmentsApi.markOverdue).mockResolvedValue({ marked: 0 });
    await ui.click(screen.getByRole("button", { name: /标记逾期/ }));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith("当前无新增逾期合约"));
  });

  it("编辑有登记事件订单：统一编辑入口仍可打开库存详情", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([
      {
        ...order1,
        events: [{ id: 1, event_no: "EV-1", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, cancellable_amount: "1000.00" }],
      },
    ]));
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("button", { name: "保存修改" })).toBeInTheDocument();
    expect(screen.queryByLabelText("编辑游戏账号/产品")).toBeNull();
  });

  it.each(["分润配置", "资金收支"])("打开%s时订单与辅助数据并行加载", async (action) => {
    await openLedger();
    let finish!: (order: Order) => void;
    const pending = new Promise<Order>((resolve) => { finish = resolve; });
    vi.mocked(ordersApi.get).mockReturnValueOnce(pending);
    vi.mocked(employeesApi.list).mockClear();
    vi.mocked(profitAllocationApi.allocations).mockClear();
    vi.mocked(poolsApi.list).mockClear();
    await openRowMenu("HS-2026-0001", action);
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalled());
    if (action === "分润配置") expect(profitAllocationApi.allocations).toHaveBeenCalledWith(1);
    else expect(poolsApi.list).toHaveBeenCalled();
    await act(async () => finish(order1));
    const modal = await modalOf(action === "分润配置" ? /分润 · HS-2026-0001/ : /资金收支 · HS-2026-0001/);
    expect(modal).toBeVisible();
    if (action === "分润配置") {
      await ui.click(within(modal).getByRole("button", { name: "查看订单详情" }));
      await waitFor(() => expect(ordersApi.executionDetail).toHaveBeenCalledWith(1, { fresh: true, imagePreviews: true }));
      expect(await screen.findByText("订单详情")).toBeInTheDocument();
    }
  });

  // 原两条（按姓名预填 / 展示订单总利润）同一份夹具、同一入口、纯只读，合并为一次挂载。
  it("分润弹窗复用不残留 form_extra：取消后打开另一单，自定义字段清空", async () => {
    // 注入一个 ALLOCATION scope 的自定义字段：CustomFieldSection 只渲染 is_custom && is_active。
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([
      ...allFormFields(),
      {
        id: 9001,
        order_type_code: "ALLOCATION",
        field_key: "alloc_note",
        label: "分润备注",
        field_type: "TEXT",
        options: [],
        required: false,
        is_active: true,
        sort_order: 99,
        locked: false,
        is_custom: true,
        section: "EXTRA",
        note: null,
      },
    ] as never);

    await openLedger();
    // openAllocations 会按 id 重拉订单；默认桩恒返回 order1，这里按 id 分流才能拿到第二单的标题。
    vi.mocked(ordersApi.get).mockImplementation(async (id) => (id === 2 ? order2 : order1));
    // 第一单：填自定义字段后取消（不 reset 会留在被复用的 allocationForm store 里）。
    await openRowMenu("HS-2026-0001", "分润配置");
    const first = await modalOf(/分润 · HS-2026-0001/);
    // 字段配置按 scope 异步加载，必须等自定义字段渲染出来。
    await ui.type(await within(first).findByLabelText("分润备注"), "上一单的残留值");
    // 默认 Modal 的取消文案受 ConfigProvider locale 影响，按结构取 X 关闭按钮。
    fireEvent.click(first.querySelector(".ant-modal-close") as HTMLElement);
    // antd Modal 默认不销毁内容，关闭后 DOM 仍隐藏保留；等它隐藏后再开第二单。
    await waitFor(() => expect(first).not.toBeVisible());

    await openRowMenu("DG-2026-0002", "分润配置");
    const second = await modalOf(/分润 · DG-2026-0002/);
    await waitFor(() => expect(within(second).getByLabelText("分润备注")).toHaveValue(""));
  });

  it("零利润订单未修改金额时保存，保留已有人员分润比例", async () => {
    vi.mocked(profitAllocationApi.allocations).mockResolvedValue(profitAllocationResponse([], {
      order_profit: "0.00", allocatable_profit: "0.00",
      totals_by_type: { BUY: { allocation_amount: "0.00", allocation_rate: "60.00" } },
    }));
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    await clickModalOk(modal);
    await waitFor(() => expect(profitAllocationApi.set).toHaveBeenCalledWith(1, expect.arrayContaining([
      expect.objectContaining({ allocation_type: "BUY", allocation_rate: "60.00", allocation_amount: null }),
    ]), undefined));
  });

  it("公司比例为 100% 但订单有利润时，仍按金额提交", async () => {
    vi.mocked(profitAllocationApi.allocations).mockResolvedValue(profitAllocationResponse([], {
      order_profit: "500.00", allocatable_profit: "0.00", company_rate: "100.00",
      totals_by_type: { BUY: { allocation_amount: "0.00", allocation_rate: "0.00" } },
    }));
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    await clickModalOk(await modalOf(/分润 · HS-2026-0001/));
    await waitFor(() => expect(profitAllocationApi.set).toHaveBeenCalledWith(1, expect.arrayContaining([
      expect.objectContaining({ allocation_type: "BUY", allocation_rate: null, allocation_amount: "0.00" }),
    ]), undefined));
  });

  it("打开分润配置直接展示后端汇总金额与比例，不逐行换算", async () => {
    vi.mocked(profitAllocationApi.allocations).mockResolvedValue(profitAllocationResponse([], {
      totals_by_type: { BUY: { allocation_amount: "100.00", allocation_rate: "20.00" } },
    }));
    vi.mocked(profitAllocationApi.convert).mockReset().mockResolvedValue({ value: "20.00" });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    expect(within(modal).getAllByLabelText("金额")[0]).toHaveValue("100.00");
    expect(within(modal).getAllByLabelText("比例")[0]).toHaveValue("20.00");
    expect(profitAllocationApi.convert).not.toHaveBeenCalled();
  });

  it("连续打开不同订单的分润配置，较晚返回的汇总不能覆盖当前订单", async () => {
    let finishFirst!: (result: Awaited<ReturnType<typeof profitAllocationApi.allocations>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof profitAllocationApi.allocations>>>((resolve) => { finishFirst = resolve; });
    vi.mocked(ordersApi.get).mockImplementation(async (id) => id === 1 ? order1 : order2);
    vi.mocked(profitAllocationApi.allocations).mockImplementation((id) => id === 1 ? first : Promise.resolve(profitAllocationResponse([], {
      totals_by_type: { BUY: { allocation_amount: "200.00", allocation_rate: "20.00" } },
    })));
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    await waitFor(() => expect(profitAllocationApi.allocations).toHaveBeenCalledWith(1));
    await openRowMenu("DG-2026-0002", "分润配置");
    const modal = await modalOf(/分润 · DG-2026-0002/);
    await act(async () => finishFirst(profitAllocationResponse([], {
      totals_by_type: { BUY: { allocation_amount: "100.00", allocation_rate: "10.00" } },
    })));
    expect(within(modal).getAllByLabelText("金额")[0]).toHaveValue("200.00");
    expect(within(modal).getAllByLabelText("比例")[0]).toHaveValue("20.00");
  });

  it("分润汇总读取失败时提示错误且不打开弹窗", async () => {
    vi.mocked(profitAllocationApi.allocations).mockRejectedValueOnce(new Error("汇总读取失败"));
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    await waitFor(() => expect(message.error).toHaveBeenCalledWith(expect.stringContaining("汇总读取失败")));
    expect(screen.queryByText(/分润 · HS-2026-0001/)).not.toBeInTheDocument();
  });

  it("分润口径缺失时提示错误且不打开弹窗", async () => {
    const incomplete = profitAllocationResponse([]);
    vi.mocked(profitAllocationApi.allocations).mockResolvedValueOnce({ ...incomplete, company_rate: undefined } as never);
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    await waitFor(() => expect(message.error).toHaveBeenCalledWith("分润数据不完整，请刷新后重试"));
    expect(screen.queryByText(/分润 · HS-2026-0001/)).not.toBeInTheDocument();
  });

  it("分润比例换算失败时清空旧比例并提示重试", async () => {
    vi.mocked(profitAllocationApi.allocations).mockResolvedValue(profitAllocationResponse([], {
      totals_by_type: { BUY: { allocation_amount: "100.00", allocation_rate: "10.00" } },
    }));
    vi.mocked(profitAllocationApi.convert).mockResolvedValue({ value: "10.00" });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    const amount = within(modal).getAllByLabelText("金额")[0];
    const rate = within(modal).getAllByLabelText("比例")[0];
    expect(amount.closest(".money-input")).toHaveTextContent("¥");
    expect(amount).toHaveAttribute("inputmode", "decimal");
    expect(rate).toHaveValue("10.00");
    vi.mocked(profitAllocationApi.convert).mockRejectedValueOnce(new Error("网络错误"));
    fireEvent.change(amount, { target: { value: "200.00" } });
    expect(rate).toHaveValue("");
    fireEvent.blur(amount);
    await waitFor(() => expect(message.error).toHaveBeenCalledWith("分润比例换算失败，请重试"));
    expect(rate).toHaveValue("");
  });

  it("关闭分润弹窗后，旧订单的金额换算不能覆盖新订单", async () => {
    let finishFirst!: (result: { value: string | null }) => void;
    const firstConversion = new Promise<{ value: string | null }>((resolve) => { finishFirst = resolve; });
    vi.mocked(ordersApi.get).mockImplementation(async (id) => id === 1 ? order1 : order2);
    vi.mocked(profitAllocationApi.allocations).mockImplementation(async (id) => profitAllocationResponse([], {
      totals_by_type: id === 1 ? {} : { BUY: { allocation_amount: "200.00", allocation_rate: "20.00" } },
    }));
    vi.mocked(profitAllocationApi.convert).mockImplementation((id) => id === 1 ? firstConversion : Promise.resolve({ value: "20.00" }));

    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    const first = await modalOf(/分润 · HS-2026-0001/);
    const amount = within(first).getAllByLabelText("金额")[0];
    fireEvent.change(amount, { target: { value: "100.00" } });
    fireEvent.blur(amount);
    await waitFor(() => expect(profitAllocationApi.convert).toHaveBeenCalledWith(1, "AMOUNT_TO_RATE", "100.00"));
    fireEvent.click(first.querySelector(".ant-modal-close") as HTMLElement);
    await waitFor(() => expect(first).not.toBeVisible());
    await openRowMenu("DG-2026-0002", "分润配置");
    const second = await modalOf(/分润 · DG-2026-0002/);
    expect(within(second).getAllByLabelText("比例")[0]).toHaveValue("20.00");
    await act(async () => finishFirst({ value: "99.00" }));
    expect(within(second).getAllByLabelText("比例")[0]).toHaveValue("20.00");
  });

  it("上一单保存完成时，不关闭后来打开的分润配置", async () => {
    let finishSave!: (result: Awaited<ReturnType<typeof profitAllocationApi.set>>) => void;
    const saving = new Promise<Awaited<ReturnType<typeof profitAllocationApi.set>>>((resolve) => { finishSave = resolve; });
    vi.mocked(profitAllocationApi.set).mockReturnValueOnce(saving);
    vi.mocked(profitAllocationApi.allocations).mockResolvedValue(profitAllocationResponse([]));
    vi.mocked(ordersApi.get).mockImplementation(async (id) => id === 1 ? order1 : order2);
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    const first = await modalOf(/分润 · HS-2026-0001/);
    await clickModalOk(first);
    await waitFor(() => expect(profitAllocationApi.set).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(first).not.toBeVisible());
    await openRowMenu("DG-2026-0002", "分润配置");
    const second = await modalOf(/分润 · DG-2026-0002/);
    fireEvent.change(within(second).getAllByLabelText("金额")[0], { target: { value: "200.00" } });
    await act(async () => finishSave(profitAllocationResponse([])));
    expect(second).toBeVisible();
    expect(within(second).getAllByLabelText("金额")[0]).toHaveValue("200.00");
  });

  it("分润保存中重复提交只写入一次", async () => {
    let finishSave!: (result: Awaited<ReturnType<typeof profitAllocationApi.set>>) => void;
    const saving = new Promise<Awaited<ReturnType<typeof profitAllocationApi.set>>>((resolve) => { finishSave = resolve; });
    vi.mocked(profitAllocationApi.set).mockReturnValue(saving);
    vi.mocked(profitAllocationApi.allocations).mockResolvedValue(profitAllocationResponse([]));
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    const form = within(modal).getAllByLabelText("金额")[0].closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(profitAllocationApi.set).toHaveBeenCalledTimes(1));
    fireEvent.submit(form);
    await act(async () => { await Promise.resolve(); });
    expect(profitAllocationApi.set).toHaveBeenCalledTimes(1);
    await act(async () => finishSave(profitAllocationResponse([])));
  });

  it("分润：只展示可分配动作，公司比例由规则配置补入", async () => {
    // 空分润 → 只展示买号、售出、运营；公司 40% 隐藏并由规则配置自动补入。
    vi.mocked(profitAllocationApi.allocations).mockResolvedValue(profitAllocationResponse([], { order_profit: "5000.00", allocatable_profit: "3000.00", company_rate: "40.00" }));
    vi.mocked(ordersApi.get).mockResolvedValue({
      ...order1,
      form_extra: {
        business_responsible_ids: [11],
        sell_delivery_responsible_ids: [22],
      },
      events: [
        { id: 101, event_no: "EV-101", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, operator_user_ids: [], cancellable_amount: "1000.00" },
        { id: 102, event_no: "EV-102", order_id: 1, event_type: "SELL", amount: "1500.00", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [], cancellable_amount: "1500.00" },
        { id: 103, event_no: "EV-103", order_id: 1, event_type: "OPERATE", operation_type: "DESCRIPTION", amount: "100.00", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [33], cancellable_amount: "100.00" },
      ],
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    expect(within(modal).getByText(/可分配利润/)).toBeInTheDocument();
    expect(within(modal).getByText("3,000.00")).toBeInTheDocument();
    expect(within(modal).getAllByLabelText("比例")).toHaveLength(3);
    for (const label of ["买号", "售出", "运营"]) {
      expect(within(modal).getByText(label)).toBeInTheDocument();
    }
    expect(within(modal).queryByText("公司")).toBeNull();
    // 买号取建单操作人，售出取卖出表单操作人，运营取运营信息中的动作操作人，均自动带出。
    expect(within(modal).getByText("回收员")).toBeInTheDocument();
    expect(within(modal).getByText("售出员")).toBeInTheDocument();
    expect(within(modal).getByText("运营员")).toBeInTheDocument();
  });
  it("分润：一个动作多人时提交动作合计，均分由后端处理", async () => {
    // 前端只提交动作合计和人员名单；按人数均分由后端保存服务统一处理。
    vi.mocked(profitAllocationApi.allocations).mockResolvedValue(profitAllocationResponse([], { order_profit: "5000.00" }));
    vi.mocked(ordersApi.get).mockResolvedValue({
      ...order1,
      form_extra: {
        business_responsible_ids: [11, 22],
        sell_delivery_responsible_ids: [22],
        operation_responsible_ids: [33],
      },
      events: [
        { id: 101, event_no: "EV-101", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, operator_user_ids: [], cancellable_amount: "1000.00" },
        { id: 102, event_no: "EV-102", order_id: 1, event_type: "SELL", amount: "1500.00", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [], cancellable_amount: "1500.00" },
      ],
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    const modal = await modalOf(/分润 · HS-2026-0001/);

    // 买号两人只占一行，人员多选后填写动作合计；金额是唯一提交口径，比例只读展示。
    expect(within(modal).getByText("买号")).toBeInTheDocument();
    expect(within(modal).getAllByLabelText("比例")).toHaveLength(3);
    const amounts = within(modal).getAllByLabelText("金额");
    fireEvent.change(amounts[0], { target: { value: "300.00" } });

    // 售出 150.00、运营留空；公司金额由后端按固定比例自动补入。
    fireEvent.change(amounts[1], { target: { value: "150.00" } });

    await clickModalOk(modal);
    await waitFor(() => expect(profitAllocationApi.set).toHaveBeenCalled());
    const [, payload, extra] = vi.mocked(profitAllocationApi.set).mock.calls[0];
    expect(extra).toBeUndefined();
    const buyRows = payload.filter((item) => item.allocation_type === "BUY");
    expect(buyRows).toEqual([{ allocation_type: "BUY", employee_ids: [11, 22], role: "BUYER", allocation_rate: null, allocation_amount: "300.00" }]);
    expect(payload).toHaveLength(4);
  });

  it("分润保存成功后不等待台账刷新即可关闭弹窗", async () => {
    vi.mocked(profitAllocationApi.allocations).mockResolvedValue(profitAllocationResponse(actionAllocationRows, { order_profit: "5000.00", allocatable_profit: "3000.00", company_rate: "40.00" }));
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    let finish!: (value: never) => void;
    const slowReload = new Promise<never>((resolve) => { finish = resolve; });
    vi.mocked(ordersApi.listPage).mockReturnValueOnce(slowReload);
    await clickModalOk(modal);
    await waitFor(() => expect(profitAllocationApi.set).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /分润 · HS-2026-0001/ })).toBeNull());
    await act(async () => { finish(pageResponse(orders) as never); await slowReload; });
  });

  it("分润：按操作四项提交时只传金额、比例一律传 null", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => [
      ...allFormFields().filter((field) => field.order_type_code === scope),
      ...(scope === "ALLOCATION" ? [{ id: 9001, order_type_code: scope, field_key: "receipt", label: "分润凭据",
        field_type: "TEXT", required: true, is_active: true, sort_order: 99, locked: false, is_custom: true,
        section: "FINANCE" }, { id: 9002, order_type_code: scope, field_key: "optional_number", label: "分润附加数字",
        field_type: "NUMBER", required: false, is_active: true, sort_order: 100, locked: false, is_custom: true,
        section: "BUSINESS" }] : []),
    ] as never);
    vi.mocked(profitAllocationApi.allocations).mockResolvedValue(profitAllocationResponse(actionAllocationRows, { order_profit: "5000.00", allocatable_profit: "3000.00", company_rate: "40.00" }));
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    expect(within(modal).getAllByLabelText("比例")).toHaveLength(3);
    await ui.type(await within(modal).findByLabelText("分润凭据"), "分润凭据A");
    await ui.type(within(modal).getByLabelText("分润附加数字"), "17");
    await ui.clear(within(modal).getByLabelText("分润附加数字"));
    await clickModalOk(modal);
    await waitFor(() => expect(profitAllocationApi.set).toHaveBeenCalled());
    const [, payload] = vi.mocked(profitAllocationApi.set).mock.calls[0];
    expect(payload).toHaveLength(4);
    expect(payload.map((item) => item.allocation_type)).toEqual(["BUY", "SELL", "OPERATION", "COMPANY"]);
    expect(payload.find((item) => item.allocation_type === "OPERATION")).toMatchObject({ employee_ids: [9], role: "SERVICE" });
    // 比例只读展示，落库与提交唯一口径是金额：比例一律 null，公司行金额留空交后端补。
    expect(payload.every((item) => item.allocation_rate === null)).toBe(true);
    expect(payload.find((item) => item.allocation_type === "COMPANY")).toMatchObject({ allocation_rate: null, allocation_amount: null });
    expect(vi.mocked(profitAllocationApi.set).mock.calls[0][2]).toEqual(expect.objectContaining({ receipt: "分润凭据A" }));
    expect(vi.mocked(profitAllocationApi.set).mock.calls[0][2]).not.toHaveProperty("optional_number");
  });

  it.each(["切换", "关闭"])("订单资金收支%s后，较早的请求不能打开其他订单", async (action) => {
    let finishFirst!: (order: Order) => void;
    const first = new Promise<Order>((resolve) => { finishFirst = resolve; });
    vi.mocked(ordersApi.get).mockImplementation((id) => id === 1 ? first : Promise.resolve(order2));
    vi.mocked(orderCashflowsApi.create).mockResolvedValue({} as never);
    await openLedger();
    await openRowMenu("HS-2026-0001", "资金收支");
    await openRowMenu("DG-2026-0002", "资金收支");
    const second = await modalOf(/资金收支 · DG-2026-0002/);
    fireEvent.change(within(second).getByLabelText("金额"), { target: { value: "200" } });
    fireEvent.change(within(second).getByLabelText("收支备注"), { target: { value: "第二单" } });
    if (action === "关闭") {
      fireEvent.click(second.querySelector(".ant-modal-close") as HTMLElement);
      await waitFor(() => expect(second).not.toBeVisible());
    }
    await act(async () => finishFirst(order1));
    expect(screen.queryByRole("dialog", { name: /资金收支 · HS-2026-0001/ })).toBeNull();
    if (action === "关闭") {
      expect(screen.queryByRole("dialog", { name: /资金收支 · DG-2026-0002/ })).toBeNull();
    } else {
      expect(second).toBeVisible();
      expect(within(second).getByLabelText("金额")).toHaveValue("200");
      await clickModalOk(second);
      await waitFor(() => expect(orderCashflowsApi.create).toHaveBeenCalledWith(2, expect.objectContaining({ amount: "200", note: "第二单" })));
    }
  });

  it.each(["成功", "失败"])("上一单资金收支提交%s后，不影响后来打开的订单", async (result) => {
    let finish!: (value: Awaited<ReturnType<typeof orderCashflowsApi.create>>) => void;
    let fail!: (error: Error) => void;
    vi.mocked(orderCashflowsApi.create).mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    vi.mocked(ordersApi.get).mockImplementation(async (id) => id === 1 ? order1 : order2);
    await openLedger();
    await openRowMenu("HS-2026-0001", "资金收支");
    const first = await modalOf(/资金收支 · HS-2026-0001/);
    fireEvent.change(within(first).getByLabelText("金额"), { target: { value: "100" } });
    fireEvent.change(within(first).getByLabelText("收支备注"), { target: { value: "第一单" } });
    await clickModalOk(first);
    await waitFor(() => expect(orderCashflowsApi.create).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(first).not.toBeVisible());
    await openRowMenu("DG-2026-0002", "资金收支");
    const second = await modalOf(/资金收支 · DG-2026-0002/);
    fireEvent.change(within(second).getByLabelText("金额"), { target: { value: "200" } });
    await act(async () => { if (result === "成功") finish({} as never); else fail(new Error("第一单提交失败")); });
    expect(second).toBeVisible();
    expect(within(second).getByLabelText("金额")).toHaveValue("200");
    expect(within(second).queryByText(/第一单提交失败/)).toBeNull();
  });

  it("资金收支保存后不等待后台刷新即可登记另一单", async () => {
    let finishReload!: () => void;
    const slowReload = new Promise<void>((resolve) => { finishReload = resolve; });
    const pools: Pool[] = [{ id: 7, code: "HJ_INVEST", name: "投资款荷包", pool_type: "INVEST", status: "ACTIVE" }];
    const onCreated = vi.fn().mockReturnValueOnce(slowReload).mockResolvedValue(undefined);
    vi.mocked(orderCashflowsApi.create).mockResolvedValue({} as never);
    function Probe() {
      const [target, setTarget] = useState<CashflowTarget | null>(null);
      return <><button onClick={() => setTarget({ orderId: 1, orderNo: "HS-2026-0001" })}>选择甲</button>
        <button onClick={() => setTarget({ orderId: 2, orderNo: "DG-2026-0002" })}>选择乙</button>
        <CashflowModal target={target} pools={pools} onClose={() => setTarget(null)} onCreated={onCreated} /></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "选择甲" }));
    const first = await modalOf(/资金收支 · HS-2026-0001/);
    fireEvent.change(within(first).getByLabelText("金额"), { target: { value: "100" } });
    fireEvent.change(within(first).getByLabelText("收支备注"), { target: { value: "第一单" } });
    await clickModalOk(first);
    await waitFor(() => expect(first).not.toBeVisible());
    await ui.click(screen.getByRole("button", { name: "选择乙" }));
    const second = await modalOf(/资金收支 · DG-2026-0002/);
    fireEvent.change(within(second).getByLabelText("金额"), { target: { value: "200" } });
    fireEvent.change(within(second).getByLabelText("收支备注"), { target: { value: "第二单" } });
    fireEvent.submit(within(second).getByLabelText("金额").closest("form")!);
    await waitFor(() => expect(orderCashflowsApi.create).toHaveBeenCalledWith(2, expect.objectContaining({ amount: "200" })));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ orderId: 1 }));
    await act(async () => finishReload());
  });

  it("资金收支已保存但刷新失败时，提示刷新而不误报保存失败", async () => {
    vi.mocked(orderCashflowsApi.create).mockResolvedValue({} as never);
    vi.spyOn(message, "warning").mockImplementation((() => undefined) as never);
    const pools: Pool[] = [{ id: 7, code: "HJ_INVEST", name: "投资款荷包", pool_type: "INVEST", status: "ACTIVE" }];
    renderLight(<CashflowModal target={{ orderId: 1, orderNo: "HS-2026-0001" }} pools={pools} onClose={() => undefined} onCreated={async () => { throw new Error("刷新失败"); }} />, { user: "admin" });
    const modal = await modalOf(/资金收支 · HS-2026-0001/);
    fireEvent.change(within(modal).getByLabelText("金额"), { target: { value: "100" } });
    fireEvent.change(within(modal).getByLabelText("收支备注"), { target: { value: "测试" } });
    await clickModalOk(modal);
    await waitFor(() => expect(message.warning).toHaveBeenCalledWith("资金收支已登记，但刷新失败，请手动刷新"));
    expect(message.error).not.toHaveBeenCalled();
  });

  it("资金收支登记期间显示进度并防止重复写入", async () => {
    vi.mocked(orderCashflowsApi.create).mockReturnValue(new Promise(() => {}));
    await openLedger();
    await openRowMenu("HS-2026-0001", "资金收支");
    const modal = await modalOf(/资金收支 · HS-2026-0001/);
    await waitFor(() => expect(within(modal).getByRole("combobox", { name: "操作人" }).closest(".ant-select")).toHaveTextContent("李四"));
    await ui.type(within(modal).getByLabelText("金额"), "500");
    await ui.type(within(modal).getByLabelText("收支备注"), "客户取消");
    const form = within(modal).getByLabelText("金额").closest("form")!;
    await act(async () => { fireEvent.submit(form); });
    await waitFor(() => expect(orderCashflowsApi.create).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.submit(form); });
    expect(orderCashflowsApi.create).toHaveBeenCalledTimes(1);
    expect(within(modal).getByRole("button", { name: /确定/ })).toHaveClass("ant-btn-loading");
  });

  it("较早的售出请求不能打断后来打开的其他订单操作", async () => {
    let finish!: (detail: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const slowDetail = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { finish = resolve; });
    vi.mocked(ordersApi.executionDetail).mockReturnValueOnce(slowDetail);
    vi.mocked(ordersApi.get).mockResolvedValue(order2);
    await openLedger();
    await openRowMenu("HS-2026-0001", "售出");
    await waitFor(() => expect(ordersApi.executionDetail).toHaveBeenCalledWith(1));
    await openRowMenu("DG-2026-0002", "资金收支");
    const modal = await modalOf(/资金收支 · DG-2026-0002/);
    fireEvent.change(within(modal).getByLabelText("金额"), { target: { value: "200" } });
    await act(async () => finish({ account: { id: 5, source_order_id: 1, inventory_type: "RECOVERY" }, orders: [] } as never));
    expect(modal).toBeVisible();
    expect(within(modal).getByLabelText("金额")).toHaveValue("200");
    expect(screen.queryByText("售出回收账号")).toBeNull();
  });

  it("较早的编辑请求不能在后来打开资金收支后展开旧订单", async () => {
    let finish!: (detail: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const slowDetail = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { finish = resolve; });
    vi.mocked(ordersApi.executionDetail).mockReturnValueOnce(slowDetail);
    vi.mocked(ordersApi.get).mockResolvedValue(order2);
    await openLedger();
    await openRowMenu("HS-2026-0001", "编辑");
    await waitFor(() => expect(ordersApi.executionDetail).toHaveBeenCalledWith(1, { fresh: true }));
    await openRowMenu("DG-2026-0002", "资金收支");
    const modal = await modalOf(/资金收支 · DG-2026-0002/);
    await act(async () => finish({
      account: { id: 5, source_order_id: 1, inventory_type: "RECOVERY", status: "WAITING" },
      orders: [{ order_id: 1, order_no: order1.order_no, order_type: "HS", events: [] }],
      detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] },
    } as never));
    expect(modal).toBeVisible();
    expect(screen.queryByText("保存修改")).toBeNull();
  });

  it("资金收支：退款已并入普通支出，登记为 OTHER 支出明细", async () => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([
      ...allFormFields(),
      {
        id: 9001, order_type_code: "REFUND", field_key: "receipt", label: "收支凭据",
        field_type: "TEXT", options: [], required: true, is_active: true, sort_order: 99,
        locked: false, is_custom: true, section: "EXTRA", note: null,
      },
    ] as never);
    await openLedger();
    await openRowMenu("HS-2026-0001", "资金收支");
    const modal = await modalOf(/资金收支 · HS-2026-0001/);
    expect(within(modal).queryByLabelText("发生日期")).toBeNull();
    await waitFor(() => expect(within(modal).getByRole("combobox", { name: "操作人" }).closest(".ant-select")).toHaveTextContent("李四"));
    await ui.type(within(modal).getByLabelText("金额"), "500");
    await ui.type(within(modal).getByLabelText("收支备注"), "客户取消");
    await ui.type(await within(modal).findByLabelText("收支凭据"), "凭据1");
    expect(within(modal).getByText("支出")).toBeInTheDocument();
    await clickModalOk(modal);
    await waitFor(() =>
      expect(orderCashflowsApi.create).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ direction: "OUT", amount: "500", category: "OTHER", occurred_on: today(), pool_id: expect.any(Number), form_extra: { receipt: "凭据1" } }),
      )
    );
    expect(vi.mocked(orderCashflowsApi.create).mock.calls[0][1]).toMatchObject({ operator_user_ids: [9] });
    expect(vi.mocked(orderCashflowsApi.create).mock.calls[0][1]).not.toHaveProperty("accounting_attribute");
    expect(message.success).toHaveBeenCalledWith("资金收支已登记");
  });

  it("资金收支：提交失败提示错误并关闭 loading", async () => {
    vi.mocked(orderCashflowsApi.create).mockRejectedValue(new Error("create fail"));
    await openLedger();
    await openRowMenu("HS-2026-0001", "资金收支");
    const modal = await modalOf(/资金收支 · HS-2026-0001/);
    await ui.type(within(modal).getByLabelText("金额"), "500");
    await ui.type(within(modal).getByLabelText("收支备注"), "客户取消");
    await clickModalOk(modal);
    await waitFor(() => expect(message.error).toHaveBeenCalledWith(expect.stringContaining("create fail")));
  });

  it("资金收支：资金流向可切换为收入并关联订单", async () => {
    await openLedger();
    await openRowMenu("HS-2026-0001", "资金收支");
    const modal = await modalOf(/资金收支 · HS-2026-0001/);
    const direction = within(modal).getByRole("combobox", { name: "资金流向" });
    expect(direction).not.toBeDisabled();
    await ui.click(direction);
    await ui.click(await screen.findByText("收入", { exact: true }));
    await ui.type(within(modal).getByLabelText("金额"), "100");
    await ui.type(within(modal).getByLabelText("收支备注"), "补登记收入");
    await clickModalOk(modal);
    await waitFor(() => expect(orderCashflowsApi.create).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ direction: "IN", amount: "100", category: "OTHER" }),
    ));
    expect(vi.mocked(orderCashflowsApi.create).mock.calls[0][1]).not.toHaveProperty("accounting_attribute");
  });

  it("订单台账不提供交付操作入口", async () => {
    await openLedger();
    expect(within(tableRow("HS-2026-0001")).queryByRole("button", { name: "交付" })).toBeNull();
  });

  it("运营：订单台账提供描述快捷入口并登记 DESCRIPTION 业务事件", async () => {
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: "运营" }));
    await ui.click(screen.getByRole("menuitem", { name: "描述" }));
    const descriptionInput = await screen.findByPlaceholderText("补充账号等级、资源、限制等信息");
    const modal = descriptionInput.closest(".ant-modal-content") as HTMLElement;
    await ui.type(descriptionInput, "台账补充描述");
    await ui.click(within(modal).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(ordersApi.updateExecution).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        profile: { account_description: "台账补充描述" },
        new_events: [expect.objectContaining({ operation_type: "DESCRIPTION", note: "订单台账登记描述" })],
      }),
    ));
    expect(ordersApi.postEvent).not.toHaveBeenCalled();
  });

  it("取消：存在买入流水时按实际金额取消入库", async () => {
    vi.mocked(ordersApi.get).mockResolvedValue({
      ...order1,
      events: [{ id: 101, event_no: "EV-101", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, cancellable_amount: "1000.00" }],
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消");
    const modal = await modalOf(/取消 · HS-2026-0001/);
    expect(within(modal).getByLabelText("退回金额")).toBeInTheDocument();
    await ui.type(screen.getByLabelText("取消原因"), "重复登记");
    await clickModalOk(modal);
    await waitFor(() =>
      expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ offset_event_id: 101, amount: "1000.00" }),
      )
    );
  });

  it("FE-252：取消依赖的资金账户加载完成后才允许确认", async () => {
    const cancelOrder = {
      ...order1,
      id: 21,
      order_no: "HS-CANCEL-ASYNC-01",
      trade_date: "2026-11-01",
    };
    let resolvePools!: (value: unknown[]) => void;
    const poolsPending = new Promise<unknown[]>((resolve) => {
      resolvePools = resolve;
    });

    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([cancelOrder]));
    vi.mocked(ordersApi.get).mockResolvedValue({
      ...cancelOrder,
      events: [{ id: 2101, order_id: 21, event_type: "BUY", event_no: "EV-CANCEL-ASYNC-01", amount: "100.00", occurred_on: "2026-11-01", pool_id: 7, is_posted: true, cancellable_amount: "100.00" }],
    });
    vi.mocked(poolsApi.list).mockImplementation(() => poolsPending as never);
    vi.mocked(employeesApi.list).mockResolvedValue([]);

    await openLedger();
    await openRowMenu("HS-CANCEL-ASYNC-01", "取消");
    expect(screen.queryByText(/取消 · HS-CANCEL-ASYNC-01/)).not.toBeInTheDocument();

    resolvePools([{ id: 7, code: "HJ_INVEST", name: "投资款荷包", status: "ACTIVE" }]);
    const modal = await modalOf(/取消 · HS-CANCEL-ASYNC-01/);
    await ui.type(within(modal).getByLabelText("取消原因"), "异步加载回归");
    await clickModalOk(modal);

    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(
      21,
      expect.objectContaining({ offset_event_id: 2101, pool_id: 7 }),
    ));
  });

  it("连续取消不同订单时，旧请求不能覆盖当前订单及退款金额", async () => {
    let finishFirst!: (pools: Pool[]) => void;
    const firstPools = new Promise<Pool[]>((resolve) => { finishFirst = resolve; });
    const secondOrder = { ...order1, id: 2, order_no: "HS-2026-0002", account_id: 6 };
    const detail = (order: Order, amount: string, eventId: number) => ({ ...order, events: [
      { id: eventId, event_no: `EV-${eventId}`, order_id: order.id, event_type: "BUY", amount, occurred_on: "2026-10-01", pool_id: 7, is_posted: true, cancellable_amount: amount },
    ] }) as Order;
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([order1, secondOrder]));
    vi.mocked(ordersApi.get).mockImplementation(async (id) => id === 1 ? detail(order1, "100.00", 101) : detail(secondOrder, "250.00", 202));
    await openLedger();
    const pools = [{ id: 7, code: "HJ_INVEST", name: "投资款荷包", pool_type: "INVEST", status: "ACTIVE" }] as Pool[];
    vi.mocked(poolsApi.list).mockReturnValueOnce(firstPools).mockResolvedValue(pools);
    await openRowMenu("HS-2026-0001", "取消");
    await waitFor(() => expect(poolsApi.list).toHaveBeenCalled());
    await openRowMenu("HS-2026-0002", "取消");
    const modal = await modalOf(/取消 · HS-2026-0002/);
    expect(within(modal).getByLabelText("退回金额")).toHaveValue("250.00");
    fireEvent.change(within(modal).getByLabelText("取消原因"), { target: { value: "第二单" } });
    await act(async () => finishFirst(pools));
    expect(modal).toBeVisible();
    expect(within(modal).getByLabelText("退回金额")).toHaveValue("250.00");
    expect(within(modal).getByLabelText("取消原因")).toHaveValue("第二单");
    await clickModalOk(modal);
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(2, expect.objectContaining({ amount: "250.00", offset_event_id: 202, reason: "第二单" })));
  });

  it("取消交易提交中重复确认只发送一次", async () => {
    let finish!: (value: Awaited<ReturnType<typeof ordersApi.inventoryOffsale>>) => void;
    vi.mocked(ordersApi.inventoryOffsale).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(ordersApi.get).mockResolvedValue({ ...order1, events: [] });
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消");
    const modal = await modalOf(/取消 · HS-2026-0001/);
    fireEvent.change(within(modal).getByLabelText("取消原因"), { target: { value: "取消交易" } });
    const form = within(modal).getByLabelText("取消原因").closest("form")!;
    await act(async () => { fireEvent.submit(form); });
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.submit(form); });
    expect(ordersApi.inventoryOffsale).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    await waitFor(() => expect(modal).not.toBeVisible());
  });

  it("订单删除提交中重复确认只发送一次", async () => {
    let finish!: () => void;
    let finishLabels!: (labels: Record<string, string>) => void;
    let finishFields!: (fields: ReturnType<typeof allFormFields>) => void;
    const labelsReady = new Promise<Record<string, string>>((resolve) => { finishLabels = resolve; });
    const fieldsReady = new Promise<ReturnType<typeof allFormFields>>((resolve) => { finishFields = resolve; });
    vi.mocked(orderFormFieldsApi.listSectionLabels).mockImplementation((scope) => scope === "ORDDELETE" ? labelsReady : Promise.resolve({}));
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => scope === "ORDDELETE" ? fieldsReady : allFormFields().filter((field) => field.order_type_code === scope));
    vi.mocked(ordersApi.deleteOrder).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await openLedger();
    await openRowMenu("HS-2026-0001", "删除");
    const modal = await screen.findByRole("dialog", { name: "删除" });
    await waitFor(() => expect(orderFormFieldsApi.list).toHaveBeenCalledWith("ORDDELETE", true));
    fireEvent.change(within(modal).getByLabelText("删除原因"), { target: { value: "删除测试" } });
    const form = within(modal).getByLabelText("删除原因").closest("form")!;
    await act(async () => { fireEvent.submit(form); });
    expect(ordersApi.deleteOrder).not.toHaveBeenCalled();
    await act(async () => { finishFields([]); finishLabels({}); await Promise.all([fieldsReady, labelsReady]); });
    await waitFor(() => expect(within(modal).queryByText("正在加载字段配置…")).not.toBeInTheDocument());
    await act(async () => { fireEvent.submit(form); });
    await waitFor(() => expect(ordersApi.deleteOrder).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.submit(form); });
    expect(ordersApi.deleteOrder).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除" })).not.toBeInTheDocument());
  });

  it("上一笔取消成功后不关闭新订单的取消弹窗", async () => {
    let finish!: (value: Awaited<ReturnType<typeof ordersApi.inventoryOffsale>>) => void;
    vi.mocked(ordersApi.inventoryOffsale).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const secondOrder = { ...order1, id: 2, order_no: "HS-2026-0002", account_id: 6 };
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([order1, secondOrder]));
    vi.mocked(ordersApi.get).mockImplementation(async (id) => ({ ...(id === 1 ? order1 : secondOrder), events: [] }));
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消");
    const first = await modalOf(/取消 · HS-2026-0001/);
    fireEvent.change(within(first).getByLabelText("取消原因"), { target: { value: "第一单" } });
    await clickModalOk(first);
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(first).not.toBeVisible());
    await openRowMenu("HS-2026-0002", "取消");
    const second = await modalOf(/取消 · HS-2026-0002/);
    fireEvent.change(within(second).getByLabelText("取消原因"), { target: { value: "第二单" } });
    await act(async () => finish({ ok: true }));
    expect(second).toBeVisible();
    expect(within(second).getByLabelText("取消原因")).toHaveValue("第二单");
  });

  it("取消已提交后不等待台账刷新即可关闭弹窗", async () => {
    let finishReload!: (value: Awaited<ReturnType<typeof ordersApi.listPage>>) => void;
    const reload = new Promise<Awaited<ReturnType<typeof ordersApi.listPage>>>((resolve) => { finishReload = resolve; });
    vi.mocked(ordersApi.get).mockResolvedValue({ ...order1, events: [] });
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消");
    const modal = await modalOf(/取消 · HS-2026-0001/);
    fireEvent.change(within(modal).getByLabelText("取消原因"), { target: { value: "取消交易" } });
    vi.mocked(ordersApi.listPage).mockReturnValueOnce(reload);
    await clickModalOk(modal);
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(modal).not.toBeVisible());
    await act(async () => finishReload(pageResponse(orders)));
  });

  it("取消：冲销入库流水并进入公司钱包", async () => {
    vi.mocked(ordersApi.get).mockResolvedValue({
      ...order1,
      events: [{ id: 101, event_no: "EV-101", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", pool_id: 7, is_posted: true, cancellable_amount: "1000.00" }],
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消");
    const modal = await modalOf(/取消 · HS-2026-0001/);
    expect(within(modal).getByLabelText("退回金额")).toBeInTheDocument();
    expect(within(modal).getByLabelText("收款账户")).toBeInTheDocument();
    await ui.click(within(modal).getByLabelText("收款账户"));
    await ui.click((await screen.findAllByText("投资款荷包"))[1]);
    await ui.type(within(modal).getByLabelText("取消原因"), "对方退款");
    await clickModalOk(modal);
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ pool_id: 7, operator_user_ids: expect.arrayContaining([expect.any(Number)]) }),
    ));
  });

  it("未售出订单无买入流水时可零退款取消", async () => {
    vi.mocked(ordersApi.get).mockResolvedValue({ ...order1, events: [] });
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消");
    const modal = await modalOf(/取消 · HS-2026-0001/);
    expect(within(modal).getByLabelText("退回金额")).toHaveValue("0.00");
    await ui.type(within(modal).getByLabelText("取消原因"), "取消交易");
    await clickModalOk(modal);
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(1, expect.objectContaining({ amount: "0.00", reason: "取消交易" })));
  });

  it("订单入口取消入库展示所有板块字段并过滤空值", async () => {
    const fields = [...allFormFields(),
      { id: 901, order_type_code: "INVREFUND", field_key: "receipt", label: "取消凭据", field_type: "TEXT",
        required: true, is_active: true, sort_order: 1, locked: false, is_custom: true, section: "FINANCE" },
      { id: 902, order_type_code: "INVREFUND", field_key: "optional_number", label: "可选数字", field_type: "NUMBER",
        required: false, is_active: true, sort_order: 2, locked: false, is_custom: true, section: "BUSINESS" },
    ];
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => fields.filter((field) => field.order_type_code === scope));
    vi.mocked(ordersApi.get).mockResolvedValue({ ...order1, events: [] });
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消");
    const modal = await modalOf(/取消 · HS-2026-0001/);
    await ui.type(within(modal).getByLabelText("取消原因"), "取消交易");
    await ui.type(await within(modal).findByLabelText("取消凭据"), "凭据A");
    const optional = within(modal).getByLabelText("可选数字");
    await ui.type(optional, "17");
    await ui.clear(optional);
    await clickModalOk(modal);
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(1,
      expect.objectContaining({ amount: "0.00", form_extra: { receipt: "凭据A" } })));
  });

  it("取消：按售出流水做部分退款冲销", async () => {
    vi.mocked(ordersApi.get).mockResolvedValue({
      ...order1,
      events: [
        { id: 101, event_no: "EV-101", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, cancellable_amount: "1000.00" },
        { id: 102, event_no: "EV-102", order_id: 1, event_type: "SELL", amount: "500.00", occurred_on: "2026-10-02", is_posted: true, cancellable_amount: "500.00" },
      ],
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消");
    const modal = await modalOf(/取消 · HS-2026-0001/);
    expect(within(modal).getByLabelText("退款金额")).toBeInTheDocument();
    expect(within(modal).getByLabelText("付款账户")).toBeInTheDocument();
    expect(within(modal).queryByLabelText("售出流水")).toBeNull();
    // 售出取消复用统一冲销弹窗，来源 SELL 流水已由页面内部选定。
    expect(within(modal).getByText(/将冲销来源订单的售出流水（¥500.00）/)).toBeInTheDocument();
    // 部分退款：300 < 售出流水剩余 500。
    await ui.clear(within(modal).getByLabelText("退款金额"));
    await ui.type(within(modal).getByLabelText("退款金额"), "300");
    await ui.type(screen.getByLabelText("取消原因"), "部分冲销");
    await clickModalOk(modal);
    await waitFor(() =>
      expect(ordersApi.postEvent).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ event_type: "CANCEL", finalize_sale_cancel: true, offset_event_id: 102, amount: "300", form_extra_scope: "ORDERCANC" }),
      )
    );
  });

  it("取消：分期订单按合约取消并提示退款金额", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([order3]));
    vi.mocked(ordersApi.get).mockResolvedValue(order3);
    await openLedger();
    await openRowMenu("HS-2026-0003", "取消");
    const modal = await modalOf(/取消 · INS-1/);
    await ui.type(screen.getByLabelText("取消原因"), "提前结清");
    fireEvent.click(screen.getByRole("button", { name: /确认取消/ }));
    await waitFor(() => expect(installmentsApi.cancel).toHaveBeenCalledWith(11, expect.objectContaining({ reason: "提前结清" }), "ORDER"));
    // money() 走千分位格式化
    expect(message.success).toHaveBeenCalledWith(expect.stringContaining("退款已登记：¥3,000.00"));
  });

  it("取消分期订单时继续查找后续页的有效合约", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([order3]));
    vi.mocked(ordersApi.get).mockResolvedValue(order3);
    const history = Array.from({ length: 500 }, (_, id) => ({ ...installment, id: 1000 + id, status: "CANCELLED" }));
    vi.mocked(installmentsApi.page)
      .mockResolvedValueOnce(pageResponse(history, { total: 501, limit: 500, offset: 0 }) as never)
      .mockResolvedValueOnce(pageResponse([installment], { total: 501, limit: 500, offset: 500 }) as never);
    await openLedger();
    await openRowMenu("HS-2026-0003", "取消");
    expect(await modalOf(/取消 · INS-1/)).toBeVisible();
    expect(installmentsApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ order_id: 3, limit: 500, offset: 500 }));
  });

  it("取消分期订单遇到不完整分页时提示重试", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([order3]));
    vi.mocked(ordersApi.get).mockResolvedValue(order3);
    vi.mocked(installmentsApi.page).mockResolvedValueOnce(pageResponse([], { total: 1, limit: 500, offset: 0 }));
    await openLedger();
    await openRowMenu("HS-2026-0003", "取消");
    await waitFor(() => expect(message.error).toHaveBeenCalledWith("分期合约读取不完整，请重试"));
    expect(screen.queryByRole("dialog", { name: /取消 · INS-1/ })).toBeNull();
  });

  it("订单入口取消分期提交所有板块字段并过滤空值", async () => {
    const fields = [...allFormFields(),
      { id: 901, order_type_code: "INVCANCEL", field_key: "receipt", label: "取消凭据", field_type: "TEXT",
        required: true, is_active: true, sort_order: 1, locked: false, is_custom: true, section: "FINANCE" },
      { id: 902, order_type_code: "INVCANCEL", field_key: "optional_number", label: "可选数字", field_type: "NUMBER",
        required: false, is_active: true, sort_order: 2, locked: false, is_custom: true, section: "BUSINESS" },
    ];
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => fields.filter((field) => field.order_type_code === scope));
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([order3]));
    vi.mocked(ordersApi.get).mockResolvedValue(order3);
    await openLedger();
    await openRowMenu("HS-2026-0003", "取消");
    const modal = await modalOf(/取消 · INS-1/);
    await ui.type(within(modal).getByLabelText("取消原因"), "客户取消");
    await ui.type(await within(modal).findByLabelText("取消凭据"), "凭据A");
    const optional = within(modal).getByLabelText("可选数字");
    await ui.type(optional, "17");
    await ui.clear(optional);
    await clickModalOk(modal);
    await waitFor(() => expect(installmentsApi.cancel).toHaveBeenCalledWith(11,
      expect.objectContaining({ reason: "客户取消", form_extra: { receipt: "凭据A" } }), "ORDER"));
  });

  it("取消：分期订单无可用合约时提示", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([order3]));
    vi.mocked(ordersApi.get).mockResolvedValue(order3);
    installmentListFixture.mockResolvedValue([{ ...installment, status: "CANCELLED" }]);
    await openLedger();
    await openRowMenu("HS-2026-0003", "取消");
    await waitFor(() => expect(message.error).toHaveBeenCalledWith("未找到可取消的分期合约"));
  });

  it("取消：打开详情失败时提示错误", async () => {
    vi.mocked(ordersApi.get).mockRejectedValue(new Error("detail fail"));
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消");
    await waitFor(() => expect(message.error).toHaveBeenCalledWith(expect.stringContaining("detail fail")));
  });

  // 原三条（弹窗开关 / P2-190 菜单收起 / 成功后刷新列表）同一入口同一夹具，合并为一次挂载。
  it("新建订单：菜单收起、弹窗开关与成功后刷新列表", async () => {
    await openLedger();
    const before = vi.mocked(ordersApi.listPage).mock.calls.length;
    const trigger = screen.getByRole("button", { name: /新建订单/ });

    await ui.click(trigger);
    expect(await screen.findByText("新建提号订单")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("新建回收订单"));
    expect(await screen.findByTestId("create-stub")).toBeInTheDocument();
    // P2-190：受控下拉，选中后弹层真正卸载，不会浮在弹窗上方
    await waitFor(() => expect(screen.queryByText("新建提号订单")).toBeNull());
    await waitFor(() => expect(trigger).not.toHaveAttribute("aria-expanded", "true"));

    // 关闭回调清空
    await ui.click(screen.getByRole("button", { name: /关闭新建弹窗/ }));
    await waitFor(() => expect(screen.queryByTestId("create-stub")).toBeNull());

    // 再走一次并模拟新建成功 → 列表刷新
    await ui.click(trigger);
    fireEvent.click(await screen.findByText("新建回收订单"));
    await screen.findByTestId("create-stub");
    await ui.click(screen.getByRole("button", { name: /模拟新建成功/ }));
    await waitFor(() => expect(screen.queryByTestId("create-stub")).toBeNull());
    expect(vi.mocked(ordersApi.listPage).mock.calls.length).toBeGreaterThan(before);
  });

});
