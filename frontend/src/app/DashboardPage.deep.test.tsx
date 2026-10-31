import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { DashboardPage } from "./DashboardPage";
import * as catalog from "../shared/api/catalog";
import type { Order } from "../shared/api/catalog";

vi.mock("../shared/api/catalog");

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([]);
  vi.mocked(catalog.reportsApi.commission).mockResolvedValue({
    items: [],
    total: { order_count: 0, profit_base: "0.00", payable: "0.00", paid: "0.00", difference: "0.00" },
  });
});

describe("DashboardPage.deep：失败路径/计数/未覆盖入口", () => {
  it("加载失败展示错误横幅", async () => {
    vi.mocked(catalog.ordersApi.list).mockRejectedValue(new Error("orders down"));
    renderLight(<DashboardPage />, { user: "admin" });
    expect((await screen.findAllByText(/orders down/)).length).toBeGreaterThan(0);
  });

  it("错误横幅重试：点「重新加载」再次请求列表", async () => {
    vi.mocked(catalog.ordersApi.list).mockRejectedValue(new Error("orders down"));
    renderLight(<DashboardPage />, { user: "admin" });
    expect(await screen.findAllByText(/orders down/)).toBeTruthy();
    await ui.click(screen.getAllByRole("button", { name: /重新加载/ })[0]);
    await waitFor(() => expect(catalog.ordersApi.list).toHaveBeenCalledTimes(4));
  });

  it("今日关注计数：ACTIVE 与 非ACTIVE 两分支", async () => {
    const orders = [
      { id: 1, status: "ACTIVE" },
      { id: 2, status: "CLOSED" },
      { id: 3, status: "CLOSED" },
    ] as unknown as Order[];
    vi.mocked(catalog.ordersApi.list).mockResolvedValue(orders);
    renderLight(<DashboardPage />, { user: "admin" });
    const activeCard = (await screen.findByText("进行中业务")).closest(".ui-stat") as HTMLElement;
    const doneCard = (await screen.findByText("已完成业务")).closest(".ui-stat") as HTMLElement;
    expect(within(activeCard).getByText("1")).toBeInTheDocument();
    expect(within(doneCard).getByText("2")).toBeInTheDocument();
  });

  it("我的关注卡片展示当前登录用户的订单数与分润收益", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValueOnce([
      { id: 1, status: "ACTIVE" },
      { id: 2, status: "COMPLETED" },
    ] as unknown as Order[]);
    vi.mocked(catalog.ordersApi.list).mockResolvedValueOnce([
      { id: 3, status: "ACTIVE" },
      { id: 4, status: "ACTIVE" },
      { id: 5, status: "COMPLETED" },
    ] as unknown as Order[]);
    vi.mocked(catalog.reportsApi.commission).mockResolvedValue({
      items: [],
      total: { order_count: 1, profit_base: "123.45", payable: "0.00", paid: "0.00", difference: "0.00" },
    });
    renderLight(<DashboardPage />, { user: "operator" });

    await waitFor(() => expect(catalog.ordersApi.list).toHaveBeenCalledWith({ mine: true }));
    const orderCard = (await screen.findByText("我的订单")).closest(".ui-stat") as HTMLElement;
    const activeCard = (await screen.findByText("进行中业务")).closest(".ui-stat") as HTMLElement;
    const earningsCard = screen.getByText("我的收益").closest(".ui-stat") as HTMLElement;
    expect(within(orderCard).getByText("2")).toBeInTheDocument();
    expect(within(activeCard).getByText("2")).toBeInTheDocument();
    expect(within(earningsCard).getByText("123.45")).toBeInTheDocument();
  });

  it("汇总接口失败时「今日关注」显示占位「-」而非 0", async () => {
    // 经营场景里「0」有确定业务含义；接口失败若渲染成 0，用户会误判为「今天没有业务」。
    vi.mocked(catalog.ordersApi.list).mockRejectedValue(new Error("orders down"));
    renderLight(<DashboardPage />, { user: "admin" });
    const activeCard = (await screen.findByText("进行中业务")).closest(".ui-stat") as HTMLElement;
    const doneCard = (await screen.findByText("已完成业务")).closest(".ui-stat") as HTMLElement;
    expect(within(activeCard).getByText("-")).toBeInTheDocument();
    expect(within(doneCard).getByText("-")).toBeInTheDocument();
    // 反证：失败态绝不允许回落到 0 计数（改回 String(...length) 本例会红）
    expect(within(activeCard).queryByText("0")).toBeNull();
    expect(within(doneCard).queryByText("0")).toBeNull();
  });

  it("点「代挂」卡打开代挂登记弹窗", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: "代挂" });
    await ui.click(screen.getByRole("button", { name: "代挂" }));
    expect(await screen.findByText("新建代挂订单")).toBeInTheDocument();
  });
});
