import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { renderLight } from "@fixtures/render";
import { OrdersPage } from "@/orders/OrdersPage";
import { pickCancelableEvent, resolveCancelAmount } from "@/orders/orderpage/helpers";

import { cashflowsApi } from "@/shared/api/cashflows.api";
import { orderCashflowsApi } from "@/shared/api/orderCashflows.api";
import { installmentsApi } from "@/shared/api/installments.api";
import { orderFormFieldsApi, orderTypesApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { policyApi } from "@/shared/api/policy.api";
import { poolsApi } from "@/shared/api/pools.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { allFormFields, seedOptionSets, seedOrderFormFields } from "@fixtures/formFieldsSeed";
import { today } from "@/shared/lib/format";
import * as client from "@/shared/api/client";
import type { Installment, InstallmentCancelResult } from "@/shared/api/types/installments";
import type { OrderLink } from "@/shared/api/types/order-events";
import type { Order } from "@/shared/api/types/orders";
import type { ProfitAllocation } from "@/shared/api/types/policy";

let ui: ReturnType<typeof userEvent.setup>;

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/orderCashflows.api");
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

// openAllocations 会调用 api.get("/users") 拉取收益人；normalizeError 必须保留真实实现。
vi.mock("@/shared/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/client")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
    currentUser: vi.fn(),
  };
});
// 这两行曾写作 "../../stocks/InventoryPanel"、"../../installments/InstallmentsPanel"，
// 从 src/orders/ 解析到根本不存在的 frontend/stocks/，mock 从未命中——测试一直在渲染真面板，
// 且断言恰恰依赖真面板（切到「分期与回款」会真发请求）。2026-11-04 修正路径后立刻红了，
// 说明修 mock 不等于修意图：本文件要测的是 OrdersPage 的编排，面板保持真实渲染。
// 需要桩掉面板时请在同一文件内同步改断言，不要只改说明符。

