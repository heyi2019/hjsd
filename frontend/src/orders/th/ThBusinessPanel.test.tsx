import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";
import { ThBusinessPanel } from "./ThBusinessPanel";
import * as catalog from "../../shared/api/catalog";
import type { Order } from "../../shared/api/catalog";

vi.mock("../../shared/api/catalog");

const orders: Order[] = [
  { id: 1, order_no: "TH-001", order_type: "TH", trade_date: "2026-10-01", status: "ACTIVE", note: null } as unknown as Order,
  { id: 2, order_no: "HS-001", order_type: "HS", trade_date: "2026-10-02", status: "ACTIVE", note: null } as unknown as Order,
];

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.ordersApi.list).mockResolvedValue(orders);
});

describe("ThBusinessPanel：分销·提号", () => {
  it("仅展示提号(TH)订单", async () => {
    renderLight(<ThBusinessPanel />, { user: "admin" });
    expect(await screen.findByText("TH-001")).toBeInTheDocument();
    expect(screen.queryByText("HS-001")).not.toBeInTheDocument();
  });

  it("加载失败展示错误横幅", async () => {
    vi.mocked(catalog.ordersApi.list).mockRejectedValue(new Error("orders down"));
    renderLight(<ThBusinessPanel />, { user: "admin" });
    expect(await screen.findByText(/orders down/)).toBeInTheDocument();
  });

  it("点击新建提号打开创建弹窗", async () => {
    renderLight(<ThBusinessPanel />, { user: "admin" });
    await screen.findByText("TH-001");
    await ui.click(screen.getByRole("button", { name: /新建提号/ }));
    // CreateBusinessModal 按 initialOrderType=TH 渲染标题「新建提号订单」
    await waitFor(() => expect(screen.getByText("新建提号订单")).toBeInTheDocument());
  });
});
