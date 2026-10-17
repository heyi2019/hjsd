import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { OrdersPage } from "./OrdersPage";

const ordersList = vi.fn();
const typesList = vi.fn();
const accountsList = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  ordersApi: { list: (...a: unknown[]) => ordersList(...a), create: vi.fn(), patch: vi.fn(), get: vi.fn() },
  orderTypesApi: { list: (...a: unknown[]) => typesList(...a), create: vi.fn() },
  customersApi: { list: vi.fn(), create: vi.fn(), merge: vi.fn(), patch: vi.fn(), setStatus: vi.fn(), get: vi.fn() },
  counterpartiesApi: { list: vi.fn(), create: vi.fn(), setStatus: vi.fn() },
  accountsApi: { list: (...a: unknown[]) => accountsList(...a), create: vi.fn() },
}));

const orders = [
  {
    id: 1,
    order_no: "HS-2026-0001",
    order_type: "HS",
    capital_type: "SELF",
    trade_date: "2026-10-01",
    status: "ACTIVE",
    account_game_type: "原神",
    account_game_account: "seller-001",
    account_platform: "安卓",
    account_status: "IN_STOCK",
    party_name: "卖家甲",
    party_source: "同行推荐",
    event_total: "1234.00",
    last_event_type: "BUY",
  },
  { id: 2, order_no: "TH-2026-0002", order_type: "TH", capital_type: "PEER", trade_date: "2026-10-02", status: "COMPLETED" },
];
const types = [{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }];

beforeEach(() => {
  vi.clearAllMocks();
  ordersList.mockResolvedValue(orders);
  typesList.mockResolvedValue(types);
  accountsList.mockResolvedValue([]);
});

async function openLedger() {
  renderApp(<OrdersPage />, { user: "admin" });
  await screen.findByRole("tab", { name: "业务台账" });
  await waitFor(() => expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThanOrEqual(1));
}

describe("OrdersPage：四类业务台账", () => {
  it("顶部不再重复展示业务中心标题与说明", async () => {
    renderApp(<OrdersPage />);
    await screen.findByRole("tab", { name: "业务台账" });
    expect(screen.queryByRole("heading", { name: "业务中心" })).toBeNull();
    expect(screen.queryByText("获客是通用能力；买号、买入交付、售出、售出交付和回款（分期）是执行动作。回收、提号、代挂、代分期分别承载不同业务。")).toBeNull();
    expect(screen.queryByText(/待处理/)).toBeNull();
  });

  it("加载后渲染订单编号与状态", async () => {
    await openLedger();
    expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("TH-2026-0002").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("进行中").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("已完成").length).toBeGreaterThanOrEqual(1);
  });

  it("业务台账统一展示通用字段", async () => {
    await openLedger();

    for (const label of ["订单号", "对方 / 来源", "产品", "账号", "平台", "金额", "库存状态", "最新动作", "状态", "日期", "操作"]) {
      expect(screen.getAllByRole("columnheader", { name: label }).length).toBeGreaterThan(0);
    }
    for (const value of ["卖家甲 · 同行推荐", "原神", "seller-001", "安卓", "¥1,234.00", "在库"]) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
  });

  it("加载失败时展示错误条", async () => {
    ordersList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<OrdersPage />);
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("业务中心保留库存、台账与分期回款视图，不展示独立返点页签", async () => {
    renderApp(<OrdersPage />);
    await screen.findByRole("tab", { name: "业务台账" });
    for (const label of ["库存中心", "业务台账", "分期与回款"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("tab", { name: "返点" })).toBeNull();
  });

  it("新建订单菜单提供回收、提号、代挂、代分期四个表单", async () => {
    renderApp(<OrdersPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "业务台账" });
    await userEvent.click(screen.getByRole("button", { name: /新建订单/ }));
    for (const label of ["新建回收订单", "新建提号订单", "新建代挂订单", "新建代分期订单"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  it("移除没有明确业务含义的通用登记事件入口", async () => {
    renderApp(<OrdersPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "业务台账" });
    expect(screen.queryByRole("button", { name: /登记事件/ })).toBeNull();
  });

  it("忽略已废弃的业务中心页签参数并回到业务台账", async () => {
    renderApp(<OrdersPage initialTab={"th" as "inventory"} />);
    const tab = await screen.findByRole("tab", { name: "业务台账" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect((await screen.findAllByText("HS-2026-0001")).length).toBeGreaterThan(0);
  });
});
