import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { OrdersPage } from "./OrdersPage";

const ordersList = vi.fn();
const ordersCreate = vi.fn();
const ordersPostEvent = vi.fn();
const typesList = vi.fn();
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
  orderTypesApi: { list: (...a: unknown[]) => typesList(...a), create: vi.fn() },
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

beforeEach(() => {
  vi.clearAllMocks();
  ordersList.mockResolvedValue(orders);
  typesList.mockResolvedValue(types);
  customersList.mockResolvedValue([{ id: 1, customer_no: "CUS-0001", display_name: "张三", status: "ACTIVE" }]);
  counterpartiesList.mockResolvedValue([]);
  accountsList.mockResolvedValue([{ id: 9, account_no: "HJACC-0001", status: "IN_STOCK", cost_amount: "0.00" }]);
});

async function openLedger() {
  renderApp(<OrdersPage />, { user: "admin" });
  await screen.findByText("订单总数");
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

  it("统计卡：订单总数为计数口径（不加小数）", async () => {
    await openLedger();
    expect(screen.getByText("订单总数")).toBeInTheDocument();
    const card = screen.getByText("订单总数").closest(".ui-stat");
    expect(card?.textContent).toContain("2");
    expect(card?.textContent).not.toContain("2.00");
  });

  it("加载失败时展示错误条（后端不可达）", async () => {
    ordersList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<OrdersPage />);
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("五个 Tab 齐全：作业/台账/库存/分期/返点", async () => {
    renderApp(<OrdersPage />);
    await screen.findByText("订单总数");
    for (const label of ["业务作业", "订单台账", "库存", "分期", "返点"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
  });
});

describe("OrdersPage：建单写路径", () => {
  it("admin 可见新建入口；viewer 不可见", async () => {
    await openLedger();
    expect(screen.getByRole("button", { name: /新建业务/ })).toBeInTheDocument();
  });

  it("viewer 无 order.create → 新建入口不渲染", async () => {
    renderApp(<OrdersPage />, { user: "viewer" });
    await screen.findByText("订单总数");
    expect(screen.queryByRole("button", { name: /新建业务/ })).toBeNull();
  });

  it("新建业务必填校验：未选业务类型不给提交", async () => {
    await openLedger();
    await userEvent.click(screen.getByRole("button", { name: /新建业务/ }));
    // 「新建业务」同时是按钮文案与 Modal 标题 → 用 All 变体
    await waitFor(() => expect(screen.getAllByText("新建业务").length).toBe(2));
    await userEvent.click(screen.getByRole("button", { name: /创建草稿/ }));
    await waitFor(() => expect(ordersCreate).not.toHaveBeenCalled());
  });

  it("建单提交后回传业务类型与默认成交日期", async () => {
    ordersCreate.mockResolvedValueOnce({ id: 3, order_no: "HS-2026-0003", status: "DRAFT" });
    await openLedger();
    await userEvent.click(screen.getByRole("button", { name: /新建业务/ }));
    await waitFor(() => expect(screen.getAllByText("新建业务").length).toBe(2));
    // 业务类型 Select：rc-select 监听 selector 的 mousedown
    // 页面顶部筛选栏也有 Select，必须限定在 Modal 内取（否则点的是筛选器）
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await userEvent.click(modal.querySelectorAll(".ant-select-selector")[0] as Element);
    const option = await screen.findByTitle("HS 回收");
    await userEvent.click(option);
    await userEvent.click(screen.getByRole("button", { name: /创建草稿/ }));
    await waitFor(() => expect(ordersCreate).toHaveBeenCalled());
    const payload = ordersCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.order_type).toBe("HS");
    expect(payload.trade_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("建单失败时错误落到 ErrorBanner（不静默）", async () => {
    ordersCreate.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "POOL_ROUTE_MISSING", message: "缺少资金池路由" } },
      message: "Request failed",
    });
    await openLedger();
    await userEvent.click(screen.getByRole("button", { name: /新建业务/ }));
    await waitFor(() => expect(screen.getAllByText("新建业务").length).toBe(2));
    // 页面顶部筛选栏也有 Select，必须限定在 Modal 内取（否则点的是筛选器）
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await userEvent.click(modal.querySelectorAll(".ant-select-selector")[0] as Element);
    const option = await screen.findByTitle("HS 回收");
    await userEvent.click(option);
    await userEvent.click(screen.getByRole("button", { name: /创建草稿/ }));
    expect(await screen.findByText(/设置 → 主数据/)).toBeInTheDocument();
  });
});
