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
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() => expect(catalog.ordersApi.list).toHaveBeenCalledTimes(2));
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

  it("点「代分期服务」卡打开代分期登记弹窗", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: "代分期服务" });
    await ui.click(screen.getByRole("button", { name: "代分期服务" }));
    expect(await screen.findByText("新建代分期订单")).toBeInTheDocument();
  });
});
