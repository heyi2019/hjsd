import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "@/shared/api/catalog";
import type { Order } from "@/shared/api/catalog";
import { renderLight } from "@fixtures/render";
import { ThBusinessPanel } from "@/orders/th/ThBusinessPanel";

// 受控桩：仅渲染 open 为 true 时的两个触发按钮，用于验证父组件的 onClose/onCreated 接线
vi.mock("@/orders/CreateBusinessModal", () => ({
  CreateBusinessModal: ({
    open,
    onClose,
    onCreated,
  }: {
    open: boolean;
    onClose: () => void;
    onCreated?: () => void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="create-modal">
        <button onClick={() => onClose()}>桩关闭</button>
        <button onClick={() => onCreated && onCreated()}>桩已创建</button>
      </div>
    );
  },
}));

vi.mock("@/shared/api/catalog");

const baseOrders: Order[] = [
  { id: 1, order_no: "TH-001", order_type: "TH", trade_date: "2026-10-01", status: "ACTIVE", note: null } as unknown as Order,
  { id: 2, order_no: "HS-001", order_type: "HS", trade_date: "2026-10-02", status: "ACTIVE", note: null } as unknown as Order,
];

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.ordersApi.list).mockResolvedValue(baseOrders);
});

describe("ThBusinessPanel.deep：错误处理/列渲染/弹窗接线", () => {
  it("备注列有值时直接显示该文本（不走 '-' 兜底）", async () => {
    const withNote = [
      { id: 3, order_no: "TH-002", order_type: "TH", trade_date: "2026-10-03", status: "DONE", note: "已结算" } as unknown as Order,
    ];
    vi.mocked(catalog.ordersApi.list).mockResolvedValue(withNote);
    renderLight(<ThBusinessPanel />, { user: "admin" });
    expect(await screen.findByText("TH-002")).toBeInTheDocument();
    expect(screen.getByText("已结算")).toBeInTheDocument();
    // 该订单行「备注」列不显示兜底 '-'
    const row = (screen.getByText("TH-002").closest("tr")) as HTMLElement;
    expect(row).not.toHaveTextContent("—");
  });

  it("加载失败后点「重新加载」触发 onRetry 二次请求", async () => {
    vi.mocked(catalog.ordersApi.list).mockRejectedValueOnce(new Error("th down"));
    renderLight(<ThBusinessPanel />, { user: "admin" });
    expect(await screen.findByText(/th down/)).toBeInTheDocument();
    expect(vi.mocked(catalog.ordersApi.list)).toHaveBeenCalledTimes(1);
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() =>
      expect(vi.mocked(catalog.ordersApi.list)).toHaveBeenCalledTimes(2),
    );
  });

  it("点击新建提号打开弹窗（open 置真）", async () => {
    renderLight(<ThBusinessPanel />, { user: "admin" });
    await screen.findByText("TH-001");
    expect(screen.queryByTestId("create-modal")).toBeNull();
    await ui.click(screen.getByRole("button", { name: /新建提号/ }));
    expect(await screen.findByTestId("create-modal")).toBeInTheDocument();
  });

  it("弹窗 onClose 关闭（open 置假）", async () => {
    renderLight(<ThBusinessPanel />, { user: "admin" });
    await screen.findByText("TH-001");
    await ui.click(screen.getByRole("button", { name: /新建提号/ }));
    expect(await screen.findByTestId("create-modal")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /桩关闭/ }));
    await waitFor(() => expect(screen.queryByTestId("create-modal")).toBeNull());
  });

  it("弹窗 onCreated 关闭并触发二次 load", async () => {
    renderLight(<ThBusinessPanel />, { user: "admin" });
    await screen.findByText("TH-001");
    expect(vi.mocked(catalog.ordersApi.list)).toHaveBeenCalledTimes(1);
    await ui.click(screen.getByRole("button", { name: /新建提号/ }));
    const modal = await screen.findByTestId("create-modal");
    await ui.click(within(modal).getByRole("button", { name: /桩已创建/ }));
    await waitFor(() => expect(screen.queryByTestId("create-modal")).toBeNull());
    await waitFor(() =>
      expect(vi.mocked(catalog.ordersApi.list)).toHaveBeenCalledTimes(2),
    );
  });
});
