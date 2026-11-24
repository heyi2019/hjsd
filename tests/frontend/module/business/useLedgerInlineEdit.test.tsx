import { act, screen, waitFor } from "@testing-library/react";
import { Form } from "antd";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLedgerInlineEdit } from "@/business/orders/useLedgerInlineEdit";
import { ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import type { Order } from "@/shared/api/types/orders";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { renderLight } from "@fixtures/render";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";

vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/options.api");

const order1: Order = { id: 1, order_no: "HS-2026-0001", order_type: "HS", trade_date: "2026-10-01", status: "ACTIVE", business_mode: "SELF", account_id: 5 };
let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  seedOrderFormFields();
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(employeesApi.list).mockResolvedValue([]);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
});

describe("useLedgerInlineEdit", () => {
  it("订单预览使用缩略图，进入编辑前重新读取原图", async () => {
    const original = "data:image/png;base64,original";
    const preview = "data:image/jpeg;base64,thumbnail";
    const selected = { ...order1, id: 1, account_id: 1 };
    vi.mocked(ordersApi.executionDetail).mockImplementation(async (_id, options) => ({
      account: { id: 1, source_order_id: 1, account_images: [options?.imagePreviews ? preview : original] },
      image_previews: Boolean(options?.imagePreviews),
      orders: [],
    }) as never);
    function Probe() {
      const ledger = useLedgerInlineEdit();
      return <><Form form={ledger.invEditExtraForm} /><button onClick={() => void ledger.loadLedgerOrderDetail(1)}>展开</button>
        <button onClick={() => void ledger.openLedgerEditor(selected)}>编辑</button>
        <span>{`预览:${ledger.ledgerOrderDetails[1]?.account.account_images?.[0] ?? "无"}`}</span>
        <span>{`草稿:${ledger.editingAccount?.account_images?.[0] ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "展开" }));
    await screen.findByText(`预览:${preview}`);
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByText(`草稿:${original}`);
    expect(ordersApi.executionDetail).toHaveBeenCalledWith(1, { imagePreviews: true });
    expect(ordersApi.executionDetail).toHaveBeenCalledWith(1, { fresh: true });
  });
  it("订单保存失败后，之前等待加载的其他订单不能覆盖当前草稿", async () => {
    let resolveSecond!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const second = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { resolveSecond = resolve; });
    const firstOrder = { ...order1, id: 1, account_id: 1 };
    const secondOrder = { ...order1, id: 2, account_id: 2 };
    const snapshot = (id: number) => ({ account: { id, source_order_id: id }, orders: [], detail_view: { finance_rows: [] } }) as never;
    vi.mocked(ordersApi.executionDetail).mockImplementation((id) => id === 2 ? second : Promise.resolve(snapshot(1)));
    vi.mocked(ordersApi.updateExecution).mockRejectedValueOnce(new Error("保存失败"));
    function Probe() {
      const ledger = useLedgerInlineEdit();
      return <><Form form={ledger.invEditExtraForm} /><button onClick={() => void ledger.openLedgerEditor(firstOrder)}>编辑甲</button>
        <button onClick={() => void ledger.openLedgerEditor(secondOrder)}>编辑乙</button>
        <button onClick={() => ledger.updateEditingAccount({ account_description: "甲的草稿" })}>修改甲</button>
        <button onClick={() => void ledger.saveInline()}>保存甲</button>
        <span>{`编辑:${ledger.inlineEditId ?? "无"},草稿:${ledger.editingAccount?.account_description ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑甲" }));
    await screen.findByText("编辑:1,草稿:无");
    await ui.click(screen.getByRole("button", { name: "修改甲" }));
    await ui.click(screen.getByRole("button", { name: "编辑乙" }));
    await ui.click(screen.getByRole("button", { name: "保存甲" }));
    await waitFor(() => expect(ordersApi.updateExecution).toHaveBeenCalledTimes(1));
    await act(async () => resolveSecond(snapshot(2)));
    expect(screen.getByText("编辑:1,草稿:甲的草稿")).toBeInTheDocument();
  });
  it("订单台账连续编辑不同行时，只打开最后选择的订单", async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { resolveFirst = resolve; });
    const firstOrder = { ...order1, id: 1, account_id: 1 };
    const secondOrder = { ...order1, id: 2, account_id: 2 };
    const snapshot = (id: number) => ({ account: { id, source_order_id: id }, orders: [] }) as never;
    vi.mocked(ordersApi.executionDetail).mockImplementation((id) => id === 1 ? first : Promise.resolve(snapshot(2)));
    function Probe() {
      const ledger = useLedgerInlineEdit();
      return <><Form form={ledger.invEditExtraForm} /><button onClick={() => void ledger.openLedgerEditor(firstOrder)}>编辑甲</button>
        <button onClick={() => void ledger.openLedgerEditor(secondOrder)}>编辑乙</button>
        <span>{`展开:${ledger.expandedOrderIds.join(",")},编辑:${ledger.inlineEditId ?? "无"},草稿:${ledger.editingAccount?.id ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑甲" }));
    await ui.click(screen.getByRole("button", { name: "编辑乙" }));
    await screen.findByText("展开:2,编辑:2,草稿:2");
    await act(async () => resolveFirst(snapshot(1)));
    expect(screen.getByText("展开:2,编辑:2,草稿:2")).toBeInTheDocument();
  });

  it("订单台账切换展开行后，待加载的编辑不能抢回展开状态", async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { resolveFirst = resolve; });
    const firstOrder = { ...order1, id: 1, account_id: 1 };
    const secondOrder = { ...order1, id: 2, account_id: 2 };
    const snapshot = (id: number) => ({ account: { id, source_order_id: id }, orders: [] }) as never;
    vi.mocked(ordersApi.executionDetail).mockImplementation((id) => id === 1 ? first : Promise.resolve(snapshot(2)));
    function Probe() {
      const ledger = useLedgerInlineEdit();
      return <><Form form={ledger.invEditExtraForm} /><button onClick={() => void ledger.openLedgerEditor(firstOrder)}>编辑甲</button>
        <button onClick={() => ledger.handleLedgerExpand(true, secondOrder)}>展开乙</button>
        <span>{`展开:${ledger.expandedOrderIds.join(",")},编辑:${ledger.inlineEditId ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑甲" }));
    await ui.click(screen.getByRole("button", { name: "展开乙" }));
    await screen.findByText("展开:2,编辑:无");
    await act(async () => resolveFirst(snapshot(1)));
    expect(screen.getByText("展开:2,编辑:无")).toBeInTheDocument();
  });
  it.each(["success", "failure"])("订单详情强制刷新后忽略更早请求的%s结果", async (oldResult) => {
    let resolveOld!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    let rejectOld!: (error: Error) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const detail = (description: string) => ({ account: { id: 1, account_description: description }, orders: [] }) as never;
    vi.mocked(ordersApi.executionDetail).mockReturnValueOnce(oldRequest).mockResolvedValueOnce(detail("最新详情"));
    function Probe() {
      const ledger = useLedgerInlineEdit();
      return <><button onClick={() => void ledger.loadLedgerOrderDetail(1)}>读取</button>
        <button onClick={() => void ledger.loadLedgerOrderDetail(1, true)}>刷新</button>
        <span>{ledger.ledgerOrderDetails[1]?.account.account_description}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "读取" }));
    await ui.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("最新详情")).toBeInTheDocument();
    await act(async () => { if (oldResult === "failure") rejectOld(new Error("过时请求失败")); else resolveOld(detail("过时详情")); });
    expect(screen.getByText("最新详情")).toBeInTheDocument();
    expect(screen.queryByText("过时详情")).not.toBeInTheDocument();
    expect(message.error).not.toHaveBeenCalled();
  });
  it("详情刷新失败后丢弃旧缓存，且不收起后来展开的其他订单", async () => {
    let firstCalls = 0;
    const snapshot = (id: number, description: string) => ({ account: { id, account_description: description }, orders: [] }) as never;
    vi.mocked(ordersApi.executionDetail).mockImplementation(async (id) => {
      if (id !== 1) return snapshot(2, "订单乙");
      firstCalls += 1;
      if (firstCalls === 2) throw new Error("刷新失败");
      return snapshot(1, firstCalls === 1 ? "旧详情" : "重试详情");
    });
    function Probe() {
      const ledger = useLedgerInlineEdit();
      return <><button onClick={() => ledger.handleLedgerExpand(true, { ...order1, id: 1, account_id: 1 })}>展开甲</button>
        <button onClick={() => ledger.handleLedgerExpand(true, { ...order1, id: 2, account_id: 2 })}>展开乙</button>
        <button onClick={() => void ledger.refreshCachedLedgerDetail(1)}>刷新甲</button>
        <span>{`展开:${ledger.expandedOrderIds.join(",")},甲:${ledger.ledgerOrderDetails[1]?.account.account_description ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "展开甲" }));
    await screen.findByText("展开:1,甲:旧详情");
    await ui.click(screen.getByRole("button", { name: "展开乙" }));
    await screen.findByText("展开:2,甲:旧详情");
    await ui.click(screen.getByRole("button", { name: "刷新甲" }));
    await screen.findByText("展开:2,甲:无");
    await ui.click(screen.getByRole("button", { name: "展开甲" }));
    await screen.findByText("展开:1,甲:重试详情");
  });
});
