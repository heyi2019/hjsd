import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Form } from "antd";
import { useRef, useState, type Key } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { accounts, setupInventoryWrite } from "@fixtures/inventoryWriteSetup";
import { InventoryPanel } from "@/business/inventory/InventoryPanel";
import { RecoverySaleModal, PickupSaleModal, ConsignmentSaleModal } from "@/business/shared/sale";
import { InventoryRebateModal } from "@/business/shared/rebate";
import { OrderConsignmentModal } from "@/business/shared/operations/consignment";
import { OrderDetailDeliverySection } from "@/business/shared/order_detail/OrderDetailDeliverySection";
import { OrderDetailProfileSection } from "@/business/shared/order_detail/OrderDetailProfileSection";
import { useOrderDetailEditor } from "@/business/shared/order_detail/editing/use-order-detail-editor";
import { useInventoryList } from "@/business/inventory/InventoryPanel/useInventoryList";
import { useInventoryController } from "@/business/inventory/InventoryPanel/useInventoryController";
import { useExecutionCache } from "@/business/inventory/InventoryPanel/useExecutionCache";
import { useInventoryActions } from "@/business/inventory/InventoryPanel/useInventoryActions";
import type { InventoryOrderRow } from "@/business/inventory/InventoryPanel/types";
import { FieldConfigScope } from "@/shared/forms/ConfigurableField";
import { BusinessRegistrationForm } from "@/shared/ui";
import { appMessage } from "@/shared/ui/appFeedback";

