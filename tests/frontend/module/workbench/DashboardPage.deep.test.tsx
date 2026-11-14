import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DashboardPage } from "@/app/DashboardPage";
import { installmentsApi } from "@/shared/api/installments.api";
import { notificationsApi } from "@/shared/api/misc.api";
import { ordersApi } from "@/shared/api/orders.api";
import { reportsApi } from "@/shared/api/reports.api";
import { stocksApi } from "@/shared/api/stocks.api";
import type { Order } from "@/shared/api/types/orders";

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

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(ordersApi.list).mockResolvedValue([]);
  vi.mocked(stocksApi.list).mockResolvedValue([]);
  vi.mocked(installmentsApi.list).mockResolvedValue([]);
  vi.mocked(notificationsApi.list).mockResolvedValue({ items: [], total: 0, unread_total: 0 });
  vi.mocked(reportsApi.commission).mockResolvedValue({
    items: [],
    total: { order_count: 0, profit_base: "0.00", payable: "0.00", paid: "0.00", difference: "0.00" },
  });
});

describe("DashboardPage.deep：失败路径/计数/未覆盖入口", () => {
  it("加载失败展示错误横幅", async () => {
    vi.mocked(ordersApi.list).mockRejectedValue(new Error("orders down"));
    renderLight(<DashboardPage />, { user: "admin" });
    expect((await screen.findAllByText(/orders down/)).length).toBeGreaterThan(0);
  });

  it("错误横幅重试：点「重新加载」再次请求列表", async () => {
    vi.mocked(ordersApi.list).mockRejectedValue(new Error("orders down"));
    renderLight(<DashboardPage />, { user: "admin" });
    expect(await screen.findAllByText(/orders down/)).toBeTruthy();
    await ui.click(screen.getAllByRole("button", { name: /重新加载/ })[0]);
    await waitFor(() => expect(ordersApi.list).toHaveBeenCalledTimes(4));
  });

  it("业务总览计数：订单总量与完成订单量", async () => {
    const orders = [
      { id: 1, status: "ACTIVE" },
      { id: 2, status: "COMPLETED" },
      { id: 3, status: "COMPLETED" },
    ] as unknown as Order[];
    vi.mocked(ordersApi.list).mockResolvedValue(orders);
    renderLight(<DashboardPage />, { user: "admin" });
    const totalCard = (await screen.findByText("订单总量")).closest(".ui-stat") as HTMLElement;
    const doneCard = (await screen.findByText("完成订单量")).closest(".ui-stat") as HTMLElement;
    expect(within(totalCard).getByText("3")).toBeInTheDocument();
    expect(within(doneCard).getByText("2")).toBeInTheDocument();
  });

  it("我的关注卡片展示当前登录用户的订单数与分润收益", async () => {
    vi.mocked(ordersApi.list).mockResolvedValueOnce([
      { id: 1, status: "ACTIVE" },
      { id: 2, status: "COMPLETED" },
    ] as unknown as Order[]);
    vi.mocked(ordersApi.list).mockResolvedValueOnce([
      { id: 3, status: "ACTIVE" },
      { id: 4, status: "ACTIVE" },
      { id: 5, status: "COMPLETED" },
    ] as unknown as Order[]);
    vi.mocked(reportsApi.commission).mockResolvedValue({
      items: [],
      // 2026-11-05 口径：工作台「我的收益」取 total.payable（本人应付分润），
      // 不是整单利润基数 profit_base。给两者不同值，反证不会误取利润基数。
      total: { order_count: 1, profit_base: "999.99", payable: "123.45", paid: "0.00", difference: "0.00" },
    });
    renderLight(<DashboardPage />, { user: "operator" });

    await waitFor(() => expect(ordersApi.list).toHaveBeenCalledWith({ mine: true }));
    const orderCard = (await screen.findByText("我的订单")).closest(".ui-stat") as HTMLElement;
    const totalCard = (await screen.findByText("订单总量")).closest(".ui-stat") as HTMLElement;
    const earningsCard = screen.getByText("我的收益").closest(".ui-stat") as HTMLElement;
    expect(within(orderCard).getByText("2")).toBeInTheDocument();
    expect(within(totalCard).getByText("3")).toBeInTheDocument();
    expect(within(earningsCard).getByText("123.45")).toBeInTheDocument();
    expect(within(earningsCard).queryByText("999.99")).toBeNull();
  });

  it("订单汇总接口失败时业务总览显示占位「-」而非 0", async () => {
    // 经营场景里「0」有确定业务含义；接口失败若渲染成 0，用户会误判为「今天没有业务」。
    vi.mocked(ordersApi.list).mockRejectedValue(new Error("orders down"));
    renderLight(<DashboardPage />, { user: "admin" });
    const totalCard = (await screen.findByText("订单总量")).closest(".ui-stat") as HTMLElement;
    const doneCard = (await screen.findByText("完成订单量")).closest(".ui-stat") as HTMLElement;
    expect(within(totalCard).getByText("-")).toBeInTheDocument();
    expect(within(doneCard).getByText("-")).toBeInTheDocument();
    // 反证：失败态绝不允许回落到 0 计数（改回 String(...length) 本例会红）
    expect(within(totalCard).queryByText("0")).toBeNull();
    expect(within(doneCard).queryByText("0")).toBeNull();
  });

  it("点「代挂」卡打开代挂登记弹窗", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: "代挂" });
    await ui.click(screen.getByRole("button", { name: "代挂" }));
    expect(await screen.findByText("新建代挂订单")).toBeInTheDocument();
  });
});
