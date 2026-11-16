import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { OrdersPage } from "@/orders/OrdersPage";

import { orderTypesApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { seedOptionSets, seedOrderFormFields } from "@fixtures/formFieldsSeed";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

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

const orders = [
  {
    id: 1,
    order_no: "HS-2026-0001",
    order_type: "HS",
    capital_type: "SELF",
    trade_date: "2026-10-01",
    status: "ACTIVE",
    account_id: 99,
    account_game_type: "原神",
    account_game_account: "seller-001",
    account_platform: "安卓",
    account_status: "WAITING",
    party_name: "卖家甲",
    party_source: "同行推荐",
    sale_amount: "1234.00",
    last_event_type: "BUY",
    inventory_operator: "入库员",
    inventory_entry_at: "2026-10-01T09:30:00",
    sale_operator: "售卖员",
    sale_at: "2026-10-17T16:45:00",
  },
  { id: 2, order_no: "TH-2026-0002", order_type: "TH", capital_type: "PEER", trade_date: "2026-10-02", status: "COMPLETED" },
];
const types = [{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }];

beforeEach(() => {
  vi.clearAllMocks();
  seedOptionSets();
  seedOrderFormFields();
  vi.mocked(ordersApi.list).mockResolvedValue(orders as never);
  vi.mocked(orderTypesApi.list).mockResolvedValue(types as never);
  vi.mocked(stocksApi.list).mockResolvedValue([]);
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "管理员", is_active: true },
  ]);
  vi.mocked(ordersApi.executionDetail).mockResolvedValue({
    account: { id: 99, stock_no: "KU_00001", game_account: "acc-99", game_type: "原神", status: "WAITING", inventory_type: "RECOVERY" },
    orders: [{ order_id: 1, order_no: "HS-2026-0001", order_type: "HS", trade_date: "2026-10-01", status: "ACTIVE", events: [] }],
    finance_summary: { total_income: "0", total_expense: "0", net_profit: "0" },
  } as never);
  vi.mocked(stocksApi.updateProfile).mockResolvedValue({ id: 99, game_account: "acc-99" } as never);
});

describe("订单台账统一编辑入口（#15 需求1）", () => {
  it("列表行只展示「编辑」，不再单列「编辑账号」", async () => {
    renderLight(<OrdersPage />, { user: "admin" });
    await ui.click(await screen.findByRole("tab", { name: "订单台账" }));
    await waitFor(() =>
      expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThanOrEqual(1),
    );

    const row = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))?.closest("tr");
    expect(row).not.toBeNull();
    const editBtn = within(row as HTMLElement).getByRole("button", { name: "编辑" });
    await ui.click(editBtn);

    expect(await screen.findByRole("button", { name: "保存修改" })).toBeInTheDocument();
    expect(screen.queryByLabelText("编辑游戏账号/产品")).toBeNull();
    expect(screen.getByRole("button", { name: "保存修改" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑账号" })).toBeNull();
  });

  it("首次编辑只读取一次订单执行详情，并同时供展开区与编辑器使用", async () => {
    renderLight(<OrdersPage />, { user: "admin" });
    await ui.click(await screen.findByRole("tab", { name: "订单台账" }));
    const row = screen.getAllByText("HS-2026-0001").find((element) => element.closest("tr"))?.closest("tr");

    await ui.click(within(row as HTMLElement).getByRole("button", { name: "编辑" }));

    await screen.findByRole("button", { name: "保存修改" });
    expect(ordersApi.executionDetail).toHaveBeenCalledTimes(1);
    expect(ordersApi.executionDetail).toHaveBeenCalledWith(1);
  });

  it("未关联库存账号的订单不显示「编辑账号」入口", async () => {
    // 本用例刻意去掉所有订单的 account_id，验证无关联账号时不出现「编辑账号」入口。
    vi.mocked(ordersApi.list).mockResolvedValue([
      { id: 1, order_no: "HS-2026-0001", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE", account_game_type: "原神", account_game_account: "seller-001", account_platform: "安卓", account_status: "WAITING" },
      { id: 2, order_no: "TH-2026-0002", order_type: "TH", capital_type: "PEER", trade_date: "2026-10-02", status: "COMPLETED" },
    ] as never);
    renderLight(<OrdersPage />);
    await ui.click(await screen.findByRole("tab", { name: "订单台账" }));
    await waitFor(() =>
      expect(screen.getAllByText("TH-2026-0002").length).toBeGreaterThanOrEqual(1),
    );
    expect(screen.queryAllByRole("button", { name: "编辑账号" }).length).toBe(0);
  });
});