// CreateBusinessModal 用桩替换：暴露 open/onClose/onCreated 三个口，用于覆盖回调分支。
vi.mock("@/orders/CreateBusinessModal", () => ({
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
  capital_type: "SELF",
  trade_date: "2026-10-01",
  status: "ACTIVE",
  business_mode: "SELF",
  account_game_type: "原神",
  account_game_account: "seller-001",
  account_platform: "安卓",
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
  capital_type: "ZERO",
  trade_date: "2026-10-02",
  status: "COMPLETED",
  business_mode: "DISTRIBUTION",
};
const order3: Order = {
  id: 3,
  order_no: "HS-2026-0003",
  order_type: "HS",
  capital_type: "CREDIT",
  trade_date: "2026-10-03",
  status: "ACTIVE",
  sale_amount: "12000.00",
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
  total_receivable: "12000.00",
  remaining_receivable: "12000.00",
  status: "ACTIVE",
  order: {
    id: 3,
    order_no: "HS-2026-0003",
    order_type: "HS",
    trade_date: "2026-10-03",
  },
  schedules: [],
  dispositions: [],
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
  vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(ordersApi.listPage).mockResolvedValue({ items: orders, total: orders.length, limit: 10, offset: 0 });
  vi.mocked(ordersApi.list).mockResolvedValue([]);
  vi.mocked(ordersApi.ledgerSummary).mockResolvedValue({
    total_count: orders.length,
    status_counts: { ACTIVE: 1, COMPLETED: 1, CANCELLED: 0 },
    type_counts: { HS: 1, DG: 1 },
    game_types: ["原神"],
  });
  vi.mocked(orderTypesApi.list).mockResolvedValue(types);
  vi.mocked(poolsApi.list).mockResolvedValue([
    { id: 7, code: "HJ_INVEST", name: "投资款荷包", pool_type: "INVEST", ownership: "OWNED", status: "ACTIVE" },
  ]);
  // 下架弹窗背后会渲染库存上下文，卡片指标走这个接口；不桩会真调 api.get 返回 undefined。
  vi.mocked(stocksApi.inventoryStats).mockResolvedValue({ account_count: 0, occupied_cost: "0.00", over_7d_count: 0, over_30d_count: 0 });
  vi.mocked(ordersApi.get).mockResolvedValue(order1);
  vi.mocked(ordersApi.executionDetail).mockResolvedValue({
    account: { id: order1.account_id, stock_no: "KU_00001", game_account: "seller-001", game_type: "原神", status: "WAITING", inventory_type: "RECOVERY" },
    orders: [{ order_id: order1.id, order_no: order1.order_no, order_type: order1.order_type, trade_date: order1.trade_date, status: order1.status, events: [] }],
    finance_summary: { total_income: "0", total_expense: "0", net_profit: "0" },
  } as never);
  vi.mocked(ordersApi.links).mockResolvedValue([link1]);
  vi.mocked(ordersApi.deleteLink).mockResolvedValue(undefined);
  vi.mocked(ordersApi.cancel).mockResolvedValue({ ...order1, status: "CANCELLED" });
  vi.mocked(ordersApi.postEvent).mockResolvedValue({
    event: { id: 2, event_no: "EV-2", order_id: 1, event_type: "CANCEL", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, cancellable_amount: "0.00" },
    installment: { id: 11, inst_no: "INS-1", status: "CANCELLED" },
    cash_flows: [],
    warnings: [],
  } as never);
  vi.mocked(policyApi.allocations).mockResolvedValue({
    items: allocationRows,
    total: allocationRows.length,
    order_profit: "5000.00",
    totals_by_type: {},
  });
  vi.mocked(policyApi.setAllocations).mockResolvedValue({
    items: allocationRows,
    total: allocationRows.length,
    order_profit: "5000.00",
    totals_by_type: {},
  });
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 9, username: "lisi", display_name: "李四", is_active: true },
    { id: 11, username: "recovery", display_name: "回收员", is_active: true },
    { id: 22, username: "seller", display_name: "售出员", is_active: true },
    { id: 33, username: "operator", display_name: "运营员", is_active: true },
  ]);
  vi.mocked(installmentsApi.list).mockResolvedValue([installment]);
  vi.mocked(installmentsApi.cancel).mockResolvedValue(installmentCancelResult);
  vi.mocked(client.currentUser).mockResolvedValue({ id: 9, username: "lisi", role: "operator", display_name: "李四" });
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
});