import type { Account } from "@/shared/api/types/accounts";
import { customersApi } from "@/shared/api/customers.api";
import { installmentsApi } from "@/shared/api/installments.api";
import { orderFormFieldsApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { rebatesApi } from "@/shared/api/rebates.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { resolveMock } from "@fixtures/mock-api";
import { allFormFields, seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { inventoryLedgerResponse } from "@fixtures/api-responses";
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

async function loadStandaloneActionExecution(account: Account, isActive: () => boolean) {
  if (account.source_order_id == null) return null;
  const detail = await ordersApi.executionDetail(account.source_order_id);
  return isActive() ? { detail, isCurrent: isActive } : null;
}

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => { ui = setupInventoryWrite(); });

describe("InventoryPanel：写入与长路径", () => {
  it.each([["employee", false], ["operator", true], ["viewer", false]] as const)("%s 库存动作入口与事件及导出权限一致", async (role, allowed) => {
    renderLight(<InventoryPanel />, { user: role });
    const row = (await screen.findByText("acc-1")).closest("tr") as HTMLElement;
    expect(Boolean(within(row).queryByRole("button", { name: "售出" }))).toBe(allowed);
    expect(Boolean(within(row).queryByRole("button", { name: "运营" }))).toBe(allowed);
    expect(Boolean(screen.queryByRole("button", { name: "导出" }))).toBe(allowed);
  });
  it("库存筛选失败时隐藏旧列表和统计，重试后恢复", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByText("acc-1")).toBeVisible();
    vi.mocked(stocksApi.inventoryLedger).mockRejectedValueOnce(new Error("库存筛选失败"));
    await ui.click(screen.getByRole("button", { name: "最旧在前" }));
    expect(await screen.findByText(/库存筛选失败/)).toBeVisible();
    expect(screen.queryByText("acc-1")).not.toBeInTheDocument();
    expect(screen.getByText("库存数据不可用，请点击重新加载")).toBeVisible();
    expect(screen.getByText("在库账号").closest(".ui-stat")).toHaveTextContent("—");
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("acc-1")).toBeVisible();
  });
  it("库存保存时，等待加载的其他账号不能抢走编辑状态", async () => {
    let resolveSecond!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const second = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { resolveSecond = resolve; });
    const snapshot = (account: typeof accounts[number]) => ({ account, orders: [] }) as never;
    const loadEditorExecution = vi.fn((account: Account) => account.id === 2 ? second : Promise.resolve(snapshot(accounts[0])));
    function Probe() {
      const [expanded, setExpanded] = useState<Key[]>([]);
      const [editing, setEditing] = useState<number | null>(null);
      const [, setRows] = useState<InventoryOrderRow[]>([]);
      const [, setError] = useState<{ message: string; code?: string } | null>(null);
      const actions = useInventoryActions({
        load: async () => undefined, setRows, setError,
        loadActionExecution: loadStandaloneActionExecution,
        loadExecution: async () => undefined, loadOrderExecution: async () => null, loadEditorExecution,
        dropExecutionCache: () => undefined, expandTo: setExpanded,
        editorOpenEditor: async (account) => { setEditing(account.id); return true; },
        editorCancelInlineEdit: () => setEditing(null), inlineEditId: editing,
        editorCancelPendingOpen: () => undefined, editorIsSaving: () => false,
        editorSaveInline: async () => undefined,
      });
      return <><button onClick={() => void actions.openEditor(accounts[0] as Account, 21)}>编辑甲</button>
        <button onClick={() => void actions.openEditor(accounts[1] as Account, 22)}>编辑乙</button>
        <button onClick={() => void actions.saveInline()}>保存甲</button>
        <span>{`展开:${expanded.join(",")},编辑:${editing ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑甲" }));
    await screen.findByText("展开:21:1,编辑:1");
    await ui.click(screen.getByRole("button", { name: "编辑乙" }));
    await ui.click(screen.getByRole("button", { name: "保存甲" }));
    await act(async () => resolveSecond(snapshot(accounts[1])));
    expect(screen.getByText("展开:21:1,编辑:1")).toBeInTheDocument();
  });
  it.each(["切换", "取消"])("库存编辑%s后，旧详情不能重新打开原来的账号", async (action) => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { resolveFirst = resolve; });
    const snapshot = (account: typeof accounts[number]) => ({ account, orders: [] }) as never;
    const loadEditorExecution = vi.fn((account: Account) => account.id === 1 ? first : Promise.resolve(snapshot(accounts[1])));
    function Probe() {
      const [expanded, setExpanded] = useState<Key[]>([]);
      const [editing, setEditing] = useState<number | null>(null);
      const [, setRows] = useState<InventoryOrderRow[]>([]);
      const [, setError] = useState<{ message: string; code?: string } | null>(null);
      const actions = useInventoryActions({
        load: async () => undefined, setRows, setError,
        loadActionExecution: loadStandaloneActionExecution,
        loadExecution: async () => undefined, loadOrderExecution: async () => null, loadEditorExecution,
        dropExecutionCache: () => undefined, expandTo: setExpanded,
        editorOpenEditor: async (account) => { setEditing(account.id); return true; },
        editorCancelInlineEdit: () => setEditing(null), inlineEditId: editing,
        editorCancelPendingOpen: () => undefined, editorIsSaving: () => false,
        editorSaveInline: async () => undefined,
      });
      return <><button onClick={() => void actions.openEditor(accounts[0] as Account, 21)}>编辑甲</button>
        <button onClick={() => void actions.openEditor(accounts[1] as Account, 22)}>编辑乙</button>
        <button onClick={actions.cancelInlineEdit}>取消</button>
        <span>{`展开:${expanded.join(",")},编辑:${editing ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑甲" }));
    if (action === "切换") {
      await ui.click(screen.getByRole("button", { name: "编辑乙" }));
      await screen.findByText("展开:22:2,编辑:2");
    } else {
      await ui.click(screen.getByRole("button", { name: "取消" }));
    }
    await act(async () => resolveFirst(snapshot(accounts[0])));
    expect(screen.getByText(action === "切换" ? "展开:22:2,编辑:2" : "展开:,编辑:无")).toBeInTheDocument();
  });

  it("切换编辑账号时，先前加载完成不能将编辑行与账号草稿错配", async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof employeesApi.list>>) => void;
    vi.mocked(employeesApi.list).mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    const detail = { account: accounts[0], orders: [], detail_view: { finance_rows: [] } } as never;
    function EditorProbe() {
      const editor = useOrderDetailEditor({ getExecutionDetail: () => detail, onSaved: vi.fn(), onRefreshFailed: vi.fn() });
      return <><Form form={editor.invEditExtraForm} /><button onClick={() => void editor.openEditor(accounts[0] as Account)}>编辑甲</button>
        <button onClick={() => void editor.openEditor(accounts[1] as Account)}>编辑乙</button>
        <span>{`编辑行:${editor.inlineEditId ?? "无"},草稿:${editor.editingAccount?.id ?? "无"}`}</span></>;
    }
    renderLight(<EditorProbe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑甲" }));
    await ui.click(screen.getByRole("button", { name: "编辑乙" }));
    await screen.findByText("编辑行:2,草稿:2");
    await act(async () => resolveFirst([{ id: 1, username: "admin", display_name: "管理员", is_active: true }]));
    expect(screen.getByText("编辑行:2,草稿:2")).toBeInTheDocument();
  });

  it("取消等待中的详情编辑后，迟到的加载结果不能重新打开编辑", async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof employeesApi.list>>) => void;
    vi.mocked(employeesApi.list).mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    const detail = { account: accounts[0], orders: [], detail_view: { finance_rows: [] } } as never;
    function EditorProbe() {
      const editor = useOrderDetailEditor({ getExecutionDetail: () => detail, onSaved: vi.fn(), onRefreshFailed: vi.fn() });
      return <><Form form={editor.invEditExtraForm} /><button onClick={() => void editor.openEditor(accounts[0] as Account)}>编辑</button>
        <button onClick={editor.cancelInlineEdit}>取消</button>
        <span>{`编辑行:${editor.inlineEditId ?? "无"},草稿:${editor.editingAccount?.id ?? "无"}`}</span></>;
    }
    renderLight(<EditorProbe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    await ui.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => resolveFirst([{ id: 1, username: "admin", display_name: "管理员", is_active: true }]));
    expect(screen.getByText("编辑行:无,草稿:无")).toBeInTheDocument();
  });

  it.each([
    ["执行金额", ""], ["资金明细金额", ""],
    ["执行金额", "10000000000000000.00"], ["资金明细金额", "10000000000000000.00"],
  ])("%s输入 %s 时保存前拦截", async (kind, amount) => {
    const event = { id: 7, event_type: "BUY", amount: "100.00", note: null, occurred_at: "2026-10-01T10:00:00" } as never;
    const detail = { account: accounts[0], orders: [{ events: [event] }], detail_view: { finance_rows: [{ flow_no: "CF7", amount: "100.00", occurred_at: "", note: "" }] } } as never;
    const notify = vi.spyOn(appMessage, "error");
    function Probe() {
      const editor = useOrderDetailEditor({ getExecutionDetail: () => detail, onSaved: vi.fn(), onRefreshFailed: vi.fn() });
      return <><Form form={editor.invEditExtraForm} /><button onClick={() => void editor.openEditor(accounts[0] as Account)}>编辑</button>
        <button onClick={() => kind === "执行金额" ? editor.updateEventDraft(event, { amount }) : editor.updateFinanceDraft("CF7", { amount })}>修改金额</button>
        <button onClick={() => void editor.saveInline()}>保存</button><span>{editor.editingAccount ? "编辑中" : "未编辑"}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByText("编辑中");
    await ui.click(screen.getByRole("button", { name: "修改金额" }));
    await ui.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("请填写有效的金额"));
    expect(ordersApi.updateExecution).not.toHaveBeenCalled();
  });

  it("详情只提交实际修改的账号字段，并携带这些字段的原值用于并发检查", async () => {
    const account = { ...accounts[0], note: "旧备注" } as Account;
    const detail = { account, orders: [], detail_view: { finance_rows: [] } } as never;
    vi.mocked(ordersApi.updateExecution).mockResolvedValue({ ok: true });
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(detail);
    function Probe() {
      const editor = useOrderDetailEditor({ getExecutionDetail: () => detail, onSaved: vi.fn(), onRefreshFailed: vi.fn() });
      return <><Form form={editor.invEditExtraForm} /><button onClick={() => void editor.openEditor(account)}>编辑</button>
        <button onClick={() => editor.updateEditingAccount({ note: "新备注" })}>修改备注</button>
        <button onClick={() => void editor.saveInline()}>保存</button>
        <span>{`编辑:${editor.inlineEditId ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByText("编辑:1");
    await ui.click(screen.getByRole("button", { name: "修改备注" }));
    await ui.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(ordersApi.updateExecution).toHaveBeenCalledWith(21, expect.objectContaining({
      profile: { note: "新备注", form_extra: {} },
      expected_profile: { note: "旧备注", form_extra: {} },
    })));
  });

  it("保存详情时仅提交修改过的资金明细及其实际字段", async () => {
    const detail = { account: accounts[0], orders: [], detail_view: { finance_rows: [
      { flow_no: "CF1", amount: "100.00", pool_id: 1, occurred_at: "", note: "原备注", operator_user_ids: [1] },
      { flow_no: "CF2", amount: "50.00", pool_id: 1, occurred_at: "", note: "", operator_user_ids: [1] },
    ] } } as never;
    vi.mocked(ordersApi.updateExecution).mockResolvedValueOnce({ ok: true });
    function Probe() {
      const editor = useOrderDetailEditor({ getExecutionDetail: () => detail, onSaved: vi.fn(), onRefreshFailed: vi.fn() });
      return <><Form form={editor.invEditExtraForm} /><button onClick={() => void editor.openEditor(accounts[0] as Account)}>编辑</button>
        <button onClick={() => editor.updateFinanceDraft("CF1", { amount: "120.00", pool_id: 3, note: "新备注", operator_user_ids: [2] })}>修改</button>
        <button onClick={() => editor.updateFinanceDraft("CF2", { amount: "50.00" })}>保留</button>
        <button onClick={() => void editor.saveInline()}>保存</button><span>{editor.inlineEditId ? "编辑中" : "未编辑"}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByText("编辑中");
    await ui.click(screen.getByRole("button", { name: "修改" }));
    await ui.click(screen.getByRole("button", { name: "保留" }));
    await ui.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(ordersApi.updateExecution).toHaveBeenCalledWith(21, expect.objectContaining({
      cashflows: [{ flow_no: "CF1", amount: "120.00", pool_id: 3, note: "新备注", operator_user_ids: [2] }],
    })));
  });

  it.each(["保存成功", "保存失败"])("%s前不能切换或取消当前编辑，避免丢失草稿", async (saveResult) => {
    let resolveSave!: (value: { ok: boolean }) => void;
    let rejectSave!: (error: Error) => void;
    vi.mocked(ordersApi.updateExecution).mockReturnValueOnce(new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; }));
    vi.mocked(ordersApi.executionDetail).mockResolvedValueOnce({ account: accounts[0], orders: [] } as never);
    const detail = { account: accounts[0], orders: [], detail_view: { finance_rows: [] } } as never;
    const onSaved = vi.fn();
    const onRefreshFailed = vi.fn();
    function EditorProbe() {
      const editor = useOrderDetailEditor({ getExecutionDetail: () => detail, onSaved, onRefreshFailed });
      return <><Form form={editor.invEditExtraForm} /><button onClick={() => void editor.openEditor(accounts[0] as Account)}>编辑甲</button>
        <button onClick={() => void editor.openEditor(accounts[1] as Account)}>编辑乙</button>
        <button onClick={() => editor.updateEditingAccount({ account_description: "甲的新草稿" })}>修改甲</button>
        <button onClick={editor.cancelInlineEdit}>取消</button>
        <button onClick={() => void editor.saveInline()}>保存</button>
        <span>{`编辑行:${editor.inlineEditId ?? "无"},草稿:${editor.editingAccount?.account_description ?? "无"}`}</span></>;
    }
    renderLight(<EditorProbe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑甲" }));
    await screen.findByText("编辑行:1,草稿:高段位账号");
    await ui.click(screen.getByRole("button", { name: "修改甲" }));
    await ui.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(ordersApi.updateExecution).toHaveBeenCalledTimes(1));
    await ui.click(screen.getByRole("button", { name: "编辑乙" }));
    await ui.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("编辑行:1,草稿:甲的新草稿")).toBeInTheDocument();
    await act(async () => { if (saveResult === "保存失败") rejectSave(new Error("保存失败")); else resolveSave({ ok: true }); });
    if (saveResult === "保存失败") expect(screen.getByText("编辑行:1,草稿:甲的新草稿")).toBeInTheDocument();
    else await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await ui.click(screen.getByRole("button", { name: "编辑乙" }));
    await screen.findByText("编辑行:2,草稿:无");
  });
  it("库存详情预览后编辑会重新取得原图", async () => {
    const original = "data:image/png;base64,original";
    const thumbnail = "data:image/jpeg;base64,thumbnail";
    vi.mocked(ordersApi.executionDetail).mockImplementation(async (_id, options) => ({
      account: { ...accounts[0], account_images: [options?.imagePreviews ? thumbnail : original] },
      image_previews: Boolean(options?.imagePreviews), orders: [],
    }) as never);
    function Probe() {
      const [, setRows] = useState<InventoryOrderRow[]>([]);
      const [, setError] = useState<{ message: string; code?: string } | null>(null);
      const [draft, setDraft] = useState("");
      const removed = useRef(new Set<number>());
      const cache = useExecutionCache({ setRows, setError, locallyRemovedIdsRef: removed });
      return <><button onClick={() => void cache.loadOrderExecution(21)}>展开</button>
        <button onClick={() => void cache.loadEditorExecution(accounts[0] as Account, 21).then((detail) => setDraft(detail?.account.account_images?.[0] ?? ""))}>编辑</button>
        <span>{`预览:${cache.orderExecutionDetails[21]?.account.account_images?.[0] ?? "无"}`}</span><span>{`草稿:${draft}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "展开" }));
    await screen.findByText(`预览:${thumbnail}`);
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByText(`草稿:${original}`);
    expect(ordersApi.executionDetail).toHaveBeenCalledWith(21, { fresh: true });
  });
  it("库存详情预览加载时点击编辑，取得完整详情且旧预览不覆盖", async () => {
    let finishPreview!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    vi.mocked(ordersApi.executionDetail).mockReset()
      .mockReturnValueOnce(new Promise((resolve) => { finishPreview = resolve; }))
      .mockResolvedValueOnce({ account: { ...accounts[0], account_images: ["original"] }, image_previews: false, orders: [] } as never);
    function Probe() {
      const [, setRows] = useState<InventoryOrderRow[]>([]);
      const [, setError] = useState<{ message: string; code?: string } | null>(null);
      const [draft, setDraft] = useState("");
      const removed = useRef(new Set<number>());
      const cache = useExecutionCache({ setRows, setError, locallyRemovedIdsRef: removed });
      return <><button onClick={() => void cache.loadOrderExecution(21)}>展开</button>
        <button onClick={() => void cache.loadEditorExecution(accounts[0] as Account, 21).then((detail) => setDraft(detail?.account.account_images?.[0] ?? ""))}>编辑</button>
        <span>{`草稿:${draft}`}</span><span>{`缓存:${cache.orderExecutionDetails[21]?.account.account_images?.[0] ?? "无"}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "展开" }));
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByText("草稿:original")).toBeInTheDocument();
    await act(async () => finishPreview({ account: { ...accounts[0], account_images: ["thumbnail"] }, image_previews: true, orders: [] } as never));
    expect(screen.getByText("缓存:original")).toBeInTheDocument();
  });

  it.each(["success", "failure"])("库存详情强制刷新后忽略更早请求的%s结果", async (oldResult) => {
    let resolveOld!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    let rejectOld!: (error: Error) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const detail = (description: string) => ({ account: { ...accounts[0], account_description: description }, orders: [] }) as never;
    vi.mocked(ordersApi.executionDetail).mockReturnValueOnce(oldRequest).mockResolvedValueOnce(detail("最新详情"));
    function Probe() {
      const [, setRows] = useState<InventoryOrderRow[]>([]);
      const [error, setError] = useState<{ message: string; code?: string } | null>(null);
      const removed = useRef(new Set<number>());
      const cache = useExecutionCache({ setRows, setError, locallyRemovedIdsRef: removed });
      return <><button onClick={() => void cache.loadOrderExecution(21)}>读取</button>
        <button onClick={() => void cache.loadOrderExecution(21, true)}>刷新</button>
        <span>{cache.orderExecutionDetails[21]?.account.account_description}</span>
        <span>{cache.executionDetails[1]?.account.account_description}</span>
        <span>{error?.message ?? "无错误"}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "读取" }));
    await ui.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(screen.getAllByText("最新详情")).toHaveLength(2));
    await act(async () => { if (oldResult === "failure") rejectOld(new Error("过时请求失败")); else resolveOld(detail("过时详情")); });
    expect(screen.getAllByText("最新详情")).toHaveLength(2);
    expect(screen.queryByText("过时详情")).not.toBeInTheDocument();
    expect(screen.getByText("无错误")).toBeInTheDocument();
  });
  it("库存详情刷新失败后，不会被挂起的旧请求阻止重新加载", async () => {
    vi.mocked(ordersApi.executionDetail).mockReturnValueOnce(new Promise(() => {})).mockRejectedValueOnce(new Error("新请求失败"));
    function Probe() {
      const [, setRows] = useState<InventoryOrderRow[]>([]);
      const [error, setError] = useState<{ message: string; code?: string } | null>(null);
      const removed = useRef(new Set<number>());
      const cache = useExecutionCache({ setRows, setError, locallyRemovedIdsRef: removed });
      return <><button onClick={() => void cache.loadExecution(accounts[0] as Account)}>读取</button>
        <button onClick={() => void cache.loadOrderExecution(21, true)}>刷新</button>
        <span>{cache.executionLoading[1] ? "账号加载中" : "账号未加载"}</span>
        <span>{error?.message}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "读取" }));
    expect(screen.getByText("账号加载中")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByText(/新请求失败/);
    expect(screen.getByText("账号未加载")).toBeInTheDocument();
  });
  it("库存详情缓存失效后，未完成的旧请求不能恢复旧快照", async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    vi.mocked(ordersApi.executionDetail).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    function Probe() {
      const [, setRows] = useState<InventoryOrderRow[]>([]);
      const [, setError] = useState<{ message: string; code?: string } | null>(null);
      const removed = useRef(new Set<number>());
      const cache = useExecutionCache({ setRows, setError, locallyRemovedIdsRef: removed });
      return <><button onClick={() => void cache.loadOrderExecution(21)}>读取</button>
        <button onClick={() => cache.dropExecutionCache(1)}>清除</button>
        <span>{cache.executionDetails[1]?.account.account_description ?? "无缓存"}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "读取" }));
    await ui.click(screen.getByRole("button", { name: "清除" }));
    await act(async () => resolveOld({ account: { ...accounts[0], account_description: "过时详情" }, orders: [] } as never));
    expect(screen.getByText("无缓存")).toBeInTheDocument();
  });
  it("详情编辑的字段配置未加载时禁止直接保存", async () => {
    vi.mocked(orderFormFieldsApi.list).mockRejectedValueOnce(new Error("配置读取失败"));
    vi.mocked(ordersApi.updateExecution).mockResolvedValue({ ok: true });
    const detail = { account: accounts[0], orders: [], detail_view: { finance_rows: [] } } as never;
    function EditorProbe() {
      const editor = useOrderDetailEditor({ getExecutionDetail: () => detail, onSaved: vi.fn(), onRefreshFailed: vi.fn() });
      return <><button onClick={() => void editor.openEditor(accounts[0] as Account)}>编辑</button>
        {editor.editingAccount ? <><BusinessRegistrationForm form={editor.invEditExtraForm}><FieldConfigScope scope="INVEDIT" active><span>详情编辑</span></FieldConfigScope></BusinessRegistrationForm>
          <button onClick={() => void editor.saveInline()}>保存</button></> : null}</>;
    }
    renderLight(<EditorProbe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByText(/字段配置加载失败/);
    await ui.click(screen.getByRole("button", { name: "保存" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(ordersApi.updateExecution).not.toHaveBeenCalled();
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.queryByText(/字段配置加载失败/)).not.toBeInTheDocument());
    await ui.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(ordersApi.updateExecution).toHaveBeenCalledTimes(1));
  });
  it.each(["outside", "inside"])("字段配置失败时%s表单不能提交，重试后恢复", async (placement) => {
    vi.mocked(orderFormFieldsApi.list).mockRejectedValueOnce(new Error("配置读取失败"));
    const submit = vi.fn();
    const content = <><input aria-label="辅助输入" /><button type="submit">提交</button></>;
    const form = placement === "outside"
      ? <FieldConfigScope scope="INVVOID" active><BusinessRegistrationForm onFinish={submit}>{content}</BusinessRegistrationForm></FieldConfigScope>
      : <BusinessRegistrationForm onFinish={submit}><FieldConfigScope scope="INVVOID" active>{content}</FieldConfigScope></BusinessRegistrationForm>;
    renderLight(form, { user: "admin" });
    expect(await screen.findByText(/字段配置加载失败/)).toBeInTheDocument();
    if (placement === "inside") {
      await ui.click(screen.getByRole("button", { name: "提交" }));
      expect(submit).not.toHaveBeenCalled();
    } else {
      expect(screen.queryByRole("button", { name: "提交" })).not.toBeInTheDocument();
    }
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.queryByText(/字段配置加载失败/)).not.toBeInTheDocument());
    await ui.click(await screen.findByRole("button", { name: "提交" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(Object.keys(submit.mock.calls[0][0])).not.toContain("__field_config_ready_INVVOID");
  });
  it("售出移除后切换页面，不因其他页缺少该账号而重新显示旧库存", async () => {
    const stale = inventoryLedgerResponse([{
      account: accounts[0],
      order: { id: 21, order_no: "HS0001", order_type: "HS", account_id: 1, status: "ACTIVE" },
    }]);
    let serverVisible = true;
    vi.mocked(stocksApi.inventoryLedger).mockImplementation(async (params) => (
      params.offset ? inventoryLedgerResponse([], { total: 11 }) : !serverVisible ? inventoryLedgerResponse([]) : stale
    ) as never);
    function ListProbe() {
      const list = useInventoryList({});
      return <><button onClick={() => { list.markLocallyRemoved(1); list.setRows([]); }}>售出</button>
        <button onClick={() => list.setPage(2)}>第二页</button><button onClick={() => list.setPage(1)}>第一页</button>
        <button onClick={() => { serverVisible = false; void list.load(); }}>确认售出</button>
        <button onClick={() => { serverVisible = true; void list.load(); }}>恢复库存</button>
        <span>{list.rows.map((row) => row.account.game_account).join(",")}</span></>;
    }
    renderLight(<ListProbe />, { user: "admin" });
    expect(await screen.findByText("acc-1")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "售出" }));
    await ui.click(screen.getByRole("button", { name: "第二页" }));
    await waitFor(() => expect(stocksApi.inventoryLedger).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 10 })));
    await ui.click(screen.getByRole("button", { name: "第一页" }));
    await waitFor(() => expect(stocksApi.inventoryLedger).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })));
    expect(screen.queryByText("acc-1")).not.toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "确认售出" }));
    await waitFor(() => expect(stocksApi.inventoryLedger).toHaveBeenCalledTimes(4));
    await ui.click(screen.getByRole("button", { name: "恢复库存" }));
    expect(await screen.findByText("acc-1")).toBeInTheDocument();
  });

  it("库存末页售出后回到仍有数据的最后一页", async () => {
    let total = 11;
    const row = (index: number) => ({
      account: accounts[index],
      order: { id: 21 + index, order_no: `HS000${index + 1}`, order_type: "HS", account_id: index + 1, status: "ACTIVE" },
    });
    vi.mocked(stocksApi.inventoryLedger).mockImplementation(async ({ offset }) => (
      inventoryLedgerResponse(offset ? (total > 10 ? [row(1)] : []) : [row(0)], { total })
    ) as never);
    function ListProbe() {
      const list = useInventoryList({});
      return <><button onClick={() => list.setPage(2)}>第二页</button>
        <button onClick={() => { total = 10; void list.load(); }}>售出后刷新</button>
        <span>{`第${list.page}页:${list.rows.map((item) => item.account.game_account).join(",")}`}</span></>;
    }
    renderLight(<ListProbe />, { user: "admin" });
    await screen.findByText("第1页:acc-1");
    await ui.click(screen.getByRole("button", { name: "第二页" }));
    await screen.findByText("第2页:acc-2");
    await ui.click(screen.getByRole("button", { name: "售出后刷新" }));
    await screen.findByText("第1页:acc-1");
  });

  it("库存控制器售出后确认移除，账号重新入库时可以再次显示", async () => {
    const item = {
      account: accounts[0],
      order: { id: 21, order_no: "HS0001", order_type: "HS", account_id: 1, status: "ACTIVE" },
    };
    let serverVisible = true;
    vi.mocked(stocksApi.inventoryLedger).mockImplementation(async () => inventoryLedgerResponse(serverVisible ? [item] : []) as never);
    function ControllerProbe() {
      const controller = useInventoryController({});
      return <><button onClick={() => { serverVisible = false; controller.removeFromInventory(1, 21); void controller.load(); }}>售出</button>
        <button onClick={() => { serverVisible = true; void controller.load(); }}>重新入库</button>
        <span>{`库存:${controller.rows.map((row) => row.account.game_account).join(",")}`}</span></>;
    }
    renderLight(<ControllerProbe />, { user: "admin" });
    await screen.findByText("库存:acc-1");
    await ui.click(screen.getByRole("button", { name: "售出" }));
    await screen.findByText("库存:");
    await waitFor(() => expect(stocksApi.inventoryLedger).toHaveBeenCalledTimes(2));
    await ui.click(screen.getByRole("button", { name: "重新入库" }));
    await screen.findByText("库存:acc-1");
  });

  it("库存写入完成时按当前筛选刷新，不恢复提交前的旧列表", async () => {
    const row = (index: number) => ({
      account: accounts[index],
      order: { id: 21 + index, order_no: `HS000${index + 1}`, order_type: "HS", account_id: index + 1, status: "ACTIVE" },
    });
    vi.mocked(stocksApi.inventoryLedger).mockImplementation(async ({ sort_desc }) => (
      inventoryLedgerResponse([row(sort_desc ? 0 : 1)])
    ) as never);
    function ListProbe() {
      const list = useInventoryList({});
      const pendingRefresh = useRef<(() => Promise<void>) | undefined>(undefined);
      return <><button onClick={() => { pendingRefresh.current = list.load; }}>开始写入</button>
        <button onClick={() => list.setSortDesc(false)}>切换排序</button>
        <button onClick={() => void pendingRefresh.current?.()}>写入完成</button>
        <span>{`库存:${list.rows.map((item) => item.account.game_account).join(",")}`}</span></>;
    }
    renderLight(<ListProbe />, { user: "admin" });
    await screen.findByText("库存:acc-1");
    await ui.click(screen.getByRole("button", { name: "开始写入" }));
    await ui.click(screen.getByRole("button", { name: "切换排序" }));
    await screen.findByText("库存:acc-2");
    await ui.click(screen.getByRole("button", { name: "写入完成" }));
    await waitFor(() => expect(stocksApi.inventoryLedger).toHaveBeenLastCalledWith(expect.objectContaining({ sort_desc: false })));
    expect(screen.getByText("库存:acc-2")).toBeInTheDocument();
  });

  it("重新进入库存时先恢复第一页和默认库龄，再发一次请求", async () => {
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse([], { total: 11 }) as never);
    function ListProbe({ active }: { active: boolean }) {
      const list = useInventoryList({ active, initialAgeGtDays: 30 });
      return <><button onClick={() => list.setAgeGtDays(7)}>选择库龄</button>
        <button onClick={() => list.setPage(2)}>第二页</button></>;
    }
    const view = renderLight(<ListProbe active />, { user: "admin" });
    await waitFor(() => expect(stocksApi.inventoryLedger).toHaveBeenCalledWith(expect.objectContaining({ age_gt_days: 30, offset: 0 })));
    await ui.click(screen.getByRole("button", { name: "选择库龄" }));
    await ui.click(screen.getByRole("button", { name: "第二页" }));
    await waitFor(() => expect(stocksApi.inventoryLedger).toHaveBeenLastCalledWith(expect.objectContaining({ age_gt_days: 7, offset: 10 })));
    view.rerender(<ListProbe active={false} />);
    vi.mocked(stocksApi.inventoryLedger).mockClear();
    view.rerender(<ListProbe active />);
    await waitFor(() => expect(stocksApi.inventoryLedger).toHaveBeenCalledWith(expect.objectContaining({ age_gt_days: 30, offset: 0 })));
    expect(stocksApi.inventoryLedger).toHaveBeenCalledTimes(1);
  });
  it.each(["success", "failure"])("库存筛选切换后忽略较旧请求的%s结果", async (oldResult) => {
    let resolveOld!: (value: Awaited<ReturnType<typeof stocksApi.inventoryLedger>>) => void;
    let rejectOld!: (error: Error) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof stocksApi.inventoryLedger>>>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    vi.mocked(stocksApi.inventoryLedger).mockReturnValueOnce(oldRequest).mockResolvedValueOnce(inventoryLedgerResponse([{
      account: { ...accounts[0], game_account: "新结果" },
      order: { id: 21, order_no: "HS0001", order_type: "HS", account_id: 1, status: "ACTIVE" },
    }], { stats: { account_count: 1, occupied_cost: "100", over_7d_count: 0, over_30d_count: 0 } }) as never);
    function ListProbe() {
      const list = useInventoryList({});
      return <><button onClick={() => list.setKeyword("新条件")}>筛选</button>
        <span>{list.rows.map((row) => row.account.game_account).join(",")}</span>
        <span>{list.error?.message ?? "无错误"}</span></>;
    }
    renderLight(<ListProbe />, { user: "admin" });
    await waitFor(() => expect(stocksApi.inventoryLedger).toHaveBeenCalledTimes(1));
    await ui.click(screen.getByRole("button", { name: "筛选" }));
    expect(await screen.findByText("新结果")).toBeInTheDocument();
    await act(async () => {
      if (oldResult === "failure") rejectOld(new Error("旧请求失败"));
      else resolveOld(inventoryLedgerResponse([{ account: { ...accounts[0], game_account: "旧结果" }, order: { id: 21, order_no: "HS0001", order_type: "HS", account_id: 1, status: "ACTIVE" } }]) as never);
    });
    expect(screen.getByText("新结果")).toBeInTheDocument();
    expect(screen.getByText("无错误")).toBeInTheDocument();
    expect(screen.queryByText("旧结果")).not.toBeInTheDocument();
  });
  it("详情保存成功但刷新失败时清除已保存草稿并作废旧详情", async () => {
    const detail = { account: accounts[0], orders: [], detail_view: { finance_rows: [] } } as never;
    const refreshFailed = vi.fn();
    vi.mocked(ordersApi.updateExecution).mockResolvedValue({ ok: true });
    vi.mocked(ordersApi.executionDetail).mockRejectedValue(new Error("刷新失败"));
    function EditorProbe() {
      const editor = useOrderDetailEditor({ getExecutionDetail: () => detail, onSaved: vi.fn(), onRefreshFailed: refreshFailed });
      return <>
        <Form form={editor.invEditExtraForm} />
        <button onClick={() => void editor.openEditor(accounts[0] as Account)}>编辑</button>
        <button onClick={() => editor.addOperationDraft("DESCRIPTION")}>新增描述</button>
        <button onClick={() => editor.updateOperationDraft(Object.keys(editor.operationDrafts)[0], { occurred_at: "2026-11-20T10:00:00" })}>填写时间</button>
        <button onClick={() => void editor.saveInline()}>保存</button>
        <span>{editor.inlineEditId == null ? "未编辑" : "编辑中"}</span>
        <span>{Object.keys(editor.operationDrafts).length}</span>
      </>;
    }
    renderLight(<EditorProbe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByText("编辑中");
    await ui.click(screen.getByRole("button", { name: "新增描述" }));
    await ui.click(screen.getByRole("button", { name: "填写时间" }));
    await ui.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(refreshFailed).toHaveBeenCalledWith(1, 21));
    expect(screen.getByText("未编辑")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "保存" }));
    expect(ordersApi.updateExecution).toHaveBeenCalledTimes(1);
  });
  it("详情写入失败时保留草稿供重试", async () => {
    const detail = { account: accounts[0], orders: [], detail_view: { finance_rows: [] } } as never;
    const refreshFailed = vi.fn();
    vi.mocked(ordersApi.updateExecution).mockRejectedValueOnce(new Error("保存失败"));
    function EditorProbe() {
      const editor = useOrderDetailEditor({ getExecutionDetail: () => detail, onSaved: vi.fn(), onRefreshFailed: refreshFailed });
      return <>
        <Form form={editor.invEditExtraForm} />
        <button onClick={() => void editor.openEditor(accounts[0] as Account)}>编辑</button>
        <button onClick={() => editor.updateEditingAccount({ account_description: "修改的描述" })}>修改</button>
        <button onClick={() => void editor.saveInline()}>保存</button>
        <span>{editor.editingAccount?.account_description ?? "无草稿"}</span>
      </>;
    }
    renderLight(<EditorProbe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "编辑" }));
    await ui.click(screen.getByRole("button", { name: "修改" }));
    await ui.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(ordersApi.updateExecution).toHaveBeenCalledTimes(1));
    expect(screen.getByText("修改的描述")).toBeInTheDocument();
    expect(refreshFailed).not.toHaveBeenCalled();
  });
  it("代挂在库账号不再提供独立取消入口", async () => {
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse([{
      account: { ...accounts[0], inventory_type: "CONSIGNMENT" },
      order: {
        id: 21,
        order_no: "DG-2026-0001",
        order_type: "DG",
        trade_date: "2026-10-15",
        account_id: 1,
        account_status: "WAITING",
        status: "ACTIVE",
      },
    }], {
      type_counts: { CONSIGNMENT: 1 },
      game_types: ["王者荣耀"],
      stats: { account_count: 1, occupied_cost: "0.00", over_7d_count: 0, over_30d_count: 0 },
    }) as never);

    renderLight(<InventoryPanel />, { user: "admin" });
    const row = await screen.findByText("acc-1");
    expect(within(row.closest("tr") as HTMLElement).queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("切换库存资金收支后，较早的请求不能打开其他订单", async () => {
    let finishFirst!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { finishFirst = resolve; });
    const secondAccount = { ...accounts[1], status: "WAITING" };
    const detail = (account: typeof accounts[number], orderId: number, orderNo: string) => ({
      account, orders: [{ order_id: orderId, order_no: orderNo, events: [], cashflows: [] }],
    }) as never;
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse([
      { account: accounts[0], order: { id: 21, order_no: "HS0001", order_type: "HS", trade_date: "2026-10-15", account_id: 1, account_status: "WAITING", status: "ACTIVE" } },
      { account: secondAccount, order: { id: 22, order_no: "TH0002", order_type: "TH", trade_date: "2026-10-15", account_id: 2, account_status: "WAITING", status: "ACTIVE" } },
    ]) as never);
    vi.mocked(ordersApi.executionDetail).mockImplementation((id) => id === 21 ? first : Promise.resolve(detail(secondAccount, 22, "TH0002")));
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "资金收支" }));
    await ui.click(within(screen.getByText("acc-2").closest("tr")!).getByRole("button", { name: "资金收支" }));
    const second = await screen.findByRole("dialog", { name: /资金收支 · TH0002/ });
    fireEvent.change(within(second).getByLabelText("金额"), { target: { value: "200" } });
    await act(async () => finishFirst(detail(accounts[0], 21, "HS0001")));
    expect(screen.queryByRole("dialog", { name: /资金收支 · HS0001/ })).toBeNull();
    expect(within(second).getByLabelText("金额")).toHaveValue("200");
  });

  it("关闭库存资金收支后，较早的请求不能重新打开弹窗", async () => {
    let finishFirst!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { finishFirst = resolve; });
    const detail = (account: typeof accounts[number], id: number, orderNo: string) => ({
      account, orders: [{ order_id: id, order_no: orderNo, events: [], cashflows: [] }],
    }) as never;
    vi.mocked(ordersApi.executionDetail).mockImplementation((id) => id === 21 ? first : Promise.resolve(detail(accounts[1], 22, "TH0002")));
    function Probe() {
      const [expanded, setExpanded] = useState<Key[]>([]);
      const [, setRows] = useState<InventoryOrderRow[]>([]);
      const [, setError] = useState<{ message: string; code?: string } | null>(null);
      const actions = useInventoryActions({
        load: async () => undefined, setRows, setError,
        loadActionExecution: loadStandaloneActionExecution,
        loadExecution: async () => undefined, loadOrderExecution: async () => null, loadEditorExecution: async () => null,
        dropExecutionCache: () => undefined, expandTo: setExpanded,
        editorOpenEditor: async () => true,
        editorCancelInlineEdit: () => undefined, editorCancelPendingOpen: () => undefined,
        editorIsSaving: () => false, editorSaveInline: async () => undefined, inlineEditId: null,
      });
      return <><button onClick={() => void actions.openCashflow(accounts[0] as Account)}>打开甲</button>
        <button onClick={() => void actions.openCashflow(accounts[1] as Account)}>打开乙</button>
        <button onClick={actions.closeCashflow}>关闭</button>
        <span>{actions.cashflowTarget?.orderNo ?? "未打开"}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "打开乙" }));
    await screen.findByText("TH0002");
    await ui.click(screen.getByRole("button", { name: "打开甲" }));
    await ui.click(screen.getByRole("button", { name: "关闭" }));
    await act(async () => finishFirst(detail(accounts[0], 21, "HS0001")));
    expect(screen.getByText("未打开")).toBeInTheDocument();
  });

  it("库存中心资金收支与订单台账展示同一订单的资金明细和操作人", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");

    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "资金收支" }));

    const modal = await screen.findByRole("dialog", { name: /资金收支 · HS0001/ });
    expect(within(modal).getByText("资金明细")).toBeInTheDocument();
    expect(within(modal).getByRole("table", { name: "资金明细表" })).toHaveTextContent("支出");
    expect(within(modal).getByRole("table", { name: "资金明细表" })).toHaveTextContent("100.00");
    expect(within(modal).getByRole("table", { name: "资金明细表" })).toHaveTextContent("admin");
    expect(within(modal).getByLabelText("操作人")).toBeInTheDocument();
  });

  it.each(["取消", "资金收支", "下架"])("打开库存%s时读取最新订单详情，不沿用之前展开的缓存", async (action) => {
    const detail = (amount: string, platform: string) => ({
      account: accounts[0],
      orders: [{
        order_id: 21, order_no: "HS0001", order_type: "HS", status: "ACTIVE",
        active_consignments: [{ event_id: 32, platform, price: null, listed_at: "2026-10-15T10:00:00" }],
        cashflows: [{ flow_no: "CF0001", occurred_on: "2026-10-15", direction: "OUT", amount }],
        events: [
          { id: 31, event_type: "BUY", amount, cancellable_amount: amount, portion: "PRINCIPAL", is_posted: true },
          { id: 32, event_type: "OPERATE", operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: [platform], listed_at: "2026-10-15T10:00" } },
        ],
      }],
    }) as never;
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(detail("100.00", "千寻"));
    renderLight(<InventoryPanel />, { user: "admin" });
    const row = (await screen.findByText("acc-1")).closest("tr")!;
    fireEvent.click(row.querySelector(".ant-table-row-expand-icon") as Element);
    await screen.findByText("千寻");
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(detail("250.00", "盼之"));

    if (action === "下架") {
      await ui.click(within(row).getByRole("button", { name: "运营" }));
      await ui.click(within(await screen.findByRole("menu")).getByText("下架"));
      const modal = await screen.findByRole("dialog", { name: "下架" });
      expect(await within(modal).findByText("盼之")).toBeInTheDocument();
      expect(within(modal).queryByText("千寻")).toBeNull();
    } else {
      await ui.click(within(row).getByRole("button", { name: action }));
      const modal = await screen.findByRole("dialog", { name: action === "取消" ? /取消入库登记/ : /资金收支/ });
      if (action === "取消") expect(within(modal).getByLabelText("退回金额")).toHaveValue("250.00");
      else expect(within(modal).getByRole("table", { name: "资金明细表" })).toHaveTextContent("250.00");
    }
  });

  it.each([
    { change: "新增上架", before: false, after: true },
    { change: "取消上架", before: true, after: false },
  ])("库存运营菜单：$change 后显示当前可执行动作", async ({ before, after }) => {
    const detail = (listed: boolean) => ({ account: accounts[0], orders: [{
      order_id: 21, order_no: "HS0001", order_type: "HS", status: "ACTIVE",
      active_consignments: listed ? [{ event_id: 32, platform: "千寻", price: null, listed_at: "2026-10-15T10:00:00" }] : [],
      events: listed ? [{ id: 32, event_type: "OPERATE", operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["千寻"] } }] : [],
    }] }) as never;
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(detail(before));
    renderLight(<InventoryPanel />, { user: "admin" });
    const row = (await screen.findByText("acc-1")).closest("tr")!;
    fireEvent.click(row.querySelector(".ant-table-row-expand-icon") as Element);
    await screen.findByText("运营信息");
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(detail(after));

    await ui.click(within(row).getByRole("button", { name: "运营" }));
    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      if (after) expect(within(menu).getByText("下架")).toBeInTheDocument();
      else expect(within(menu).queryByText("下架")).toBeNull();
    });
    const section = document.querySelector<HTMLElement>(".order-detail__section--operation")!;
    await waitFor(() => {
      if (after) expect(within(section).getByText("千寻")).toBeInTheDocument();
      else expect(within(section).queryByText("千寻")).toBeNull();
    });
  });

  it.each(["订单详情", "资金账户", "过时请求失败"])("库存资金收支等待%s期间详情被刷新，仍使用最新流水", async (pending) => {
    let finishDetail!: (value: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    let rejectDetail!: (error: Error) => void;
    let finishPools!: (value: Awaited<ReturnType<typeof poolsApi.list>>) => void;
    const delayedDetail = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve, reject) => { finishDetail = resolve; rejectDetail = reject; });
    const delayedPools = new Promise<Awaited<ReturnType<typeof poolsApi.list>>>((resolve) => { finishPools = resolve; });
    const detail = (amount: string) => ({ account: accounts[0], orders: [{
      order_id: 21, order_no: "HS0001", events: [],
      cashflows: [{ flow_no: "CF0001", occurred_on: "2026-10-15", direction: "OUT", amount }],
    }] }) as never;
    if (pending !== "资金账户") vi.mocked(ordersApi.executionDetail).mockReturnValueOnce(delayedDetail).mockResolvedValue(detail("250.00"));
    else {
      vi.mocked(ordersApi.executionDetail).mockResolvedValueOnce(detail("100.00")).mockResolvedValue(detail("250.00"));
      vi.mocked(poolsApi.list).mockReturnValueOnce(delayedPools);
    }
    function Probe() {
      const [, setRows] = useState<InventoryOrderRow[]>([]);
      const [error, setError] = useState<{ message: string; code?: string } | null>(null);
      const removed = useRef(new Set<number>());
      const cache = useExecutionCache({ setRows, setError, locallyRemovedIdsRef: removed });
      const actions = useInventoryActions({
        ...cache, load: async () => undefined, setRows, setError,
        editorOpenEditor: async () => true, editorCancelInlineEdit: () => undefined,
        editorCancelPendingOpen: () => undefined, editorIsSaving: () => false,
        editorSaveInline: async () => undefined, inlineEditId: null,
      });
      return <><button onClick={() => void actions.openCashflow(accounts[0] as Account)}>资金收支</button>
        <button onClick={() => cache.refreshExecution(accounts[0] as Account)}>刷新</button>
        <span data-testid="opened-amount">{actions.cashflowTarget?.cashflows?.[0]?.amount ?? "未打开"}</span>
        <span data-testid="cached-amount">{cache.executionDetails[1]?.orders[0]?.cashflows?.[0]?.amount ?? "无缓存"}</span>
        <span data-testid="action-error">{error?.message ?? "无错误"}</span>
        <Form form={actions.voidForm} /></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "资金收支" }));
    await waitFor(() => expect(ordersApi.executionDetail).toHaveBeenCalledTimes(1));
    await ui.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(ordersApi.executionDetail).toHaveBeenCalledWith(21, { imagePreviews: true, fresh: true }));
    await waitFor(() => expect(screen.getByTestId("cached-amount")).toHaveTextContent("250.00"));
    await act(async () => {
      if (pending === "订单详情") finishDetail(detail("100.00"));
      else if (pending === "资金账户") finishPools([{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }] as never);
      else rejectDetail(new Error("过时请求失败"));
    });
    await waitFor(() => expect(screen.getByTestId("opened-amount")).toHaveTextContent("250.00"));
    expect(screen.getByTestId("cached-amount")).toHaveTextContent("250.00");
    expect(screen.getByTestId("action-error")).toHaveTextContent("无错误");
  });

  it("库存退款金额拒绝超过两位小数", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: accounts[0], orders: [{ order_id: 21, events: [{ id: 101, event_type: "BUY", amount: "100.00", cancellable_amount: "100.00", portion: "PRINCIPAL", is_posted: true }] }] } as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "取消" }));
    const modal = await screen.findByRole("dialog", { name: /取消入库登记/ });
    fireEvent.change(within(modal).getByLabelText("退回金额"), { target: { value: "1.234" } });
    await ui.type(within(modal).getByLabelText("取消原因"), "测试退款");
    await ui.click(within(modal).getByRole("button", { name: "确认冲销" }));
    expect(await within(modal).findByText("退回金额必须是数字，最多两位小数")).toBeInTheDocument();
    expect(ordersApi.inventoryOffsale).not.toHaveBeenCalled();
  });

  it("库存退款大额超过剩余一分时提示并阻止提交", async () => {
    const amount = "9999999999999999.98";
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: accounts[0], orders: [{ order_id: 21, events: [{ id: 101, event_type: "BUY", amount, cancellable_amount: amount, portion: "PRINCIPAL", is_posted: true }] }] } as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "取消" }));
    const modal = await screen.findByRole("dialog", { name: /取消入库登记/ });
    const input = within(modal).getByLabelText("退回金额");
    await ui.clear(input);
    await ui.type(input, "9999999999999999.99");
    await ui.type(within(modal).getByLabelText("取消原因"), "测试退款");
    await ui.click(within(modal).getByRole("button", { name: "确认冲销" }));
    expect(await within(modal).findByText("退回金额不能超过 ¥9,999,999,999,999,999.98")).toBeInTheDocument();
    expect(ordersApi.inventoryOffsale).not.toHaveBeenCalled();
  });

  it("连续取消不同库存订单时，旧详情不能覆盖订单和退款金额", async () => {
    let finishFirst!: (detail: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { finishFirst = resolve; });
    const secondAccount = { ...accounts[1], status: "WAITING" };
    const detail = (account: typeof accounts[number], orderId: number, eventId: number, amount: string) => ({
      account, orders: [{ order_id: orderId, events: [{ id: eventId, event_type: "BUY", amount, cancellable_amount: amount, portion: "PRINCIPAL", is_posted: true }] }],
    }) as never;
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse([
      { account: accounts[0], order: { id: 21, order_no: "HS0001", order_type: "HS", trade_date: "2026-10-15", account_id: 1, account_status: "WAITING", status: "ACTIVE" } },
      { account: secondAccount, order: { id: 22, order_no: "TH0002", order_type: "TH", trade_date: "2026-10-15", account_id: 2, account_status: "WAITING", status: "ACTIVE" } },
    ]) as never);
    vi.mocked(ordersApi.executionDetail).mockImplementation((id) => id === 21 ? first : Promise.resolve(detail(secondAccount, 22, 202, "250.00")));
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "取消" }));
    await ui.click(within(screen.getByText("acc-2").closest("tr")!).getByRole("button", { name: "取消" }));
    const modal = await screen.findByRole("dialog", { name: /取消入库登记/ });
    expect(within(modal).getByLabelText("退回金额")).toHaveValue("250.00");
    fireEvent.change(within(modal).getByLabelText("取消原因"), { target: { value: "第二单" } });
    await act(async () => finishFirst(detail(accounts[0], 21, 101, "100.00")));
    expect(modal).toHaveAccessibleName("取消入库登记 · TH-2026-0002");
    expect(within(modal).getByLabelText("退回金额")).toHaveValue("250.00");
    expect(within(modal).getByLabelText("取消原因")).toHaveValue("第二单");
    await ui.click(within(modal).getByLabelText("收款账户"));
    await ui.click(await screen.findByText("利润池", { selector: ".ant-select-item-option-content" }));
    await ui.click(within(modal).getByRole("button", { name: "确认冲销" }));
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(22, expect.objectContaining({ amount: "250.00", offset_event_id: 202, reason: "第二单" })));
  });

  it("库存取消详情加载期间切换到售出，迟到的取消结果不能打断新操作", async () => {
    let finishFirst!: (detail: Awaited<ReturnType<typeof ordersApi.executionDetail>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof ordersApi.executionDetail>>>((resolve) => { finishFirst = resolve; });
    const secondAccount = { ...accounts[1], status: "WAITING" };
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse([
      { account: accounts[0], order: { id: 21, order_no: "HS0001", order_type: "HS", trade_date: "2026-10-15", account_id: 1, account_status: "WAITING", status: "ACTIVE" } },
      { account: secondAccount, order: { id: 22, order_no: "TH0002", order_type: "TH", trade_date: "2026-10-15", account_id: 2, account_status: "WAITING", status: "ACTIVE" } },
    ]) as never);
    vi.mocked(ordersApi.executionDetail).mockImplementation((id) => id === 21 ? first : Promise.resolve({ account: secondAccount, orders: [] } as never));
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "取消" }));
    await ui.click(within(screen.getByText("acc-2").closest("tr")!).getByRole("button", { name: "售出" }));
    expect(await screen.findByRole("dialog", { name: "售出提号账号" })).toBeInTheDocument();
    await act(async () => finishFirst({ account: accounts[0], orders: [{ order_id: 21, events: [] }] } as never));
    expect(screen.queryByRole("dialog", { name: /取消入库登记/ })).toBeNull();
    expect(screen.getByRole("dialog", { name: "售出提号账号" })).toBeInTheDocument();
  });

  it("库存取消提交中重复确认只发送一次", async () => {
    let finish!: (value: Awaited<ReturnType<typeof ordersApi.inventoryOffsale>>) => void;
    vi.mocked(ordersApi.inventoryOffsale).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: accounts[0], orders: [{ order_id: 21, events: [] }] } as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "取消" }));
    const modal = await screen.findByRole("dialog", { name: /取消入库登记/ });
    fireEvent.change(within(modal).getByLabelText("取消原因"), { target: { value: "取消交易" } });
    const form = within(modal).getByLabelText("取消原因").closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledTimes(1));
    fireEvent.submit(form);
    await act(async () => { await Promise.resolve(); });
    expect(ordersApi.inventoryOffsale).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
  });

  it("旧库存取消失败时不会把错误写进新的页面操作", async () => {
    let fail!: (error: Error) => void;
    vi.mocked(ordersApi.inventoryOffsale).mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: accounts[0], orders: [{ order_id: 21, events: [] }] } as never);
    const setError = vi.fn();
    const notifyError = vi.spyOn(appMessage, "error");
    function Probe() {
      const [expanded, setExpanded] = useState<Key[]>([]);
      const [, setRows] = useState<InventoryOrderRow[]>([]);
      const actions = useInventoryActions({
        load: async () => undefined, setRows, setError,
        loadActionExecution: loadStandaloneActionExecution,
        loadExecution: async () => undefined, loadOrderExecution: async () => null, loadEditorExecution: async () => null,
        dropExecutionCache: () => undefined, expandTo: setExpanded,
        editorOpenEditor: async () => true,
        editorCancelInlineEdit: () => undefined, editorCancelPendingOpen: () => undefined,
        editorIsSaving: () => false, editorSaveInline: async () => undefined, inlineEditId: null,
      });
      return <><button onClick={() => void actions.openVoid(accounts[0] as Account)}>取消甲</button>
        <button onClick={() => void actions.submitVoid({ amount: "0", pool_id: 3, reason: "取消交易" })}>确认</button>
        <button onClick={actions.invalidatePendingActions}>切换操作</button>
        <span>{actions.voidTarget ? "已打开取消" : "未打开取消"}</span><Form form={actions.voidForm} /></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "取消甲" }));
    await screen.findByText("已打开取消");
    await ui.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledTimes(1));
    await ui.click(screen.getByRole("button", { name: "切换操作" }));
    await act(async () => fail(new Error("取消失败")));
    expect(setError).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/HS-2026-0001：.*取消失败/));
    notifyError.mockRestore();
  });

  it("库存编辑直接展开详情，账户资料保持只读", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("button", { name: "保存修改" })).toBeInTheDocument();
    expect(screen.queryByLabelText("编辑游戏账号/产品")).toBeNull();
  });

  it("库存编辑可分别重试员工和资金账户，并在资金明细中选择加载的账户", async () => {
    vi.mocked(employeesApi.list).mockRejectedValue(new Error("员工加载失败"));
    vi.mocked(poolsApi.list).mockRejectedValue(new Error("账户加载失败"));
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: accounts[0],
      orders: [{ order_id: 21, order_no: "HS0001", order_type: "HS", status: "ACTIVE", events: [] }],
      detail_view: { operation_rows: [], finance_rows: [{ key: "CF1", flow_no: "CF1", type: "成本", direction: "支出", amount: "100.00", occurred_at: "2026-10-15T10:20:00", pool_id: 1, pool_name: "原账户", note: "", operator: "admin" }], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] },
    } as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "编辑" }));
    await screen.findByRole("button", { name: "保存修改" });
    expect(screen.getByText(/员工目录加载失败/)).toBeVisible();
    expect(screen.getByText(/资金账户加载失败/)).toBeVisible();
    vi.mocked(employeesApi.list).mockResolvedValue([{ id: 2, username: "staff", display_name: "员工甲", is_active: true }] as never);
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 1, name: "原账户", status: "ACTIVE" }, { id: 2, name: "新账户", status: "ACTIVE" }] as never);
    await ui.click(screen.getByRole("button", { name: "重试员工" }));
    await ui.click(screen.getByRole("button", { name: "重试资金账户" }));
    await waitFor(() => expect(screen.queryByText(/资金账户加载失败/)).not.toBeInTheDocument());
    expect(screen.queryByText(/员工目录加载失败/)).not.toBeInTheDocument();
    await ui.click(screen.getByRole("combobox", { name: "编辑资金明细资金账户 CF1" }));
    expect(await screen.findByText("新账户", { selector: ".ant-select-item-option-content" })).toBeVisible();
  });

  it("库存编辑加载并保存自定义字段，不把它当作建单账号字段", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => [
      ...allFormFields().filter((field) => field.order_type_code === scope),
      ...(scope === "INVEDIT" ? [{ id: 9001, order_type_code: scope, field_key: "check_note", label: "核对凭据", field_type: "TEXT", options: [], required: true, is_active: true, sort_order: 99, locked: false, is_custom: true, section: "EXTRA", note: null }] : []),
    ] as never);
    vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
    const account = { ...accounts[0], extra_values: { check_note: "原凭据" } };
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account, orders: [{ order_id: 21, order_no: "HS-2026-0001", order_type: "HS", status: "ACTIVE", note: "原订单备注", extra_values: { bound_phone_owner: "原绑定人" }, events: [] }],
      detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] },
    } as never);
    vi.mocked(ordersApi.updateExecution).mockResolvedValue({ ok: true });
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "编辑" }));
    const input = await screen.findByLabelText("核对凭据");
    expect(input).toHaveValue("原凭据");
    await ui.clear(input);
    await ui.type(input, "新凭据");
    const owner = screen.getByLabelText("编辑手机号绑定人");
    await ui.clear(owner);
    await ui.type(owner, "新绑定人");
    await ui.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(ordersApi.updateExecution).toHaveBeenCalledWith(21, expect.objectContaining({
      profile: expect.objectContaining({ form_extra: { check_note: "新凭据" } }),
    })));
    const payload = vi.mocked(ordersApi.updateExecution).mock.calls[0][1];
    const profile = payload.profile as { extra_values?: Record<string, unknown> } | undefined;
    expect(profile?.extra_values ?? {}).not.toHaveProperty("check_note");
    expect(payload.orders).toEqual([expect.objectContaining({ order_id: 21, form_extra: { bound_phone_owner: "新绑定人" } })]);
    expect(payload.orders?.[0]).not.toHaveProperty("note");
  });

  it("首次编辑库存账号只读取一次来源订单详情", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");

    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "编辑" }));

    await screen.findByRole("button", { name: "保存修改" });
    expect(ordersApi.executionDetail).toHaveBeenCalledTimes(1);
    expect(ordersApi.executionDetail).toHaveBeenCalledWith(21, { fresh: true });
  });

  it("上架提交保留大额寄售价精度", async () => {
    const detail = { account: accounts[0], orders: [{ order_id: 21, order_no: "HS0001", order_type: "HS", trade_date: "2026-10-15", status: "ACTIVE", events: [], active_consignments: [] }] };
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(detail as never);
    renderLight(<OrderConsignmentModal account={accounts[0] as never} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    const platform = await screen.findByRole("combobox", { name: "寄售平台" });
    await waitFor(() => expect(platform).toBeEnabled());
    await ui.click(platform);
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByRole("spinbutton", { name: "寄售价格" }), "9999999999999999.99");
    await ui.click(screen.getByRole("button", { name: "确认上架" }));
    await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledWith(21, expect.objectContaining({ form_extra: expect.objectContaining({ consignment_price: "9999999999999999.99" }) })));
  });

  it("寄售平台词典加载失败时提示并允许重试", async () => {
    const consoleError = vi.spyOn(console, "error");
    vi.mocked(optionSetsApi.list).mockRejectedValueOnce(new Error("网络失败"));
    const detail = { account: accounts[0], orders: [{ order_id: 21, order_no: "HS0001", order_type: "HS", trade_date: "2026-10-15", status: "ACTIVE", events: [], active_consignments: [] }] };
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(detail as never);
    renderLight(<OrderConsignmentModal account={accounts[0] as never} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    expect(await screen.findByText("选项词典加载失败，请重新加载")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认上架" })).toBeDisabled();
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByRole("combobox", { name: "寄售平台" })).toBeEnabled();
    expect(screen.queryByText("选项词典加载失败，请重新加载")).toBeNull();
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("[antd: Form.Item]");
    consoleError.mockRestore();
  });

  it("寄售提交成功后无需等详情刷新即可通知页面关闭", async () => {
    const detail = { account: accounts[0], orders: [{ order_id: 21, order_no: "HS0001", order_type: "HS", trade_date: "2026-10-15", status: "ACTIVE", events: [], active_consignments: [] }] };
    let finish!: (value: never) => void;
    const slowRefresh = new Promise<never>((resolve) => { finish = resolve; });
    vi.mocked(ordersApi.executionDetail).mockResolvedValueOnce(detail as never).mockReturnValueOnce(slowRefresh);
    const onCreated = vi.fn();
    renderLight(<OrderConsignmentModal account={accounts[0] as never} onClose={() => undefined} onCreated={onCreated} />, { user: "admin" });
    const platform = await screen.findByRole("combobox", { name: "寄售平台" });
    await waitFor(() => expect(platform).toBeEnabled());
    await ui.click(platform);
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: "确认上架" }));
    await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    await act(async () => { finish(detail as never); await slowRefresh; });
  });

  it("上架重复提交只写一次，旧订单完成后不关闭新订单", async () => {
    seedOrderFormFields();
    let finish!: (value: Awaited<ReturnType<typeof ordersApi.postEvent>>) => void;
    vi.mocked(ordersApi.postEvent).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(ordersApi.executionDetail).mockImplementation(async (id) => ({
      account: id === 21 ? accounts[0] : accounts[1],
      orders: [{ order_id: id, order_no: `HS${id}`, order_type: "HS", status: "ACTIVE", events: [], active_consignments: [] }],
    }) as never);
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const { rerender } = renderLight(<OrderConsignmentModal account={accounts[0] as Account} onClose={onClose} onCreated={onCreated} />, { user: "admin" });
    const platform = await screen.findByRole("combobox", { name: "寄售平台" });
    await waitFor(() => expect(platform).toBeEnabled());
    await ui.click(platform);
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    const form = platform.closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledTimes(1));
    fireEvent.submit(form);
    await act(async () => { await Promise.resolve(); });
    expect(ordersApi.postEvent).toHaveBeenCalledTimes(1);
    rerender(<OrderConsignmentModal account={accounts[1] as Account} onClose={onClose} onCreated={onCreated} />);
    await screen.findByText("acc-2");
    await act(async () => finish({} as never));
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 1, source_order_id: 21 }), 21);
  });

  it("寄售登记到来源订单，不创建 DG 代挂订单", async () => {
    vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({ FINANCE: "上架补充资料" });
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => [
      ...allFormFields().filter((field) => field.order_type_code === scope),
      ...(scope === "CONSIGN" ? [{ id: 9000, order_type_code: scope, field_key: "platform_ids", label: "寄售平台",
        field_type: "MULTI_SELECT", required: true, is_active: true, sort_order: 1, locked: false, is_custom: false },
        { id: 9001, order_type_code: scope, field_key: "receipt", label: "上架凭据",
        field_type: "TEXT", required: false, required_when: { field: "platform_ids", op: "filled" }, is_active: true, sort_order: 99, locked: false, is_custom: true,
        section: "FINANCE" }, { id: 9002, order_type_code: scope, field_key: "optional_number", label: "上架附加数字",
        field_type: "NUMBER", required: false, is_active: true, sort_order: 100, locked: false, is_custom: true,
        section: "BUSINESS" }] : []),
    ] as never);
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "运营" }));
    await ui.click(screen.getByRole("menuitem", { name: "寄售（上架）" }));
    expect(await screen.findByText("登记寄售")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "操作人" }).closest(".ant-select")).toHaveTextContent("管理员"));

    await ui.click(screen.getAllByRole("combobox", { name: "寄售平台" })[0]);
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: "确认上架" }));
    expect(await screen.findByText("上架凭据必填")).toBeInTheDocument();
    expect(ordersApi.postEvent).not.toHaveBeenCalled();
    await ui.type(await screen.findByLabelText("上架凭据"), "寄售凭据");
    expect(await screen.findByText("上架补充资料")).toBeInTheDocument();
    await ui.type(screen.getByLabelText("上架附加数字"), "17");
    await ui.clear(screen.getByLabelText("上架附加数字"));
    await ui.click(screen.getByRole("button", { name: "确认上架" }));

    await waitFor(() => expect(vi.mocked(ordersApi.postEvent)).toHaveBeenCalledWith(21, expect.objectContaining({
      event_type: "OPERATE",
      operation_type: "CONSIGNMENT",
      form_extra_scope: "CONSIGN",
      operator_user_ids: [1],
      form_extra: expect.objectContaining({ receipt: "寄售凭据" }),
    })));
    expect(vi.mocked(ordersApi.postEvent).mock.calls[0][1].form_extra).not.toHaveProperty("optional_number");
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
  });

  it("返点登记进行中不能重复提交", async () => {
    vi.mocked(rebatesApi.create).mockReturnValue(new Promise(() => {}));
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "返点" }));
    await ui.type(await screen.findByLabelText("返点金额"), "350");
    const form = screen.getByLabelText("返点金额").closest("form")!;
    await act(async () => { fireEvent.submit(form); });
    await waitFor(() => expect(rebatesApi.create).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.submit(form); });
    expect(rebatesApi.create).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "确认登记" })).toHaveClass("ant-btn-loading");
  });

  it("返点按买入与售出订单区分类型并登记", async () => {
    vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({ FINANCE: "返点补充资料" });
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => [
      ...allFormFields().filter((field) => field.order_type_code === scope),
      ...(scope === "INVREBATE" ? [{ id: 9001, order_type_code: scope, field_key: "receipt", label: "返点凭据",
        field_type: "TEXT", required: true, is_active: true, sort_order: 99, locked: false, is_custom: true,
        section: "FINANCE" }, { id: 9002, order_type_code: scope, field_key: "optional_number", label: "返点附加数字",
        field_type: "NUMBER", required: false, is_active: true, sort_order: 100, locked: false, is_custom: true,
        section: "BUSINESS" }] : []),
    ] as never);
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "返点" }));
    expect(await screen.findByText("登记返点")).toBeInTheDocument();
    const receipt = await screen.findByLabelText("返点凭据");
    expect(await screen.findByText("返点补充资料")).toBeInTheDocument();
    expect(screen.queryByLabelText("返点日期")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("返点比例")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "比例" })).not.toBeInTheDocument();
    expect(screen.queryByText(/关联业务订单创建后即可登记返点/)).toBeNull();
    expect(await screen.findByLabelText(/^买号返点/)).toBeChecked();
    expect(screen.getByLabelText(/^卖号返点/)).toBeEnabled();
    await ui.click(screen.getByLabelText(/^卖号返点/));
    expect(screen.getByLabelText(/^买号返点/)).not.toBeChecked();
    expect(screen.getByLabelText(/^卖号返点/)).toBeChecked();
    await ui.click(screen.getByLabelText(/^买号返点/));
    expect(screen.getByLabelText(/^买号返点/)).toBeChecked();
    expect(screen.getByLabelText(/^卖号返点/)).not.toBeChecked();
    await ui.click(screen.getByLabelText(/^卖号返点/));
    await ui.clear(screen.getByLabelText("返点金额"));
    await ui.type(screen.getByLabelText("返点金额"), "350.00");
    await ui.type(receipt, "返点凭据A");
    await ui.type(screen.getByLabelText("返点附加数字"), "17");
    await ui.clear(screen.getByLabelText("返点附加数字"));
    await ui.click(screen.getByRole("button", { name: "确认登记" }));

    await waitFor(() => expect(vi.mocked(rebatesApi.create)).toHaveBeenCalled());
    expect(vi.mocked(rebatesApi.create).mock.calls[0][0]).toMatchObject({
      source_order_id: 21,
      rebate_type: "SELL",
      amount: "350.00",
      channel: "卖号返点",
      form_extra: { receipt: "返点凭据A" },
    });
    expect(vi.mocked(rebatesApi.create).mock.calls[0][0].form_extra).toEqual({ receipt: "返点凭据A" });
  });


});
