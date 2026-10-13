import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { OrdersPage } from "./OrdersPage";

const ordersList = vi.fn();
const ordersCreate = vi.fn();
const ordersPostEvent = vi.fn();
const typesList = vi.fn();
const typesRoutes = vi.fn();
const customersList = vi.fn();
const counterpartiesList = vi.fn();
const accountsList = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  ordersApi: {
    list: (...a: unknown[]) => ordersList(...a),
    create: (...a: unknown[]) => ordersCreate(...a),
    postEvent: (...a: unknown[]) => ordersPostEvent(...a),
    patch: vi.fn(),
    get: vi.fn(),
  },
  orderTypesApi: {
    list: (...a: unknown[]) => typesList(...a),
    routes: (...a: unknown[]) => typesRoutes(...a),
    create: vi.fn(),
  },
  customersApi: {
    list: (...a: unknown[]) => customersList(...a),
    create: vi.fn(),
    merge: vi.fn(),
    patch: vi.fn(),
    setStatus: vi.fn(),
    get: vi.fn(),
  },
  counterpartiesApi: {
    list: (...a: unknown[]) => counterpartiesList(...a),
    create: vi.fn(),
    setStatus: vi.fn(),
  },
  accountsApi: { list: (...a: unknown[]) => accountsList(...a), create: vi.fn() },
}));