async function openLedger(user = "admin") {
  renderLight(<OrdersPage />, { user });
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
  it("分期订单展示售出金额而不是买入金额合计", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue({ items: [order3], total: 1, limit: 10, offset: 0 });
    await openLedger();
    expect(screen.getAllByText("¥12,000.00").length).toBeGreaterThan(0);
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
    vi.mocked(installmentsApi.list).mockResolvedValue([]);
    await openLedger();
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));
    await waitFor(() => expect(installmentsApi.list).toHaveBeenCalled());
    // 首次切入只靠挂载 load，不自增 refreshKey（避免双请求）
    expect(vi.mocked(installmentsApi.list)).toHaveBeenCalledTimes(1);
    const callsAfterFirstEntry = vi.mocked(installmentsApi.list).mock.calls.length;

    fireEvent.click(screen.getByRole("tab", { name: "订单台账" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "订单台账" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));

    await waitFor(() =>
      expect(vi.mocked(installmentsApi.list).mock.calls.length).toBeGreaterThan(callsAfterFirstEntry),
    );
  });

  // 原两条（有新增 / 无新增）是同一条「标记逾期」路径的两个分支，合并为一次挂载逐次点击。
  it("标记逾期：有新增提示笔数并刷新列表，无新增提示当前无新增", async () => {
    vi.mocked(installmentsApi.list).mockResolvedValue([]);
    vi.mocked(installmentsApi.markOverdue).mockResolvedValue({ marked: 3 });
    await openLedger();
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));
    await waitFor(() => expect(installmentsApi.list).toHaveBeenCalled());
    const callsBefore = vi.mocked(installmentsApi.list).mock.calls.length;

    await ui.click(screen.getByRole("button", { name: /标记逾期/ }));

    await waitFor(() => expect(installmentsApi.markOverdue).toHaveBeenCalled());
    expect(message.success).toHaveBeenCalledWith("已标记 3 笔逾期");
    // installmentRefreshKey 自增 → 分期面板重新 load
    await waitFor(() => expect(screen.getByRole("tab", { name: "分期与回款" })).toBeInTheDocument());
    expect(vi.mocked(installmentsApi.list).mock.calls.length).toBeGreaterThan(callsBefore);

    // 分支二：本次标记 0 笔
    vi.mocked(installmentsApi.markOverdue).mockResolvedValue({ marked: 0 });
    await ui.click(screen.getByRole("button", { name: /标记逾期/ }));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith("当前无新增逾期合约"));
  });

  it("编辑订单：行操作列直接打开详情编辑", async () => {
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("button", { name: "保存修改" })).toBeInTheDocument();
    expect(screen.queryByLabelText("编辑游戏账号/产品")).toBeNull();
    expect(screen.getByRole("button", { name: "保存修改" })).toBeInTheDocument();
  });

  it("订单台账：编辑账号不作为独立操作，统一只展示编辑", async () => {
    await openLedger();
    const row = tableRow("HS-2026-0001");
    expect(within(row).getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "编辑账号" })).toBeNull();
  });

  it("编辑有登记事件订单：统一编辑入口仍可打开库存详情", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue({ items: [
      {
        ...order1,
        events: [{ id: 1, event_no: "EV-1", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, cancellable_amount: "1000.00" }],
      },
    ], total: 1, limit: 10, offset: 0 });
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("button", { name: "保存修改" })).toBeInTheDocument();
    expect(screen.queryByLabelText("编辑游戏账号/产品")).toBeNull();
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

  it("分润：无存量时按操作四项展开，买号/售出自动绑定动作执行人", async () => {
    // 空分润 → 按操作口径起步：买号、售出、运营、公司四项固定展开。
    vi.mocked(policyApi.allocations).mockResolvedValue({
      items: [],
      total: 0,
      order_profit: "5000.00",
      totals_by_type: {},
    });
    vi.mocked(ordersApi.get).mockResolvedValue({
      ...order1,
      form_extra: {
        business_responsible_ids: [11],
        delivery_responsible_ids: [22],
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
    expect(within(modal).getAllByLabelText("比例")).toHaveLength(4);
    for (const label of ["买号", "售出", "运营", "公司"]) {
      expect(within(modal).getByText(label)).toBeInTheDocument();
    }
    // 买号取建单负责人，售出取卖出表单负责人，运营取运营信息中的动作负责人，均自动带出。
    expect(within(modal).getByText("回收员")).toBeInTheDocument();
    expect(within(modal).getByText("售出员")).toBeInTheDocument();
    expect(within(modal).getByText("运营员")).toBeInTheDocument();
  });
  it("分润：一个动作多人时提交动作合计，均分由后端处理", async () => {
    // 前端只提交动作合计和人员名单；按人数均分由后端保存服务统一处理。
    vi.mocked(policyApi.allocations).mockResolvedValue({
      items: [],
      total: 0,
      order_profit: "5000.00",
      totals_by_type: {},
    });
    vi.mocked(ordersApi.get).mockResolvedValue({
      ...order1,
      form_extra: {
        business_responsible_ids: [11, 22],
        delivery_responsible_ids: [22],
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

    // 买号两人只占一行，人员多选后填写动作合计。
    expect(within(modal).getByText("买号")).toBeInTheDocument();
    const rates = within(modal).getAllByLabelText("比例");
    expect(rates).toHaveLength(4);
    fireEvent.change(rates[0], { target: { value: "30" } });

    // 售出 40、运营 20、公司 10，四项合计 100
    fireEvent.change(rates[1], { target: { value: "40" } });
    fireEvent.change(rates[2], { target: { value: "20" } });
    fireEvent.change(rates[3], { target: { value: "10" } });

    await clickModalOk(modal);
    await waitFor(() => expect(policyApi.setAllocations).toHaveBeenCalled());
    const [, payload] = vi.mocked(policyApi.setAllocations).mock.calls[0];
    const buyRows = payload.filter((item) => item.allocation_type === "BUY");
    expect(buyRows).toEqual([{ allocation_type: "BUY", employee_ids: [11, 22], role: "BUYER", allocation_rate: "30", allocation_amount: null }]);
    expect(payload).toHaveLength(4);
  });

  it("分润：按操作四项提交时带上 allocation_type 与比例", async () => {
    vi.mocked(policyApi.allocations).mockResolvedValue({
      items: actionAllocationRows,
      total: actionAllocationRows.length,
      order_profit: "5000.00",
      totals_by_type: {},
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润配置");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    expect(within(modal).getAllByLabelText("比例")).toHaveLength(4);
    await clickModalOk(modal);
    await waitFor(() => expect(policyApi.setAllocations).toHaveBeenCalled());
    const [, payload] = vi.mocked(policyApi.setAllocations).mock.calls[0];
    expect(payload).toHaveLength(4);
    expect(payload.map((item) => item.allocation_type)).toEqual(["BUY", "SELL", "OPERATION", "COMPANY"]);
    expect(payload.find((item) => item.allocation_type === "OPERATION")).toMatchObject({ employee_ids: [9], role: "SERVICE" });
  });

  it("资金收支：退款已并入普通支出，登记为 OTHER 支出明细", async () => {
    await openLedger();
    await openRowMenu("HS-2026-0001", "资金收支");
    const modal = await modalOf(/资金收支 · HS-2026-0001/);
    await ui.type(within(modal).getByLabelText("金额"), "500");
    await ui.type(within(modal).getByLabelText("收支备注"), "客户取消");
    expect(within(modal).getByText("支出")).toBeInTheDocument();
    await clickModalOk(modal);
    await waitFor(() =>
      expect(orderCashflowsApi.create).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ direction: "OUT", amount: "500", category: "OTHER", pool_id: expect.any(Number) }),
      )
    );
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
  });

  it("订单台账不提供交付操作入口", async () => {
    await openLedger();
    expect(within(tableRow("HS-2026-0001")).queryByRole("button", { name: "交付" })).toBeNull();
  });

  it("运营：订单台账提供描述快捷入口并登记 DESCRIPTION 业务事件", async () => {
    vi.mocked(stocksApi.updateProfile).mockResolvedValueOnce({
      id: 5, source_order_id: 1, source_order_no: "HS-2026-0001", game_account: "seller-001", status: "WAITING", cost_amount: "100.00",
    } as never);
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: "运营" }));
    await ui.click(screen.getByRole("menuitem", { name: "描述" }));
    const descriptionInput = await screen.findByPlaceholderText("补充账号等级、资源、限制等信息");
    const modal = descriptionInput.closest(".ant-modal-content") as HTMLElement;
    await ui.type(descriptionInput, "台账补充描述");
    await ui.click(within(modal).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ event_type: "OPERATE", operation_type: "DESCRIPTION" }),
    ));
  });

  it("取消：存在可冲销已登记动作时发起 CANCEL 冲销", async () => {
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
      expect(ordersApi.postEvent).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ event_type: "CANCEL", offset_event_id: 101, form_extra_scope: "INVREFUND" }),
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

    vi.mocked(ordersApi.listPage).mockResolvedValue({ items: [cancelOrder], total: 1, limit: 10, offset: 0 });
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

    await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledWith(
      21,
      expect.objectContaining({ event_type: "CANCEL", offset_event_id: 2101, pool_id: 7 }),
    ));
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
    await ui.click((await screen.findAllByText("投资款荷包（HJ_INVEST）"))[1]);
    await ui.type(within(modal).getByLabelText("取消原因"), "对方退款");
    await clickModalOk(modal);
    await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ event_type: "CANCEL", pool_id: 7, form_extra_scope: "INVREFUND", operator_user_ids: expect.arrayContaining([expect.any(Number)]) }),
    ));
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
        expect.objectContaining({ event_type: "CANCEL", offset_event_id: 102, amount: "300", form_extra_scope: "ORDERCANC" }),
      )
    );
  });

  it("取消：分期订单按合约取消并提示退款金额", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue({ items: [order3], total: 1, limit: 10, offset: 0 });
    vi.mocked(ordersApi.get).mockResolvedValue(order3);
    await openLedger();
    await openRowMenu("HS-2026-0003", "取消");
    const modal = await modalOf(/取消 · INS-1/);
    await ui.type(screen.getByLabelText("取消原因"), "提前结清");
    fireEvent.click(screen.getByRole("button", { name: /确认取消/ }));
    await waitFor(() => expect(installmentsApi.cancel).toHaveBeenCalledWith(11, expect.objectContaining({ reason: "提前结清" })));
    // money() 走千分位格式化
    expect(message.success).toHaveBeenCalledWith(expect.stringContaining("退款已登记：¥3,000.00"));
  });

  it("取消：分期订单无可用合约时提示", async () => {
    vi.mocked(ordersApi.listPage).mockResolvedValue({ items: [order3], total: 1, limit: 10, offset: 0 });
    vi.mocked(ordersApi.get).mockResolvedValue(order3);
    vi.mocked(installmentsApi.list).mockResolvedValue([{ ...installment, status: "CANCELLED" }]);
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

describe("resolveCancelAmount / pickCancelableEvent 纯函数", () => {
  const remaining = "500.00";

  it("留空 → 全额冲销，取后端剩余可冲金额", () => {
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: {}, remaining })).toEqual({ ok: true, amount: "500.00" });
    expect(resolveCancelAmount({ scope: "INVREFUND", values: { refund_amount: "" }, remaining })).toEqual({ ok: true, amount: "500.00" });
  });

  it("部分冲销：填小于剩余的金额按填的值提交", () => {
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: "300" }, remaining }))
      .toEqual({ ok: true, amount: "300" });
  });

  it("超过剩余可冲金额 → 拒绝，提示带上剩余金额", () => {
    const r = resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: "500.01" }, remaining });
    expect(r).toEqual({ ok: false, error: "冲销金额不能超过该动作剩余可冲金额 ¥500.00" });
  });

  it("恰好等于剩余金额 → 放行（边界不因浮点误差误拒）", () => {
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: "500.00" }, remaining }))
      .toEqual({ ok: true, amount: "500.00" });
  });

  it("非数字 / 0 / 负数 → 拒绝为无效金额", () => {
    for (const bad of ["abc", "0", "-1", " "]) {
      const r = resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: bad }, remaining });
      // 纯空格会被 trim 成空串 → 按全额处理，属"留空"语义
      if (bad === " ") expect(r).toEqual({ ok: true, amount: "500.00" });
      else expect(r).toEqual({ ok: false, error: "请输入有效的冲销金额" });
    }
  });

  it("两种 scope 读各自的金额字段，互不串用", () => {
    // 冲销入库（INVREFUND）读 refund_amount；订单退款（ORDERCANC）读 cancel_amount
    expect(resolveCancelAmount({ scope: "INVREFUND", values: { refund_amount: "120", cancel_amount: "999" }, remaining }))
      .toEqual({ ok: true, amount: "120" });
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { refund_amount: "999", cancel_amount: "120" }, remaining }))
      .toEqual({ ok: true, amount: "120" });
  });

  it("pickCancelableEvent：显式选择优先，未选时取第一条", () => {
    const list = [
      { event: { id: 102 }, remaining: "500.00" },
      { event: { id: 101 }, remaining: "1000.00" },
    ];
    expect(pickCancelableEvent(list, 101)?.event.id).toBe(101);
    expect(pickCancelableEvent(list, undefined)?.event.id).toBe(102);
    // 表单值可能是字符串
    expect(pickCancelableEvent(list, "101")?.event.id).toBe(101);
    // 不存在的 id → 回落到第一条，而不是抛错
    expect(pickCancelableEvent(list, 999)?.event.id).toBe(102);
    expect(pickCancelableEvent([], 101)).toBeUndefined();
  });
});
