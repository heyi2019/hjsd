import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { accounts, setupInventoryWrite } from "@fixtures/inventoryWriteSetup";
import { InventoryRebateModal } from "@/business/shared/rebate";
import type { Account } from "@/shared/api/types/accounts";
import { employeesApi } from "@/shared/api/org.api";
import { orderFormFieldsApi, ordersApi } from "@/shared/api/orders.api";
import { rebatesApi } from "@/shared/api/rebates.api";
import { resolveMock } from "@fixtures/mock-api";
import { allFormFields, seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/profitAllocation.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => { ui = setupInventoryWrite(); });

describe("InventoryRebateModal", () => {
  it("切换返点订单后，旧订单迟到的返点明细不能覆盖当前数据", async () => {
    let finishFirst!: (value: Awaited<ReturnType<typeof rebatesApi.list>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof rebatesApi.list>>>((resolve) => { finishFirst = resolve; });
    const detail = (account: typeof accounts[number]) => ({
      account, orders: [{ order_id: account.source_order_id, order_type: "HS", events: [] }],
    }) as never;
    const rebate = (id: number, orderId: number, amount: string) => ({
      id, rebate_no: `RB${id}`, source_order_id: orderId, rebate_type: "BUY", channel: "买号返点", amount, status: "OPEN", collected_on: "2026-10-17", operator: "管理员",
    }) as never;
    vi.mocked(ordersApi.executionDetail).mockImplementation(async (id) => detail(id === 21 ? accounts[0] : accounts[1]));
    vi.mocked(rebatesApi.list).mockImplementation((params) => params?.source_order_id === 21 ? first : Promise.resolve([rebate(2, 22, "222.00")]));
    const { rerender } = renderLight(<InventoryRebateModal account={accounts[0] as Account} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    await waitFor(() => expect(rebatesApi.list).toHaveBeenCalledWith(expect.objectContaining({ source_order_id: 21 })));
    rerender(<InventoryRebateModal account={accounts[1] as Account} onClose={() => undefined} onCreated={() => undefined} />);
    const table = await screen.findByRole("table", { name: "返点明细表" });
    await waitFor(() => expect(table).toHaveTextContent("222.00"));
    await act(async () => finishFirst([rebate(1, 21, "111.00")]));
    expect(table).toHaveTextContent("222.00");
    expect(table).not.toHaveTextContent("111.00");
  });

  it("返点明细按操作人顺序展示姓名，未知员工回退登记人", async () => {
    vi.mocked(rebatesApi.list).mockResolvedValue([
      { id: 51, rebate_no: "RB51", source_order_id: 21, rebate_type: "BUY", channel: "买号返点", amount: "10.00", status: "OPEN", collected_on: "2026-10-17", operator: "登记人", operator_user_ids: [2, 1, 999] },
      { id: 52, rebate_no: "RB52", source_order_id: 21, rebate_type: "BUY", channel: "买号返点", amount: "20.00", status: "OPEN", collected_on: "2026-10-17", operator: "登记人", operator_user_ids: [999] },
    ] as never);
    renderLight(<InventoryRebateModal account={accounts[0] as Account} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    const table = await screen.findByRole("table", { name: "返点明细表" });
    await waitFor(() => expect(table).toHaveTextContent("小红、管理员"));
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("小红、管理员");
    expect(rows[2]).toHaveTextContent("登记人");
  });

  it("上一单返点保存完成后，不关闭新订单的返点弹窗", async () => {
    seedOrderFormFields();
    let finish!: (value: Awaited<ReturnType<typeof rebatesApi.create>>) => void;
    vi.mocked(rebatesApi.create).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(ordersApi.executionDetail).mockImplementation(async (id) => ({
      account: id === 21 ? accounts[0] : accounts[1], orders: [{ order_id: id, order_type: "HS", events: [] }],
    }) as never);
    vi.mocked(rebatesApi.list).mockResolvedValue([]);
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const { rerender } = renderLight(<InventoryRebateModal account={accounts[0] as Account} onClose={onClose} onCreated={onCreated} />, { user: "admin" });
    const amount = await screen.findByLabelText("返点金额");
    fireEvent.change(amount, { target: { value: "100" } });
    await ui.click(screen.getByRole("button", { name: "确认登记" }));
    await waitFor(() => expect(rebatesApi.create).toHaveBeenCalledTimes(1));
    rerender(<InventoryRebateModal account={accounts[1] as Account} onClose={onClose} onCreated={onCreated} />);
    await waitFor(() => expect(screen.getByText("acc-2")).toBeInTheDocument());
    await act(async () => finish({} as never));
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 1, source_order_id: 21 }));
  });

  it("编辑返点保存中防止重复请求，失败后在弹窗内提示并可重试", async () => {
    let rejectUpdate!: (error: Error) => void;
    vi.mocked(rebatesApi.update).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectUpdate = reject; }));
    renderLight(<InventoryRebateModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    await screen.findByText("返点明细");
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    const modal = (await screen.findByText(/编辑返点 · HS0001-RB01/)).closest(".ant-modal-content") as HTMLElement;
    const form = within(modal).getByRole("button", { name: "保存" }).closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(rebatesApi.update).toHaveBeenCalledTimes(1));
    fireEvent.submit(form);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(rebatesApi.update).toHaveBeenCalledTimes(1);
    expect(within(modal).getByRole("button", { name: /保存/ })).toHaveClass("ant-btn-loading");
    await act(async () => rejectUpdate(new Error("保存失败，请重试")));
    expect(await within(modal).findByText(/保存失败，请重试/)).toBeInTheDocument();
    expect(within(modal).getByRole("button", { name: /保存/ })).not.toHaveClass("ant-btn-loading");
    resolveMock(vi.mocked(rebatesApi.update), { id: 41, rebate_no: "HS0001-RB01", amount: "1200.00" });
    await ui.click(within(modal).getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(rebatesApi.update).toHaveBeenCalledTimes(2));
  });

  it("编辑返点明细后通知上层刷新订单详情与统计（#9）", async () => {
    const onCreated = vi.fn();
    resolveMock(vi.mocked(rebatesApi.update), {
      id: 41, rebate_no: "HS0001-RB01", source_order_id: 21, rebate_type: "BUY",
      amount: "1200.00", status: "OPEN", collected_on: "2026-10-17", operator: "何一",
    });
    renderLight(<InventoryRebateModal account={accounts[0]} onClose={() => undefined} onCreated={onCreated} />, { user: "admin" });
    expect(await screen.findByText("返点明细")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const title = await screen.findByText(/编辑返点 · HS0001-RB01/);
    const editModal = title.closest(".ant-modal-content") as HTMLElement;
    expect(editModal).toBeTruthy();
    // editForm 打开时已用该行返点值预填（金额/日期均合法），直接保存即走 submitEdit 刷新路径。
    // 不依赖 MoneyInput 内部 id：自定义控件可能不转发 id，按 id 定位会拿到 null。
    await userEvent.click(within(editModal).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(rebatesApi.update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("返点不可删除/作废：无删除入口，退回走资金中心录入支出（2026-11-12 裁决）", async () => {
    renderLight(<InventoryRebateModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    expect(await screen.findByText("返点明细")).toBeInTheDocument();

    // 返点明细行只保留「编辑」，不再有「删除」按钮。
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    // 注册接口不再暴露 remove（DELETE /rebates/{id} 已撤销）。
    expect(rebatesApi).not.toHaveProperty("remove");
  });

  it("操作人接口失败时显示错误，不伪造空操作人列表", async () => {
    vi.mocked(employeesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" } as unknown as never);
    renderLight(<InventoryRebateModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ui-error-banner")).toBeTruthy());
  });

  it("提号分销已登记 BUY 后可登记买号返点", async () => {
    seedOrderFormFields();
    resolveMock(vi.mocked(ordersApi.executionDetail), {
      account: accounts[1],
      orders: [{
        order_id: 22, order_no: "TH0002", order_type: "TH", trade_date: "2026-10-15", created_at: "2026-10-15T10:19:00", status: "ACTIVE",
        events: [{ id: 32, event_no: "EV0002", event_type: "BUY", amount: "200.00", occurred_on: "2026-10-15", occurred_at: "2026-10-15T10:20:00", portion: "PRINCIPAL", is_posted: true, operator: "admin" }],
      }],
    });
    renderLight(<InventoryRebateModal account={accounts[1]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    expect(await screen.findByLabelText(/^买号返点/)).toBeChecked();
    expect(screen.getByLabelText(/^卖号返点/)).toBeEnabled();
  });

  it("未售出代挂单可登记卖号返点，不能登记买号返点", async () => {
    seedOrderFormFields();
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { ...accounts[0], inventory_type: "CONSIGNMENT" },
      orders: [{ order_id: 21, order_no: "DG0001", order_type: "DG", status: "ACTIVE", events: [] }],
    } as never);
    renderLight(<InventoryRebateModal account={{ ...accounts[0], inventory_type: "CONSIGNMENT" }} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    expect(await screen.findByLabelText(/^卖号返点/)).toBeChecked();
    expect(screen.getByLabelText(/^卖号返点/)).toBeEnabled();
    expect(screen.getByLabelText(/^买号返点/)).toBeDisabled();
    await ui.type(screen.getByLabelText("返点金额"), "80");
    await ui.click(screen.getByRole("button", { name: "确认登记" }));
    await waitFor(() => expect(rebatesApi.create).toHaveBeenCalledWith(expect.objectContaining({
      source_order_id: 21, rebate_type: "SELL", amount: "80",
    })));
  });

  it("返点配置仅保留卖号选项时默认并提交卖号返点", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => allFormFields()
      .filter((field) => field.order_type_code === scope)
      .map((field) => scope === "INVREBATE" && field.field_key === "rebate_type"
        ? { ...field, options: [{ value: "SELL", label: "卖号返点" }] } : field));
    renderLight(<InventoryRebateModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    expect(await screen.findByLabelText("卖号返点")).toBeChecked();
    await ui.type(screen.getByLabelText("返点金额"), "80");
    await ui.click(screen.getByRole("button", { name: "确认登记" }));
    await waitFor(() => expect(rebatesApi.create).toHaveBeenCalledWith(expect.objectContaining({
      source_order_id: 21, rebate_type: "SELL", amount: "80",
    })));
  });
});