const orders = [
  { id: 1, order_no: "HS-2026-0001", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" },
  { id: 2, order_no: "TH-2026-0002", order_type: "TH", capital_type: "PEER", trade_date: "2026-10-02", status: "COMPLETED" },
];
const types = [{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }];
/** HS 的真实路由：只有 本金/利润（没有 总额）——事件弹窗的份额选项必须照此生成。 */
const hsRoutes = [
  { id: 1, order_type_code: "HS", portion: "PRINCIPAL", pool_code: "HJ_INVEST", pool_name: "投资款荷包", priority: 0, is_active: true },
  { id: 2, order_type_code: "HS", portion: "PROFIT", pool_code: "HJ_PROFIT", pool_name: "利润荷包", priority: 0, is_active: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  ordersList.mockResolvedValue(orders);
  typesList.mockResolvedValue(types);
  typesRoutes.mockResolvedValue(hsRoutes);
  customersList.mockResolvedValue([{ id: 1, customer_no: "CUS-0001", display_name: "张三", status: "ACTIVE" }]);
  counterpartiesList.mockResolvedValue([]);
  accountsList.mockResolvedValue([{ id: 9, account_no: "HJACC-0001", status: "IN_STOCK", cost_amount: "0.00" }]);
});

/** 建单写路径用例已随「新建业务」入口迁至工作台速览区：见 orders/CreateOrderModal.test.tsx。
 *  页内 PageHeader（标题+描述，与顶栏页名重复）已于 2026-10-13 移除，锚点改用首个 Tab。 */
async function openLedger() {
  renderApp(<OrdersPage />, { user: "admin" });
  await screen.findByRole("tab", { name: "业务作业" });
  await userEvent.click(screen.getByRole("tab", { name: "订单台账" }));
  await waitFor(() => expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThanOrEqual(1));
}

describe("OrdersPage：订单台账", () => {
  it("加载后渲染订单编号与状态", async () => {
    await openLedger();
    expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("TH-2026-0002").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("进行中").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("已完成").length).toBeGreaterThanOrEqual(1);
  });

  it("加载失败时展示错误条（后端不可达）", async () => {
    ordersList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<OrdersPage />);
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("五个 Tab 齐全：作业/台账/库存/分期/返点", async () => {
    renderApp(<OrdersPage />);
    await screen.findByRole("tab", { name: "业务作业" });
    for (const label of ["业务作业", "订单台账", "库存", "分期", "返点"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
  });
});

/** 建单写路径用例已随「新建业务」入口迁至工作台速览区：见 orders/CreateOrderModal.test.tsx。 */

/** 登记事件弹窗：打开首行订单的「登记事件」，返回弹窗容器。
 *  不依赖具体单号——DG 用例会把订单集合换成 DG。
 *  注意：jsdom 下 antd Tabs 会把「业务作业」「订单台账」两个面板都挂进 DOM
 *  （非激活面板不卸载），两个面板各有「登记事件」按钮 → 全局 find 会命中多条而抛错。
 *  因此必须先把交互聚焦到当前激活面板（ant-tabs-tabpane-active），在面板内定位按钮。 */
async function openEventModal(): Promise<HTMLElement> {
  renderApp(<OrdersPage />, { user: "admin" });
  await screen.findByRole("tab", { name: "业务作业" });
  await userEvent.click(screen.getByRole("tab", { name: "业务作业" }));
  // 两个 Tab 面板都挂 DOM（非激活面板不卸载），各自有「登记事件」按钮；且 antd 在
  // jsdom 下把 loading 前缀算进按钮可访问名（"loading 登记事件"），故必须：①限定到激活
  // 面板避免 ledger 面板那份重复命中 ②用正则名匹配包容 loading 前缀。
  await waitFor(() => expect(document.querySelector(".ant-tabs-tabpane-active")).not.toBeNull());
  const activePane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
  const entries = within(activePane).getAllByRole("button", { name: /登记事件/ });
  await userEvent.click(entries[0]);
  const submit = await screen.findByRole("button", { name: /提交过账/ });
  return submit.closest(".ant-modal-content") as HTMLElement;
}

describe("OrdersPage：事件过账（换绑交付 / 资金份额）", () => {
  it("事件类型只给可过账集合：不再出现必然失败的「划转」", async () => {
    const modal = await openEventModal();
    await userEvent.click(modal.querySelectorAll(".ant-select-selector")[0] as Element);
    expect(await screen.findByTitle("换绑交付")).toBeInTheDocument();
    expect(screen.queryByTitle("划转")).toBeNull();
  });

  it("换绑交付缺交付方式/凭证不给提交；补齐后透传 delivery_mode", async () => {
    ordersPostEvent.mockResolvedValueOnce({ event: { event_no: "HJE0001" }, cashflow_no: null });
    const modal = await openEventModal();
    await userEvent.click(modal.querySelectorAll(".ant-select-selector")[0] as Element);
    await userEvent.click(await screen.findByTitle("换绑交付"));

    // 只选事件类型 → 交付方式与凭证说明均为空，校验必须拦住（后端不接受无 delivery_mode 的 DELIVER）
    await userEvent.click(screen.getByRole("button", { name: /提交过账/ }));
    await waitFor(() => expect(ordersPostEvent).not.toHaveBeenCalled());

    const selectors = modal.querySelectorAll(".ant-select-selector");
    expect(selectors.length).toBe(3); // 事件类型 / 资金份额 / 交付方式
    await userEvent.click(selectors[2] as Element);
    await userEvent.click(await screen.findByTitle("客户自行换绑"));
    await userEvent.type(modal.querySelector("textarea") as Element, "客户自助换绑，凭证已留存");
    await userEvent.click(screen.getByRole("button", { name: /提交过账/ }));

    await waitFor(() => expect(ordersPostEvent).toHaveBeenCalledTimes(1));
    const [orderId, payload] = ordersPostEvent.mock.calls[0] as [number, Record<string, unknown>];
    expect(orderId).toBe(1);
    expect(payload.event_type).toBe("DELIVER");
    expect(payload.delivery_mode).toBe("CUSTOMER_SELF");
  });

  it("资金份额按业务路由生成：HS 只给本金/利润，不出现「总额」", async () => {
    const modal = await openEventModal();
    expect(typesRoutes).toHaveBeenCalledWith(1);
    expect(modal.textContent).toContain("本金");
    await userEvent.click(modal.querySelectorAll(".ant-select-selector")[1] as Element);
    expect(await screen.findByTitle("利润")).toBeInTheDocument();
    expect(screen.queryByTitle("总额")).toBeNull();
  });

  it("DG 只有 利润/总额 路由：默认份额取首项，不再写死「本金」", async () => {
    typesList.mockResolvedValue([
      { id: 3, code: "DG", name: "代挂", capital_type: "ZERO", is_active: true },
    ]);
    typesRoutes.mockResolvedValue([
      { id: 5, order_type_code: "DG", portion: "PROFIT", pool_code: "HJ_PROFIT", pool_name: "利润荷包", priority: 0, is_active: true },
      { id: 6, order_type_code: "DG", portion: "GROSS", pool_code: "HJ_PROFIT", pool_name: "利润荷包", priority: 0, is_active: true },
    ]);
    ordersList.mockResolvedValue([
      { id: 8, order_no: "DG0001", order_type: "DG", capital_type: "ZERO", trade_date: "2026-10-01", status: "DRAFT" },
    ]);

    const modal = await openEventModal();
    expect(typesRoutes).toHaveBeenCalledWith(3);
    expect(modal.textContent).toContain("利润");
    expect(modal.textContent).not.toContain("本金");
  });
});
