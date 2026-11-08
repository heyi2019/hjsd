/** OrdersPage 业务动作测试套件的共享夹具与注册函数。 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { renderLight } from "@fixtures/render";
import { OrdersPage, validateAllocations } from "@/orders/OrdersPage";

import * as catalog from "@/shared/api/catalog";
import { seedOptionSets, seedOrderFormFields } from "@fixtures/formFieldsSeed";
import { today } from "@/shared/lib/format";
import * as client from "@/shared/api/client";
import type { Installment, InstallmentCancelResult, Order, OrderLink, ProfitAllocation } from "@/shared/api/catalog";

let ui: ReturnType<typeof userEvent.setup>;

vi.mock("@/shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/catalog")>();
  const METHODS = [
    "list", "get", "create", "update", "patch", "post", "postEvent", "cancel", "remove",
    "setStatus", "setActive", "resolve", "release", "settle", "approve", "reject",
    "reverse", "close", "convert", "detail", "allocations", "setAllocations",
    "balance", "executionDetail", "inventoryStats", "updateProfile", "updateExecution", "merge", "search",
    "orderSnapshot", "links", "createLink", "deleteLink", "listSectionLabels", "saveSectionLabels",
    "markOverdue",
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
  trade_date: "2026-10-01",
  status: "ACTIVE",
  business_mode: "SELF",
  account_game_type: "原神",
  account_game_account: "seller-001",
  account_platform: "安卓",
  account_status: "WAITING",
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
  seedOptionSets(catalog);
  seedOrderFormFields(catalog);
  vi.mocked(catalog.orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(catalog.ordersApi.list).mockResolvedValue(orders);
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(types);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue([
    { id: 7, code: "HJ_INVEST", name: "投资款荷包", pool_type: "INVEST", ownership: "OWNED", status: "ACTIVE" },
  ]);
  // 下架弹窗背后会渲染库存上下文，卡片指标走这个接口；不桩会真调 api.get 返回 undefined。
  vi.mocked(catalog.stocksApi.inventoryStats).mockResolvedValue({ account_count: 0, occupied_cost: "0.00", over_7d_count: 0, over_30d_count: 0 });
  vi.mocked(catalog.ordersApi.get).mockResolvedValue(order1);
  vi.mocked(catalog.ordersApi.links).mockResolvedValue([link1]);
  vi.mocked(catalog.ordersApi.deleteLink).mockResolvedValue(undefined);
  vi.mocked(catalog.ordersApi.cancel).mockResolvedValue({ ...order1, status: "CANCELLED" });
  vi.mocked(catalog.ordersApi.postEvent).mockResolvedValue({
    event: { id: 2, event_no: "EV-2", order_id: 1, event_type: "CANCEL", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, cancellable_amount: "0.00" },
    installment: { id: 11, inst_no: "INS-1", status: "CANCELLED" },
    cash_flows: [],
    warnings: [],
  } as never);
  vi.mocked(catalog.policyApi.allocations).mockResolvedValue({
    items: allocationRows,
    total: allocationRows.length,
    order_profit: "5000.00",
  });
  vi.mocked(catalog.policyApi.setAllocations).mockResolvedValue({
    items: allocationRows,
    total: allocationRows.length,
    order_profit: "5000.00",
  });
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([
    { id: 9, username: "lisi", display_name: "李四", is_active: true },
    { id: 11, username: "recovery", display_name: "回收员", is_active: true },
    { id: 22, username: "seller", display_name: "售出员", is_active: true },
    { id: 33, username: "operator", display_name: "运营员", is_active: true },
  ]);
  vi.mocked(catalog.installmentsApi.list).mockResolvedValue([installment]);
  vi.mocked(catalog.installmentsApi.cancel).mockResolvedValue(installmentCancelResult);
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

export function registerOrdersPageFilterTests() {
describe("OrdersPage：筛选与分期", () => {
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

  // 逾期标记是全局动作，后端按 as_of 扫描全部合约。
  it("切走再切回「分期与回款」会重拉分期列表（切入即刷新）", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValue([]);
    await openLedger();
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));
    await waitFor(() => expect(catalog.installmentsApi.list).toHaveBeenCalled());
    // 首次切入只靠挂载 load，不自增 refreshKey（避免双请求）
    expect(vi.mocked(catalog.installmentsApi.list)).toHaveBeenCalledTimes(1);
    const callsAfterFirstEntry = vi.mocked(catalog.installmentsApi.list).mock.calls.length;

    fireEvent.click(screen.getByRole("tab", { name: "订单台账" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "订单台账" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));

    await waitFor(() =>
      expect(vi.mocked(catalog.installmentsApi.list).mock.calls.length).toBeGreaterThan(callsAfterFirstEntry),
    );
  });

  // 原两条（有新增 / 无新增）是同一条「标记逾期」路径的两个分支，合并为一次挂载逐次点击。
  it("标记逾期：有新增提示笔数并刷新列表，无新增提示当前无新增", async () => {
    vi.mocked(catalog.installmentsApi.list).mockResolvedValue([]);
    vi.mocked(catalog.installmentsApi.markOverdue).mockResolvedValue({ marked: 3 });
    await openLedger();
    fireEvent.click(screen.getByRole("tab", { name: "分期与回款" }));
    await waitFor(() => expect(catalog.installmentsApi.list).toHaveBeenCalled());
    const callsBefore = vi.mocked(catalog.installmentsApi.list).mock.calls.length;

    await ui.click(screen.getByRole("button", { name: /标记逾期/ }));

    await waitFor(() => expect(catalog.installmentsApi.markOverdue).toHaveBeenCalled());
    expect(message.success).toHaveBeenCalledWith("已标记 3 笔逾期");
    // installmentRefreshKey 自增 → 分期面板重新 load
    await waitFor(() => expect(screen.getByRole("tab", { name: "分期与回款" })).toBeInTheDocument());
    expect(vi.mocked(catalog.installmentsApi.list).mock.calls.length).toBeGreaterThan(callsBefore);

    // 分支二：本次标记 0 笔
    vi.mocked(catalog.installmentsApi.markOverdue).mockResolvedValue({ marked: 0 });
    await ui.click(screen.getByRole("button", { name: /标记逾期/ }));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith("当前无新增逾期合约"));
  });
});
}

export function registerOrdersPageLifecycleTests() {
describe("OrdersPage：编辑与新建", () => {
  it("编辑订单：行操作列打开编辑弹窗并提交 PATCH（成交日期+备注）", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({ ...order1 });
    vi.mocked(catalog.ordersApi.patch).mockResolvedValue({ ...order1 });
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: "编辑" }));
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

  it("编辑有登记事件订单：成交日期可改、PATCH 带日期、提示「订单已更新」并关闭弹窗", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([
      {
        ...order1,
        events: [{ id: 1, event_no: "EV-1", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, cancellable_amount: "1000.00" }],
      },
    ]);
    vi.mocked(catalog.ordersApi.patch).mockResolvedValue({ ...order1 });
    await openLedger();
    await ui.click(within(tableRow("HS-2026-0001")).getByRole("button", { name: "编辑" }));
    const modal = await modalOf(/编辑订单 · HS-2026-0001/);
    // 回归：有登记事件时日期不再被禁用（后端会联动平移账期）
    expect(within(modal).getByLabelText("成交日期")).not.toBeDisabled();
    await ui.clear(within(modal).getByLabelText("成交日期"));
    await ui.type(within(modal).getByLabelText("成交日期"), "2026-10-05");
    await ui.type(within(modal).getByLabelText("备注"), "仅更新备注");
    await ui.click(within(modal).getByRole("button", { name: /保存修改/ }));
    await waitFor(() => expect(catalog.ordersApi.patch).toHaveBeenCalledWith(1, expect.objectContaining({
      trade_date: "2026-10-05",
      note: "仅更新备注",
    })));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith("订单已更新"));
    // 保存后弹窗应关闭
    await waitFor(() => expect(screen.queryByText(/编辑订单 · HS-2026-0001/)).toBeNull());
  });

  it("新建订单：菜单收起、弹窗开关与成功后刷新列表", async () => {
    await openLedger();
    const before = vi.mocked(catalog.ordersApi.list).mock.calls.length;
    const trigger = screen.getByRole("button", { name: /新建订单/ });

    await ui.click(trigger);
    expect(await screen.findByText("新建提号订单")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("新建回收订单"));
    expect(await screen.findByTestId("create-stub")).toBeInTheDocument();
    // P2-190：受控下拉，选中后弹层真正卸载，不会浮在弹窗上方
    await waitFor(() => expect(screen.queryByText("新建提号订单")).toBeNull());
    await waitFor(() => expect(trigger).not.toHaveAttribute("aria-expanded", "true"));

    await ui.click(screen.getByRole("button", { name: /关闭新建弹窗/ }));
    await waitFor(() => expect(screen.queryByTestId("create-stub")).toBeNull());

    await ui.click(trigger);
    fireEvent.click(await screen.findByText("新建回收订单"));
    await screen.findByTestId("create-stub");
    await ui.click(screen.getByRole("button", { name: /模拟新建成功/ }));
    await waitFor(() => expect(screen.queryByTestId("create-stub")).toBeNull());
    expect(vi.mocked(catalog.ordersApi.list).mock.calls.length).toBeGreaterThan(before);
  });
});
}

export function registerOrdersPageAllocationTests() {
describe("OrdersPage：分润", () => {
  // 原两条（按姓名预填 / 展示订单总利润）同一份夹具、同一入口、纯只读，合并为一次挂载。
  it("分润：弹窗按姓名预填已有比例，并展示订单总利润", async () => {
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    expect(document.querySelector(".allocation-modal")).toBeInTheDocument();
    expect(catalog.policyApi.allocations).toHaveBeenCalledWith(1);
    // 一行 = 一位员工（李四 40%），不再固定四个动作位
    expect(within(modal).getAllByLabelText("比例")).toHaveLength(1);
    expect(within(modal).getByDisplayValue("40")).toBeInTheDocument();
    // 姓名下拉（顶部多选 + 行内单选）都显示李四
    expect(within(modal).getAllByText("李四（lisi）").length).toBeGreaterThan(0);
    // 总利润直接取后端 order_profit，不在前端重算
    expect(within(modal).getByText(/订单总利润/)).toBeInTheDocument();
    expect(within(modal).getByText("5,000.00")).toBeInTheDocument();
  });

  it("分润：比例与金额双向联动，按最后编辑的一项换算", async () => {
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    const rate = within(modal).getByLabelText("比例");
    const amount = within(modal).getByLabelText("金额");

    // 5000 × 30% = 1500，填比例立即回填金额
    fireEvent.change(rate, { target: { value: "30" } });
    expect(rate).toHaveValue("30");
    expect(amount).toHaveValue("1500.00");

    // 再改金额：1500 ÷ 5000 = 30%，金额反向回填比例
    fireEvent.change(amount, { target: { value: "2500" } });
    expect(amount).toHaveValue("2500");
    expect(rate).toHaveValue("50.00");
  });

  it("分润：无存量时按操作四项展开，买号/售出自动绑定动作执行人", async () => {
    // 空分润 → 按操作口径起步：买号、售出、运营、公司四项固定展开。
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({
      items: [],
      total: 0,
      order_profit: "5000.00",
    });
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
      ...order1,
      form_extra: {
        business_responsible_ids: [11],
        delivery_responsible_ids: [22],
      },
      events: [
        { id: 101, event_no: "EV-101", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, operator_user_ids: [], cancellable_amount: "1000.00" },
        { id: 102, event_no: "EV-102", order_id: 1, event_type: "SELL", amount: "1500.00", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [], cancellable_amount: "1500.00" },
        { id: 103, event_no: "EV-103", order_id: 1, event_type: "COST", amount: "100.00", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [33], cancellable_amount: "100.00" },
      ],
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    expect(within(modal).getAllByLabelText("比例")).toHaveLength(4);
    for (const label of ["买号", "售出", "运营", "公司"]) {
      expect(within(modal).getByText(label)).toBeInTheDocument();
    }
    // 买号取建单负责人，售出取卖出表单负责人，运营取运营信息中的动作负责人，均自动带出。
    expect(within(modal).getByText("回收员（recovery）")).toBeInTheDocument();
    expect(within(modal).getByText("售出员（seller）")).toBeInTheDocument();
    expect(within(modal).getByText("运营员（operator）")).toBeInTheDocument();
  });

  it("分润：按操作四项无候选执行人时人员留空且锁定（不猜当前登录人）", async () => {
    // 人员只认账号台账 / 库存中心登记的执行人，分润弹窗不就地猜人。
    // 本单无任何动作负责人，四行人员全部锁定且留空，等待台账补登记。
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({
      items: [],
      total: 0,
      order_profit: "5000.00",
    });
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
      ...order1,
      form_extra: {},
      events: [],
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    // 无登记执行人 → 不再默认当前登录人
    expect(within(modal).queryByText("李四（lisi）")).toBeNull();
    // 公司位固定不绑人，不能被当前登录人覆盖。
    expect(within(modal).getByText("公司（不绑定人员）")).toBeInTheDocument();
    // 买号/售出/运营/公司四项的人员控件全部禁用：人员编辑只在台账与库存中心。
    expect(modal.querySelectorAll(".ant-select-disabled").length).toBe(4);
  });

  it("分润：按操作四项的人员锁定为台账登记的执行人", async () => {
    // 买号=业务负责人、售出=交付负责人、运营=运营负责人；三行都不可就地改人。
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({
      items: [],
      total: 0,
      order_profit: "5000.00",
    });
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
      ...order1,
      form_extra: {
        business_responsible_ids: [11],
        delivery_responsible_ids: [22],
        operation_responsible_ids: [33],
      },
      events: [
        { id: 101, event_no: "EV-101", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, operator_user_ids: [], cancellable_amount: "1000.00" },
        { id: 102, event_no: "EV-102", order_id: 1, event_type: "SELL", amount: "1500.00", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [], cancellable_amount: "1500.00" },
      ],
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);

    expect(within(modal).getByText("回收员（recovery）")).toBeInTheDocument();
    expect(within(modal).getByText("售出员（seller）")).toBeInTheDocument();
    expect(within(modal).getByText("运营员（operator）")).toBeInTheDocument();
    // 四行人员控件全部禁用，买号/售出/运营不能改选其他人
    expect(modal.querySelectorAll(".ant-select-disabled").length).toBe(4);
  });

  it("分润：按人分配点「增加一行」时姓名默认当前登录人", async () => {
    // 存量按人（无 allocation_type）走 PERSON 口径；新增行过去只默认 role=OWNER、姓名留空。
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({
      items: [{ id: 1, order_id: 1, user_id: 11, role: "OWNER", allocation_type: null, allocation_rate: "100" }],
      total: 1,
      order_profit: "5000.00",
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    expect(within(modal).getByText("回收员（recovery）")).toBeInTheDocument();
    await ui.click(within(modal).getByRole("button", { name: /增加一行/ }));
    // 新行姓名直接带出当前登录人（李四/lisi），角色仍按业绩归属人兜底。
    const selects = within(modal).getAllByText("李四（lisi）");
    expect(selects.length).toBeGreaterThan(0);
    expect(within(modal).getAllByLabelText("比例")).toHaveLength(2);
  });

  it("分润：按操作四项时比例与金额同样双向联动", async () => {
    // 只测按姓名口径会漏掉「买号/售出/运营/公司」四行的情况。
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({
      items: [],
      total: 0,
      order_profit: "5000.00",
    });
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
      ...order1,
      form_extra: {
        business_responsible_ids: [11],
        delivery_responsible_ids: [22],
      },
      events: [
        { id: 101, event_no: "EV-101", order_id: 1, event_type: "BUY", amount: "1000.00", occurred_on: "2026-10-01", is_posted: true, operator_user_ids: [], cancellable_amount: "1000.00" },
        { id: 102, event_no: "EV-102", order_id: 1, event_type: "SELL", amount: "1500.00", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [], cancellable_amount: "1500.00" },
      ],
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    const rates = within(modal).getAllByLabelText("比例");
    const amounts = within(modal).getAllByLabelText("金额");
    expect(rates).toHaveLength(4);

    // 填买号行比例：本行按订单利润换算金额，另外三行不被牵连改写
    fireEvent.change(rates[0], { target: { value: "30" } });
    expect(rates[0]).toHaveValue("30");
    expect(amounts[0]).toHaveValue("1500.00");
    expect(amounts[1]).toHaveValue("");
    expect(amounts[2]).toHaveValue("");

    // 再填本行金额：按订单利润反算比例
    fireEvent.change(amounts[0], { target: { value: "1000" } });
    expect(amounts[0]).toHaveValue("1000");
    expect(rates[0]).toHaveValue("20.00");
  });

  it("分润：一个动作多人时按人数均分，买号 2 人各得一半", async () => {
    // 2026-11-05 口径：买号登记 2 人，买号这一份利润由 2 人均分；3 人则三人均分。
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({
      items: [],
      total: 0,
      order_profit: "5000.00",
    });
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
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
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);

    // 买号两人 → 展开两行：首行写字号合计，第二行只读显示人均值。
    expect(within(modal).getByText("买号（2 人均分）")).toBeInTheDocument();
    const totalRates = within(modal).getAllByLabelText("比例合计");
    expect(totalRates).toHaveLength(1);
    fireEvent.change(totalRates[0], { target: { value: "30" } });
    // 另一人的比例是只读的人均值：30 ÷ 2 = 15%
    expect(within(modal).getByText("15%")).toBeInTheDocument();
    expect(within(modal).queryByLabelText("比例（人均）")).toBeNull();

    // 售出 40、运营 20、公司 10，四项合计 100
    const plainRates = within(modal).getAllByLabelText("比例");
    expect(plainRates).toHaveLength(3);
    fireEvent.change(plainRates[0], { target: { value: "40" } });
    fireEvent.change(plainRates[1], { target: { value: "20" } });
    fireEvent.change(plainRates[2], { target: { value: "10" } });

    await clickModalOk(modal);
    await waitFor(() => expect(catalog.policyApi.setAllocations).toHaveBeenCalled());
    const [, payload] = vi.mocked(catalog.policyApi.setAllocations).mock.calls[0];
    const buyRows = payload.filter((item) => item.allocation_type === "BUY");
    // 买号 30% 拆成两人各 15%，不是一人独得 30%
    expect(buyRows).toHaveLength(2);
    expect(buyRows.map((item) => item.allocation_rate)).toEqual(["15", "15"]);
    expect(buyRows.map((item) => item.user_id)).toEqual([11, 22]);
    expect(payload).toHaveLength(5);
  });

  it("分润：按操作四项提交时带上 allocation_type 与比例", async () => {
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({
      items: actionAllocationRows,
      total: actionAllocationRows.length,
      order_profit: "5000.00",
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    expect(within(modal).getAllByLabelText("比例")).toHaveLength(4);
    await clickModalOk(modal);
    await waitFor(() => expect(catalog.policyApi.setAllocations).toHaveBeenCalled());
    const [, payload] = vi.mocked(catalog.policyApi.setAllocations).mock.calls[0];
    expect(payload).toHaveLength(4);
    expect(payload.map((item) => item.allocation_type)).toEqual(["BUY", "SELL", "OPERATION", "COMPANY"]);
    expect(payload.find((item) => item.allocation_type === "OPERATION")).toMatchObject({ user_id: 9, role: "SERVICE" });
  });

  it("分润：既有角色回显并原样提交，不被默认 OWNER 覆盖", async () => {
    // 存量行角色为 SALES：编辑保存必须保留，否则会被默认值静默改写（数据损坏）。
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({
      items: [
        { id: 1, order_id: 1, user_id: 9, role: "SALES", allocation_type: null, allocation_rate: "100" },
      ],
      total: 1,
      order_profit: "5000.00",
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    expect(within(modal).getByText("销售")).toBeInTheDocument();
    await clickModalOk(modal);
    await waitFor(() => expect(catalog.policyApi.setAllocations).toHaveBeenCalled());
    const [, payload] = vi.mocked(catalog.policyApi.setAllocations).mock.calls[0];
    expect(payload[0]).toMatchObject({ user_id: 9, role: "SALES", allocation_rate: "100" });
  });

  it("分润：角色下拉改成服务后随提交上送", async () => {
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    fireEvent.mouseDown(within(modal).getByRole("combobox", { name: "角色" }));
    await ui.click(await screen.findByTitle("服务"));
    const rates = within(modal).getAllByLabelText("比例");
    await ui.clear(rates[0]);
    await ui.type(rates[0], "100");
    await clickModalOk(modal);
    await waitFor(() => expect(catalog.policyApi.setAllocations).toHaveBeenCalled());
    const [, payload] = vi.mocked(catalog.policyApi.setAllocations).mock.calls[0];
    expect(payload[0]).toMatchObject({ user_id: 9, role: "SERVICE", allocation_rate: "100" });
  });

  it("分润：纯比例合计非 100% 时拒绝提交", async () => {
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    await clickModalOk(modal);
    await waitFor(() =>
      expect(message.error).toHaveBeenCalledWith("按比例分润时合计必须为 100%（也可改用金额）"),
    );
    expect(catalog.policyApi.setAllocations).not.toHaveBeenCalled();
  });

  it("分润：比例合计 100% 提交成功并绑定员工，随后刷新订单详情", async () => {
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({ account: {}, orders: [] } as never);
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    const rates = within(modal).getAllByLabelText("比例");
    await ui.clear(rates[0]);
    await ui.type(rates[0], "100");
    await clickModalOk(modal);
    await waitFor(() => expect(catalog.policyApi.setAllocations).toHaveBeenCalled());
    const [orderId, payload] = vi.mocked(catalog.policyApi.setAllocations).mock.calls[0];
    expect(orderId).toBe(1);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      user_id: 9,
      role: "OWNER",
      allocation_rate: "100",
      allocation_amount: "0",
    });
    expect(message.success).toHaveBeenCalledWith("分润已保存");
    // 分润保存后按 account_id 强制刷新订单详情，使明细回显。
    await waitFor(() => expect(catalog.stocksApi.executionDetail).toHaveBeenCalledWith(order1.account_id));
  });

  it("分润：改成按金额分润时提交 allocation_amount", async () => {
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    const rates = within(modal).getAllByLabelText("比例");
    await ui.clear(rates[0]);
    await ui.type(within(modal).getByLabelText("金额"), "200");
    await clickModalOk(modal);
    await waitFor(() => expect(catalog.policyApi.setAllocations).toHaveBeenCalled());
    const [, payload] = vi.mocked(catalog.policyApi.setAllocations).mock.calls[0];
    expect(payload[0]).toMatchObject({
      user_id: 9,
      allocation_rate: "0",
      allocation_amount: "200",
    });
  });

  it("分润：亏损单提示改为「金额填负数」而非「不可用」", async () => {
    // 亏损单允许按金额分润，提示语必须说明填负数（-300 = 分担 300 亏损）。
    vi.mocked(catalog.policyApi.allocations).mockResolvedValue({
      items: allocationRows,
      total: allocationRows.length,
      order_profit: "-800.00",
    });
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    expect(within(modal).getByText(/（亏损）金额分润请填负数/)).toBeInTheDocument();
    expect(within(modal).queryByText(/金额分润不可用/)).toBeNull();
    expect(within(modal).getByText("-800.00")).toBeInTheDocument();
  });

  it("分润：同一行比例与金额换算不一致时拦截", () => {
    // 现行口径：允许同一行同时填比例与金额，但两者必须换算一致（5000×50%=2500 ≠ 200）。
    const r = validateAllocations(
      [{ employee: 9, allocation_rate: "50", allocation_amount: "200" }],
      "5000.00",
    );
    expect(r).toEqual({ ok: false, error: "比例和金额换算不一致" });
  });

  it("分润：保存失败提示错误", async () => {
    vi.mocked(catalog.policyApi.setAllocations).mockRejectedValue(new Error("alloc fail"));
    await openLedger();
    await openRowMenu("HS-2026-0001", "分润");
    const modal = await modalOf(/分润 · HS-2026-0001/);
    const rates = within(modal).getAllByLabelText("比例");
    await ui.clear(rates[0]);
    await ui.type(rates[0], "100");
    await clickModalOk(modal);
    await waitFor(() => expect(message.error).toHaveBeenCalledWith(expect.stringContaining("alloc fail")));
  });
});
}

export function registerOrdersPageCashflowTests() {
describe("OrdersPage：资金收支", () => {
  it("资金收支：填写金额与备注后调用 postEvent(REFUND)", async () => {
    await openLedger();
    await openRowMenu("HS-2026-0001", "资金收支");
    const modal = await modalOf(/资金收支 · HS-2026-0001/);
    await ui.type(within(modal).getByLabelText("金额"), "500");
    await ui.type(within(modal).getByLabelText("收支备注"), "客户取消");
    expect(within(modal).getByText("支出")).toBeInTheDocument();
    await clickModalOk(modal);
    await waitFor(() =>
      expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(1, expect.objectContaining({ event_type: "REFUND", occurred_on: today() }))
    );
    expect(message.success).toHaveBeenCalledWith("退款已登记");
  });

  it("资金收支：提交失败提示错误并关闭 loading", async () => {
    vi.mocked(catalog.ordersApi.postEvent).mockRejectedValue(new Error("refund fail"));
    await openLedger();
    await openRowMenu("HS-2026-0001", "资金收支");
    const modal = await modalOf(/资金收支 · HS-2026-0001/);
    await ui.type(within(modal).getByLabelText("金额"), "500");
    await ui.type(within(modal).getByLabelText("收支备注"), "客户取消");
    await clickModalOk(modal);
    await waitFor(() => expect(message.error).toHaveBeenCalledWith(expect.stringContaining("refund fail")));
  });
});
}

export function registerOrdersPageCancellationTests() {
describe("OrdersPage：取消", () => {
  it("取消：存在可冲销已登记动作时发起 CANCEL 冲销", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
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
      expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(
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

    vi.mocked(catalog.ordersApi.list).mockResolvedValue([cancelOrder]);
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
      ...cancelOrder,
      events: [{ id: 2101, order_id: 21, event_type: "BUY", event_no: "EV-CANCEL-ASYNC-01", amount: "100.00", occurred_on: "2026-11-01", pool_id: 7, is_posted: true, cancellable_amount: "100.00" }],
    });
    vi.mocked(catalog.poolsApi.list).mockImplementation(() => poolsPending as never);
    vi.mocked(catalog.employeesApi.list).mockResolvedValue([]);

    await openLedger();
    await openRowMenu("HS-CANCEL-ASYNC-01", "取消");
    expect(screen.queryByText(/取消 · HS-CANCEL-ASYNC-01/)).not.toBeInTheDocument();

    resolvePools([{ id: 7, code: "HJ_INVEST", name: "投资款荷包", status: "ACTIVE" }]);
    const modal = await modalOf(/取消 · HS-CANCEL-ASYNC-01/);
    await ui.type(within(modal).getByLabelText("取消原因"), "异步加载回归");
    await clickModalOk(modal);

    await waitFor(() => expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(
      21,
      expect.objectContaining({ event_type: "CANCEL", offset_event_id: 2101, pool_id: 7 }),
    ));
  });

  it("取消：冲销入库流水并进入公司钱包", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
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
    await waitFor(() => expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ event_type: "CANCEL", pool_id: 7, form_extra_scope: "INVREFUND", operator_user_ids: expect.arrayContaining([expect.any(Number)]) }),
    ));
  });

  it("取消：按售出流水做部分退款冲销", async () => {
    vi.mocked(catalog.ordersApi.get).mockResolvedValue({
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
      expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ event_type: "CANCEL", offset_event_id: 102, amount: "300", form_extra_scope: "ORDERCANC" }),
      )
    );
  });

  it("取消：分期订单按合约取消并提示退款金额", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([order3]);
    vi.mocked(catalog.ordersApi.get).mockResolvedValue(order3);
    await openLedger();
    await openRowMenu("HS-2026-0003", "取消");
    const modal = await modalOf(/取消 · INS-1/);
    await ui.type(screen.getByLabelText("取消原因"), "提前结清");
    fireEvent.click(screen.getByRole("button", { name: /确认取消/ }));
    await waitFor(() => expect(catalog.installmentsApi.cancel).toHaveBeenCalledWith(11, expect.objectContaining({ reason: "提前结清" })));
    // money() 走千分位格式化
    expect(message.success).toHaveBeenCalledWith(expect.stringContaining("退款已登记：¥3,000.00"));
  });

  it("取消：分期订单无可用合约时提示", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([order3]);
    vi.mocked(catalog.ordersApi.get).mockResolvedValue(order3);
    vi.mocked(catalog.installmentsApi.list).mockResolvedValue([{ ...installment, status: "CANCELLED" }]);
    await openLedger();
    await openRowMenu("HS-2026-0003", "取消");
    await waitFor(() => expect(message.error).toHaveBeenCalledWith("未找到可取消的分期合约"));
  });

  it("取消：打开详情失败时提示错误", async () => {
    vi.mocked(catalog.ordersApi.get).mockRejectedValue(new Error("detail fail"));
    await openLedger();
    await openRowMenu("HS-2026-0001", "取消");
    await waitFor(() => expect(message.error).toHaveBeenCalledWith(expect.stringContaining("detail fail")));
  });
});
}
