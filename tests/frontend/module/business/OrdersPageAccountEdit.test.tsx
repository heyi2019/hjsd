import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { OrdersPage } from "@/orders/OrdersPage";

import * as catalog from "@/shared/api/catalog";
import { seedOptionSets, seedOrderFormFields } from "@fixtures/formFieldsSeed";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("@/shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/catalog")>();
  const METHODS = [
    "list", "get", "create", "update", "patch", "post", "postEvent", "cancel", "remove",
    "setStatus", "setActive", "resolve", "release", "settle", "approve", "reject",
    "reverse", "close", "convert", "detail", "allocations", "setAllocations",
    "balance", "executionDetail", "updateProfile", "updateExecution", "merge", "search",
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
    event_total: "1234.00",
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
  seedOptionSets(catalog);
  seedOrderFormFields(catalog);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue(orders as never);
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(types as never);
  vi.mocked(catalog.stocksApi.list).mockResolvedValue([]);
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "管理员", is_active: true },
  ]);
  vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({
    account: {
      id: 99,
      stock_no: "KU_00001",
      game_account: "acc-99",
      game_type: "原神",
      status: "WAITING",
      inventory_type: "RECOVERY",
    },
    orders: [],
    finance_summary: { total_income: "0", total_expense: "0", net_profit: "0" },
  } as never);
  vi.mocked(catalog.stocksApi.updateProfile).mockResolvedValue({ id: 99, game_account: "acc-99" } as never);
});

describe("订单台账编辑与库存中心同步（#15 需求1）", () => {
  it("列表行「编辑账号」按钮进入与库存中心一致的账号台账编辑态", async () => {
    renderLight(<OrdersPage />, { user: "admin" });
    await ui.click(await screen.findByRole("tab", { name: "订单台账" }));
    await waitFor(() =>
      expect(screen.getAllByText("HS-2026-0001").length).toBeGreaterThanOrEqual(1),
    );

    // 关联了库存账号的订单才显示「编辑账号」入口（与库存中心列表行「编辑」同口径）。
    const editBtn = await screen.findByRole("button", { name: "编辑账号" });
    await ui.click(editBtn);

    // 编辑态标志：底部「保存修改」按钮 + 账号资料可编辑输入框（来自 OrderDetailView 编辑态）。
    await waitFor(() => expect(screen.getByText("保存修改")).toBeInTheDocument());
    expect(screen.getByLabelText("编辑游戏账号/产品")).toBeInTheDocument();
  });

  it("未关联库存账号的订单不显示「编辑账号」入口", async () => {
    // 本用例刻意去掉所有订单的 account_id，验证无关联账号时不出现「编辑账号」入口。
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([
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
