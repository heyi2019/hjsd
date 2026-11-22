import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Form } from "antd";
import { useRef, useState, type Key } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { InventoryPanel } from "@/business/inventory/InventoryPanel";
import { InventoryDeleteDialog } from "@/business/inventory/InventoryPanel/InventoryDeleteDialog";
import { RecoverySaleModal, PickupSaleModal, ConsignmentSaleModal } from "@/business/shared/sale";
import { InventoryRebateModal } from "@/business/shared/rebate";
import { OrderConsignmentModal } from "@/business/shared/operations/consignment";
import { OrderDetailDeliverySection } from "@/business/shared/order-detail/OrderDetailDeliverySection";
import { OrderDetailProfileSection } from "@/business/shared/order-detail/OrderDetailProfileSection";
import { useOrderDetailEditor } from "@/business/shared/order-detail/editing/use-order-detail-editor";
import { useInventoryList } from "@/business/inventory/InventoryPanel/useInventoryList";
import { useExecutionCache } from "@/business/inventory/InventoryPanel/useExecutionCache";
import { useInventoryActions } from "@/business/inventory/InventoryPanel/useInventoryActions";
import type { InventoryOrderRow } from "@/business/inventory/InventoryPanel/types";
import { FieldConfigScope } from "@/shared/forms/ConfigurableField";
import { BusinessRegistrationForm } from "@/shared/ui";
import { appMessage } from "@/shared/ui/appFeedback";

import type { Account } from "@/shared/api/types/accounts";
import { counterpartiesApi, customersApi } from "@/shared/api/customers.api";
import { installmentsApi } from "@/shared/api/installments.api";
import { orderFormFieldsApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { rebatesApi } from "@/shared/api/rebates.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { resolveMock } from "@fixtures/mock-api";
import { allFormFields, seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { inventoryLedgerResponse } from "@fixtures/api-responses";
import { clearOptionSetsCache } from "@/shared/lib/optionSets";
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
vi.mock("@/shared/api/stocks.api");;

const accounts = [
  { id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "A平台", status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, source_order_id: 22, source_order_no: "TH-2026-0002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

async function loadStandaloneActionExecution(account: Account, isActive: () => boolean) {
  if (account.source_order_id == null) return null;
  const detail = await ordersApi.executionDetail(account.source_order_id);
  return isActive() ? { detail, isCurrent: isActive } : null;
}

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  clearOptionSetsCache();
  vi.clearAllMocks();
  vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
  seedOptionSets();
  vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse([{
      account: accounts[0],
      order: {
        id: 21,
        order_no: "HS-2026-0001",
        order_type: "HS",
        trade_date: "2026-10-15",
        account_id: 1,
        account_status: "WAITING",
        status: "ACTIVE",
      },
    }], {
      type_counts: { RECOVERY: 1 },
      game_types: ["王者荣耀"],
      stats: { account_count: 1, occupied_cost: "100.00", over_7d_count: 0, over_30d_count: 0 },
    }) as never);
  resolveMock(vi.mocked(ordersApi.create), { id: 21 });
  resolveMock(vi.mocked(ordersApi.postEvent), {});
  resolveMock(vi.mocked(ordersApi.stockSale), {});
  resolveMock(vi.mocked(ordersApi.addCustomerRole), { id: 21 });
  resolveMock(vi.mocked(customersApi.page), { items: [{ id: 7, display_name: "买家A", status: "ACTIVE" }], total: 1, limit: 500, offset: 0 });
  vi.mocked(customersApi.options).mockResolvedValue([{ id: 7, customer_no: "C0007", display_name: "买家A" }]);
  resolveMock(vi.mocked(poolsApi.list), [{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }]);
  vi.mocked(counterpartiesApi.list).mockResolvedValue([]);
  resolveMock(vi.mocked(rebatesApi.create), { id: 31 });
  vi.mocked(rebatesApi.list).mockResolvedValue([{
    id: 41,
    rebate_no: "HS0001-RB01",
    source_order_id: 21,
    rebate_type: "BUY",
    channel: "买号返点",
    amount: "1000.00",
    status: "OPEN",
    collected_on: "2026-10-17",
    operator: "何一",
  }] as never);
  resolveMock(vi.mocked(installmentsApi.create), { id: 41 });
  resolveMock(vi.mocked(installmentsApi.pay), { id: 51 });
  resolveMock(vi.mocked(installmentsApi.previewSalePlan), { per_period_service_fee: "0", per_period: "600" });
  vi.mocked(ordersApi.executionDetail).mockResolvedValue({
    account: accounts[0],
    orders: [{
      order_id: 21,
      order_no: "HS0001",
      order_type: "HS",
      trade_date: "2026-10-15",
      status: "ACTIVE",
      events: [{
        id: 31,
        event_no: "EV0001",
        event_type: "BUY",
        amount: "100.00",
        occurred_on: "2026-10-15",
        occurred_at: "2026-10-15T10:20:00",
        portion: "PRINCIPAL",
        is_posted: true,
        operator: "admin",
        note: "回收登记",
        cashflow: { flow_no: "CF0001", pool_name: "利润池", occurred_on: "2026-10-15", direction: "OUT", category: "BUY", amount: "100.00" },
      }, {
        id: 33,
        event_no: "EV0003",
        event_type: "SELL",
        amount: "350.00",
        occurred_on: "2026-10-16",
        occurred_at: "2026-10-16T16:45:00",
        portion: "PROFIT",
        is_posted: true,
        operator: "admin",
      }],
    }],
  } as never);
  vi.mocked(employeesApi.list).mockResolvedValue([{ id: 1, username: "admin", display_name: "管理员", is_active: true }, { id: 2, username: "bob", display_name: "小红", is_active: true }]);
});
describe("InventoryPanel：写入与长路径", () => {
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
        dropExecutionCache: () => undefined, expandTo: setExpanded, expandedOrderIds: expanded,
        removeFromInventory: () => undefined,
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
        dropExecutionCache: () => undefined, expandTo: setExpanded, expandedOrderIds: expanded,
        removeFromInventory: () => undefined,
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
      params.offset || !serverVisible ? inventoryLedgerResponse([]) : stale
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

  it("重新进入库存时先恢复第一页和默认库龄，再发一次请求", async () => {
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
        dropExecutionCache: () => undefined, expandTo: setExpanded, expandedOrderIds: expanded,
        removeFromInventory: () => undefined, editorOpenEditor: async () => true,
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
        dropExecutionCache: () => undefined, expandTo: setExpanded, expandedOrderIds: expanded,
        removeFromInventory: () => undefined, editorOpenEditor: async () => true,
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

  it("库存删除等待字段配置时阻止提交，加载完成后允许确认", async () => {
    let resolveFields!: (value: Awaited<ReturnType<typeof orderFormFieldsApi.list>>) => void;
    vi.mocked(orderFormFieldsApi.list).mockReturnValueOnce(new Promise((resolve) => { resolveFields = resolve; }));
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderLight(<InventoryDeleteDialog account={accounts[0] as Account} submitting={false} onCancel={() => undefined} onConfirm={onConfirm} />);
    const modal = await screen.findByRole("dialog", { name: "删除" });
    fireEvent.change(within(modal).getByLabelText("删除原因"), { target: { value: "测试原因" } });
    await ui.click(within(modal).getByRole("button", { name: "确认删除" }));
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { resolveFields([]); });
    await waitFor(() => expect(within(modal).queryByRole("status")).not.toBeInTheDocument());
    await ui.click(within(modal).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("测试原因"));
  });

  it("库存删除提交中重复确认只发送一次", async () => {
    let finish!: () => void;
    vi.mocked(ordersApi.deleteOrder).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "删除" }));
    const modal = await screen.findByRole("dialog", { name: "删除" });
    fireEvent.change(within(modal).getByLabelText("删除原因"), { target: { value: "删除测试" } });
    const form = within(modal).getByLabelText("删除原因").closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(ordersApi.deleteOrder).toHaveBeenCalledTimes(1));
    fireEvent.submit(form);
    await act(async () => { await Promise.resolve(); });
    expect(ordersApi.deleteOrder).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("删除完成时不会覆盖后来展开的库存订单", async () => {
    let finish!: () => void;
    vi.mocked(ordersApi.deleteOrder).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    function Probe() {
      const [expanded, setExpanded] = useState<Key[]>(["21:1"]);
      const [, setRows] = useState<InventoryOrderRow[]>([]);
      const [, setError] = useState<{ message: string; code?: string } | null>(null);
      const actions = useInventoryActions({
        load: async () => undefined, setRows, setError,
        loadActionExecution: loadStandaloneActionExecution,
        loadExecution: async () => undefined, loadOrderExecution: async () => null, loadEditorExecution: async () => null,
        dropExecutionCache: () => undefined, expandTo: setExpanded, expandedOrderIds: expanded,
        removeFromInventory: () => undefined, editorOpenEditor: async () => true,
        editorCancelInlineEdit: () => undefined, editorCancelPendingOpen: () => undefined,
        editorIsSaving: () => false, editorSaveInline: async () => undefined, inlineEditId: null,
      });
      return <><button onClick={() => actions.setDeleteTarget(accounts[0] as Account)}>删除甲</button>
        <button onClick={() => void actions.submitDelete("原因")}>确认</button>
        <button onClick={() => { actions.invalidatePendingActions(); setExpanded(["22:2"]); }}>展开乙</button>
        <span>{`展开:${expanded.join(",")}`}</span></>;
    }
    renderLight(<Probe />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: "删除甲" }));
    await ui.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(ordersApi.deleteOrder).toHaveBeenCalledTimes(1));
    await ui.click(screen.getByRole("button", { name: "展开乙" }));
    await act(async () => finish());
    expect(screen.getByText("展开:22:2")).toBeInTheDocument();
  });

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

  it("库存编辑直接展开详情，账户资料保持只读", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("button", { name: "保存修改" })).toBeInTheDocument();
    expect(screen.queryByLabelText("编辑游戏账号/产品")).toBeNull();
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
    const detail = { account: accounts[0], orders: [{ order_id: 21, order_no: "HS0001", order_type: "HS", trade_date: "2026-10-15", status: "ACTIVE", events: [] }] };
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

  it("寄售提交成功后无需等详情刷新即可通知页面关闭", async () => {
    const detail = { account: accounts[0], orders: [{ order_id: 21, order_no: "HS0001", order_type: "HS", trade_date: "2026-10-15", status: "ACTIVE", events: [] }] };
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
      orders: [{ order_id: id, order_no: `HS${id}`, order_type: "HS", status: "ACTIVE", events: [] }],
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
// 原 InventoryConsignmentModal.test.tsx：只读 executionDetail，「已上架记录」的平台名来源（L234）
describe("InventoryConsignmentModal 已上架记录平台展示（L234）", () => {
  const consignAccount = {
    id: 1,
    source_order_id: 22,
    source_order_no: "DG-2026-0003",
    game_account: "acc-3",
    game_type: "手游",
    status: "IN_STOCK",
  } as unknown as Account;

  function renderConsignment() {
    return renderLight(
      <OrderConsignmentModal account={consignAccount} onClose={vi.fn()} onCreated={vi.fn()} />,
      { user: "admin" },
    );
  }

  it("上架记录读取失败后可在弹窗内重试", async () => {
    vi.mocked(ordersApi.executionDetail).mockRejectedValueOnce(new Error("上架记录读取失败"));
    vi.mocked(ordersApi.executionDetail).mockResolvedValueOnce({
      account: { id: 1, status: "WAITING" },
      orders: [{ order_id: 22, status: "ACTIVE", events: [] }],
    } as never);
    renderConsignment();
    expect(await screen.findByText(/上架记录读取失败/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "寄售平台" })).toBeDisabled();
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.queryByText(/上架记录读取失败/)).not.toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "寄售平台" })).toBeEnabled();
    expect(ordersApi.executionDetail).toHaveBeenCalledTimes(2);
  });

  it("原订单寄售事件的已上架记录展示平台名", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [
        {
          order_id: 22,
          order_type: "HS",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          events: [{
            id: 901,
            event_type: "OPERATE",
            operation_type: "CONSIGNMENT",
            form_extra: { consignment_platforms: ["盼之"], listed_at: "2026-10-12T09:10:00" },
          }],
        },
      ],
    } as never);

    renderConsignment();

    expect(await screen.findByText("盼之")).toBeInTheDocument();
  });

  it("已上架平台不再出现在新增上架选项", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: { id: 1, status: "WAITING" }, orders: [{
      order_id: 22, status: "ACTIVE", events: [{ id: 901, event_type: "OPERATE", operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["盼之"] } }],
    }] } as never);
    renderConsignment();
    await screen.findByText("盼之");
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "寄售平台" }).closest(".ant-select-selector")!);
    expect(await screen.findByText("千寻", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    expect(screen.queryByText("盼之", { selector: ".ant-select-item-option-content" })).toBeNull();
  });

  it("平台下架后可重新选择上架", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: { id: 1, status: "WAITING" }, orders: [{
      order_id: 22, status: "ACTIVE", events: [
        { id: 901, event_type: "OPERATE", operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["盼之"] } },
        { id: 902, event_type: "OPERATE", operation_type: "UNLIST", form_extra: { consignment_event_id: 901, consignment_platforms: ["盼之"], platform_unlist_scope: "PLATFORM" } },
      ],
    }] } as never);
    renderConsignment();
    await screen.findByText("暂无上架记录");
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "寄售平台" }).closest(".ant-select-selector")!);
    expect(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("寄售平台从原订单寄售事件读取", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [
        {
          order_id: 22,
          order_type: "HS",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          events: [{
            id: 902,
            event_type: "OPERATE",
            operation_type: "CONSIGNMENT",
            form_extra: { consignment_platforms: ["寄售平台A"], listed_at: "2026-10-12T09:10:00" },
          }],
        },
      ],
    } as never);

    renderConsignment();

    expect(await screen.findByText("寄售平台A")).toBeInTheDocument();
  });

  it("已上架记录限制为弹窗内滚动，不继续撑高寄售弹窗", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [{
        order_id: 22,
        order_no: "DG-2026-0003",
        order_type: "DG",
        status: "ACTIVE",
        trade_date: "2026-10-12",
        created_at: "2026-10-12T09:10:00",
        events: Array.from({ length: 12 }, (_, index) => ({
          id: 920 + index,
          event_type: "OPERATE",
          operation_type: "CONSIGNMENT",
          form_extra: { consignment_platforms: [`寄售平台${index + 1}`], listed_at: `2026-10-${String(index + 1).padStart(2, "0")}T09:10:00` },
        })),
      }],
    } as never);

    renderConsignment();

    await screen.findByText("寄售平台12");
    const recordsBody = document.querySelector<HTMLElement>(".inventory-consignment-records-table .ant-table-body");
    expect(recordsBody).toHaveStyle({ maxHeight: "180px", overflowY: "scroll" });
  });

  it("没有足够明细时不预留固定滚动高度", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [{
        order_id: 22,
        order_no: "DG-2026-0003",
        order_type: "DG",
        status: "ACTIVE",
        trade_date: "2026-10-12",
        created_at: "2026-10-12T09:10:00",
        events: [],
      }],
    } as never);

    renderConsignment();

    await screen.findByText("暂无上架记录");
    expect(document.querySelector(".inventory-consignment-records-table .ant-table-body")).toBeNull();
  });

  it("没有上架明细时使用共享紧凑空态", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [{
        order_id: 22,
        order_no: "DG-2026-0003",
        order_type: "DG",
        status: "ACTIVE",
        trade_date: "2026-10-12",
        created_at: "2026-10-12T09:10:00",
        events: [],
      }],
    } as never);

    renderConsignment();

    await screen.findByText("暂无上架记录");
    expect(document.querySelector(".inventory-consignment-records-table .ant-table-body")).toBeNull();
    expect(document.querySelector(".inventory-consignment-records-table .ui-datatable__empty")).toBeTruthy();
  });

  it("账号处于 VOID 时，已上架记录为空且无旧平台残留", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "VOID" },
      orders: [
        {
          order_id: 22,
          order_type: "DG",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          counterparties: [{ id: 11, display_name: "寄售平台A", role: "PLATFORM" }],
        },
      ],
    } as never);

    renderConsignment();

    expect(await screen.findByText("已上架记录")).toBeInTheDocument();
    // VOID 账号按源码逻辑清空列表；不得渲染平台名
    await waitFor(() => expect(screen.queryByText("寄售平台A")).not.toBeInTheDocument());
  });
});

it("订单账号信息按草稿顺序展示业务操作人并标识未知员工", async () => {
  renderLight(<OrderDetailProfileSection meta={{ sourceOrderNo: "HS-2026-0001" } as never}
    detail={{ orders: [{ order_id: 21, order_no: "HS-2026-0001", order_type: "HS" }] } as never}
    account={accounts[0] as Account}
    employees={[{ id: 1, username: "admin", display_name: "管理员", is_active: true }, { id: 2, username: "bob", display_name: "小红", is_active: true }]}
    orderDrafts={{ 21: { order_id: 21, occurred_at: "", note: "", form_extra: { business_responsible_ids: [2, 999, 1] } } }} />);
  expect(await screen.findByText("小红、未知员工、管理员")).toBeInTheDocument();
});

it("订单详情编辑账号自定义字段时保留配置的类型", async () => {
  vi.mocked(orderFormFieldsApi.list).mockResolvedValue([
    ...allFormFields(),
    { id: 9001, order_type_code: "HS", field_key: "rank", label: "等级", field_type: "NUMBER", options: [], required: false, is_active: true, sort_order: 90, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
    { id: 9002, order_type_code: "HS", field_key: "verified", label: "已核验", field_type: "BOOLEAN", options: [], required: false, is_active: true, sort_order: 91, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
    { id: 9003, order_type_code: "HS", field_key: "labels", label: "标签", field_type: "MULTI_SELECT", options: [{ value: "A", label: "甲" }, { value: "B", label: "乙" }], required: false, is_active: true, sort_order: 92, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
    { id: 9004, order_type_code: "HS", field_key: "region", label: "地区", field_type: "SELECT", options: [{ value: "N", label: "北区" }, { value: "S", label: "南区" }], required: false, is_active: true, sort_order: 93, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
    { id: 9005, order_type_code: "HS", field_key: "joined_on", label: "登记日期", field_type: "DATE", options: [], required: false, is_active: true, sort_order: 94, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
  ] as never);
  vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
  function Harness() {
    const [account, setAccount] = useState({ ...accounts[0], extra_values: { rank: 3, verified: true, labels: ["A"], region: "N", joined_on: "2026-11-01" } } as Account);
    return <><OrderDetailProfileSection meta={{ sourceOrderNo: "HS-2026-0001" } as never}
      detail={{ orders: [{ order_no: "HS-2026-0001", order_type: "HS" }] } as never}
      account={account} editing onProfileChange={(changes) => setAccount((current) => ({ ...current, ...changes }))} />
      <output data-testid="profile-extra">{JSON.stringify(account.extra_values)}</output></>;
  }
  renderLight(<Harness />);
  const rank = await screen.findByRole("spinbutton", { name: "编辑等级" });
  await ui.clear(rank);
  await ui.type(rank, "12");
  fireEvent.blur(rank);
  await ui.click(screen.getByRole("switch", { name: "编辑已核验" }));
  await ui.click(screen.getByRole("combobox", { name: "编辑标签" }));
  await ui.click(await screen.findByText("乙", { selector: ".ant-select-item-option-content" }));
  await ui.click(screen.getByRole("combobox", { name: "编辑地区" }));
  await ui.click(await screen.findByText("南区", { selector: ".ant-select-item-option-content" }));
  expect(screen.getByLabelText("编辑登记日期")).toHaveValue("2026-11-01");
  await waitFor(() => expect(JSON.parse(screen.getByTestId("profile-extra").textContent || "{}"))
    .toEqual({ rank: 12, verified: false, labels: ["A", "B"], region: "S", joined_on: "2026-11-01" }));
});

// —— 原 OrderDetailDeliverySection.test.tsx ——
// 订单详情「交付明细」区块：只读 props + 字段定义，无页面级挂载。
describe("OrderDetailDeliverySection", () => {
  beforeEach(() => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
  });
  it("FE-265：订单详情回显交易平台、中介类型和包赔类型", async () => {
    const detail = {
      orders: [{
        order_id: 21,
        order_no: "HS-FE265",
        order_type: "HS",
        created_at: "2026-11-02T10:00:00",
        extra_values: {
          intermediary_platform: "其他",
          intermediary_platform_other: "星河平台",
          intermediary_type: "包赔",
          compensation_type: "续保",
        },
        events: [],
      }],
    };

    const { rerender } = renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE265" } as never} detail={detail as never} />,
      { user: "admin" },
    );

    await waitFor(() => {
      expect(screen.getByText("星河平台")).toBeInTheDocument();
      expect(screen.getByText("包赔")).toBeInTheDocument();
      expect(screen.getByText("续保")).toBeInTheDocument();
    });
    const onOrderExtraChange = vi.fn();
    rerender(<OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE265" } as never}
      detail={detail as never} editing onOrderExtraChange={onOrderExtraChange} />);
    const other = await screen.findByLabelText("编辑其他平台");
    expect(other).toHaveValue("星河平台");
    fireEvent.change(other, { target: { value: "新平台" } });
    expect(onOrderExtraChange).toHaveBeenCalledWith(21, "intermediary_platform_other", "新平台");
    await ui.click(screen.getByRole("combobox", { name: "编辑交易平台" }));
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(21, "intermediary_platform_other", null);
  });

  it("编辑态交易平台、中介类型和包赔类型可以下拉选择", async () => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValueOnce([
      {
        id: 1, order_type_code: "HS", field_key: "intermediary_platform", label: "交易平台", field_type: "SELECT",
        options: [{ value: "盼之", label: "盼之" }, { value: "其他", label: "其他" }], required: false, is_active: true, sort_order: 1, locked: false, is_custom: false,
      },
      {
        id: 2, order_type_code: "HS", field_key: "intermediary_type", label: "中介类型", field_type: "SELECT",
        options: [{ value: "普中", label: "普中" }, { value: "包赔", label: "包赔" }], required: false, is_active: true, sort_order: 2, locked: false, is_custom: false,
      },
      {
        id: 3, order_type_code: "HS", field_key: "compensation_type", label: "包赔类型", field_type: "SELECT",
        options: [{ value: "首保", label: "首保" }, { value: "续保", label: "续保" }], required: false, is_active: true, sort_order: 3, locked: false, is_custom: false,
      },
    ] as never);
    const onOrderExtraChange = vi.fn();
    const detail = {
      orders: [{
        order_id: 25,
        order_no: "HS-FE268",
        order_type: "HS",
        created_at: "2026-11-02T10:00:00",
        extra_values: { intermediary_platform: "盼之", intermediary_type: "普中", compensation_type: "首保" },
        events: [],
      }],
    };

    renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "HS-FE268" } as never}
        detail={detail as never}
        editing
        onOrderExtraChange={onOrderExtraChange}
      />,
      { user: "admin" },
    );

    const platform = await screen.findByRole("combobox", { name: "编辑交易平台" });
    await ui.click(platform);
    await ui.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(25, "intermediary_platform", "其他");

    const intermediaryType = screen.getByRole("combobox", { name: "编辑中介类型" });
    await ui.click(intermediaryType);
    await ui.click(await screen.findByText("包赔", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(25, "intermediary_type", "包赔");

    const compensationType = screen.getByRole("combobox", { name: "编辑包赔类型" });
    await ui.click(compensationType);
    await ui.click(await screen.findByText("续保", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(25, "compensation_type", "续保");
  });

  it("编辑态交付操作人选择器保持可读宽度", async () => {
    renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "HS-FE269" } as never}
        detail={{
          orders: [{ order_id: 26, order_no: "HS-FE269", order_type: "HS", created_at: "2026-11-02T10:00:00", extra_values: {}, events: [] }],
        } as never}
        editing
        employees={[{ id: 7, username: "lisi", display_name: "李三（三三）", is_active: true }]}
      />,
      { user: "admin" },
    );

    const responsible = await waitFor(() => {
    const select = document.querySelector<HTMLElement>('.ant-select[aria-label="编辑交付操作人"]');
      expect(select).toBeInTheDocument();
      return select as HTMLElement;
    });
    expect(responsible).toHaveClass("order-detail__delivery-responsible");

    const searchInput = responsible.querySelector<HTMLInputElement>(".ant-select-selection-search-input");
    expect(searchInput).toBeInTheDocument();
    await ui.click(searchInput!);
    await ui.type(searchInput!, "李");
    expect(await screen.findByText("李三（三三）", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("FE-266：交付操作人回显员工姓名，未加载时不泄露原始 ID", async () => {
    const detail = {
      orders: [{
        order_id: 22,
        order_no: "HS-FE266",
        order_type: "HS",
        created_at: "2026-11-02T10:00:00",
        extra_values: { delivery_responsible_ids: [7] },
        events: [],
      }],
    };

    const { unmount } = renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "HS-FE266" } as never}
        detail={detail as never}
        employees={[{ id: 7, username: "lisi", display_name: "李三（三三）", is_active: true }]}
      />,
      { user: "admin" },
    );

    await waitFor(() => expect(screen.getByText("李三（三三）")).toBeInTheDocument());
    expect(screen.queryByText("7")).not.toBeInTheDocument();
    unmount();

    renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE266" } as never} detail={detail as never} />,
      { user: "admin" },
    );
    await waitFor(() => expect(screen.getByText("操作人信息加载中")).toBeInTheDocument());
    expect(screen.queryByText("7")).not.toBeInTheDocument();
  });

  it("FE-267：同一订单买号和卖号交付独立展示并编辑", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => scope === "SALEREC" ? [{
      id: 9901, order_type_code: "SALEREC", field_key: "sale_receipt", label: "卖号凭据", field_type: "TEXT",
      options: [], required: false, is_active: true, sort_order: 1, locked: false, is_custom: true, section: "DELIVER",
    }] as never : []);
    const detail = {
      orders: [
        {
          order_id: 23,
          order_no: "HS-FE267",
          order_type: "HS",
          created_at: "2026-11-02T10:00:00",
          extra_values: {
            bound_phone: "13800000001", bound_phone_owner: "买号绑定人", intermediary_platform: "盼之",
            sell_bound_phone: "13800000002", sell_bound_phone_owner: "卖号绑定人", sell_intermediary_platform: "其他",
            sell_intermediary_platform_other: "卖号平台",
          },
          events: [{ event_type: "SELL", id: 1, amount: "1", occurred_on: "2026-11-02", form_extra: { sale_mode: "FULL", sale_receipt: "原卖号凭据" } }],
        },
      ],
    };

    const { rerender } = renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE267" } as never} detail={detail as never} account={{ bound_phone: "13800000002" } as never} />,
      { user: "admin" },
    );

    await waitFor(() => {
      expect(screen.getByText("买号绑定人")).toBeInTheDocument();
      expect(screen.getByText("卖号绑定人")).toBeInTheDocument();
      expect(screen.getByText("13800000001")).toBeInTheDocument();
      expect(screen.getByText("13800000002")).toBeInTheDocument();
      expect(screen.getByText("卖号平台")).toBeInTheDocument();
      expect(screen.getByText("原卖号凭据")).toBeInTheDocument();
    });
    const onOrderExtraChange = vi.fn();
    const onProfileChange = vi.fn();
    const onEventEdit = vi.fn();
    rerender(<OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE267" } as never} detail={detail as never}
      account={{ bound_phone: "13800000002" } as never} editing onOrderExtraChange={onOrderExtraChange} onProfileChange={onProfileChange} onEventEdit={onEventEdit} />);
    const groups = document.querySelectorAll<HTMLElement>(".order-detail__meta-group");
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getByLabelText("编辑换绑手机号")).toHaveValue("13800000001");
    expect(within(groups[1]).getByLabelText("编辑换绑手机号")).toHaveValue("13800000002");
    fireEvent.change(within(groups[0]).getByLabelText("编辑换绑手机号"), { target: { value: "13700000001" } });
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "bound_phone", "13700000001");
    expect(onProfileChange).not.toHaveBeenCalled();
    fireEvent.change(within(groups[1]).getByLabelText("编辑换绑手机号"), { target: { value: "13900000002" } });
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "sell_bound_phone", "13900000002");
    expect(onProfileChange).toHaveBeenCalledWith({ bound_phone: "13900000002" });
    fireEvent.change(within(groups[0]).getByLabelText("编辑手机号绑定人"), { target: { value: "新买号绑定人" } });
    fireEvent.change(within(groups[1]).getByLabelText("编辑手机号绑定人"), { target: { value: "新卖号绑定人" } });
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "bound_phone_owner", "新买号绑定人");
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "sell_bound_phone_owner", "新卖号绑定人");
    await ui.click(within(groups[1]).getByRole("combobox", { name: "编辑交易平台" }));
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "sell_intermediary_platform", "盼之");
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "sell_intermediary_platform_other", null);
    fireEvent.change(within(groups[1]).getByLabelText("编辑卖号凭据"), { target: { value: "新卖号凭据" } });
    expect(onEventEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { form_extra: { sale_mode: "FULL", sale_receipt: "新卖号凭据" } });
  });

  it("FE-268：仅有代挂订单时卖号交付仍展示交付表格", async () => {
    const detail = {
      orders: [{
        order_id: 25,
        order_no: "DG-FE268",
        order_type: "DG",
        created_at: "2026-11-02T10:00:00",
        extra_values: {
          intermediary_platform: "盼之",
          intermediary_type: "普中",
          compensation_type: "首保",
          delivery_responsible_ids: [1],
        },
        events: [],
      }],
    };

    renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "DG-FE268" } as never}
        detail={detail as never}
        employees={[{ id: 1, username: "admin", display_name: "管理员", is_active: true }]}
      />,
      { user: "admin" },
    );

    await waitFor(() => expect(screen.getAllByText("盼之").length).toBeGreaterThan(0));
  });
});

// —— 原 InventoryPanel.sale.test.tsx ——
// 售出、写入和详情编辑共享同一页面依赖与初始化，合并后避免重复启动重型库存页面。
describe("库存售出流程", () => {
beforeEach(() => {
  seedOrderFormFields();
});

it("上一单售出完成后，不清空或关闭新订单的表单", async () => {
  let finish!: (value: Awaited<ReturnType<typeof ordersApi.stockSale>>) => void;
  vi.mocked(ordersApi.stockSale).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const { rerender } = renderLight(<RecoverySaleModal account={accounts[0] as Account} onClose={onClose} onCreated={onCreated} />, { user: "admin" });
  await ui.type(await screen.findByLabelText("售出金额"), "350");
  await ui.click(screen.getByLabelText("资金账户"));
  await ui.click(await screen.findByText(/利润池/));
  await ui.click(screen.getByRole("button", { name: /确认售出/ }));
  await waitFor(() => expect(ordersApi.stockSale).toHaveBeenCalledTimes(1));
  rerender(<RecoverySaleModal account={accounts[1] as Account} onClose={onClose} onCreated={onCreated} />);
  await waitFor(() => expect(screen.getByText("acc-2")).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("售出金额"), { target: { value: "200" } });
  await act(async () => finish({} as never));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText("售出金额")).toHaveValue("200");
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 1, source_order_id: 21 }));
});

it.each([RecoverySaleModal, PickupSaleModal, ConsignmentSaleModal])("已选售出操作人时无需等待人员重查，提交期间防止重复操作", async (SaleModal) => {
  vi.mocked(employeesApi.list).mockResolvedValueOnce([{ id: 2, username: "bob", display_name: "小红", is_active: true }]);
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<SaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  const amountLabel = SaleModal === ConsignmentSaleModal ? "利润" : "售出金额";
  await saleUi.type(await screen.findByLabelText(amountLabel), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(1));
  await saleUi.click(screen.getByLabelText("售出操作人"));
  await saleUi.click(await screen.findByText("小红", { selector: ".ant-select-item-option-content" }));
  await saleUi.click(screen.getByLabelText("交付操作人"));
  const employeeOptions = screen.getAllByText("小红", { selector: ".ant-select-item-option-content" });
  await saleUi.click(employeeOptions[employeeOptions.length - 1]);
  const listCallsBeforeSubmit = vi.mocked(employeesApi.list).mock.calls.length;
  vi.mocked(employeesApi.list).mockReturnValue(new Promise(() => {}));
  vi.mocked(ordersApi.stockSale).mockReturnValue(new Promise(() => {}));
  const form = screen.getByLabelText(amountLabel).closest("form")!;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /确认售出/ })); });
  await waitFor(() => expect(ordersApi.stockSale).toHaveBeenCalledTimes(1));
  await act(async () => { fireEvent.submit(form); });
  expect(employeesApi.list).toHaveBeenCalledTimes(listCallsBeforeSubmit);
  expect(screen.getByRole("button", { name: /确认售出/ })).toHaveClass("ant-btn-loading");
  expect(ordersApi.stockSale).toHaveBeenCalledTimes(1);
});

it("不填写客户时仍可售出", async () => {
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  await saleUi.type(await screen.findByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("交易平台"));
  await saleUi.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
  await waitFor(() => expect(ordersApi.stockSale).toHaveBeenCalledWith(21, expect.objectContaining({
    amount: "350", delivery_form_extra: expect.objectContaining({ intermediary_platform: "盼之", intermediary_platform_other: null }),
  })));
  expect(customersApi.create).not.toHaveBeenCalled();
  expect(ordersApi.addCustomerRole).not.toHaveBeenCalled();
});

it("填写客户时无需预先加载完整客户名单", async () => {
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  await screen.findByText("买家信息");
  await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
  await saleUi.type(screen.getByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
  await waitFor(() => expect(ordersApi.stockSale).toHaveBeenCalledWith(21, expect.objectContaining({ customer_input: expect.objectContaining({ display_name: "买家A", role: "BUYER" }) })));
  expect(customersApi.page).not.toHaveBeenCalled();
});

it("售出时把新买家关联到来源单而非新建订单", async () => {
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  resolveMock(vi.mocked(customersApi.page), { items: [], total: 0, limit: 500, offset: 0 });
  resolveMock(vi.mocked(customersApi.create), {
    customer: { id: 8, customer_no: "C0008", display_name: "新买家", status: "ACTIVE" },
    duplicate_candidates: [],
  });
  renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });

  expect(await screen.findByText("买家信息")).toBeInTheDocument();
  expect(screen.getByText("资金明细")).toBeInTheDocument();
  await saleUi.type(screen.getByLabelText("客户昵称"), "新买家");
  await saleUi.type(screen.getByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

  await waitFor(() => expect(vi.mocked(ordersApi.stockSale)).toHaveBeenCalledWith(21, expect.objectContaining({
    customer_input: expect.objectContaining({ display_name: "新买家", role: "BUYER" }),
    amount: "350", pool_id: 3, operator_user_ids: [1],
  })));
  expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
  expect(vi.mocked(ordersApi.addCustomerRole)).not.toHaveBeenCalled();
  expect(vi.mocked(customersApi.create)).not.toHaveBeenCalled();
  expect(vi.mocked(ordersApi.postEvent)).not.toHaveBeenCalled();
});

it("库存售出：成功后立即从库存列表移除账号，即使列表重拉暂时返回旧快照", async () => {
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<InventoryPanel />, { user: "admin" });

  expect(await screen.findByText("acc-1")).toBeInTheDocument();
  await saleUi.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "售出" }));
  await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
  await saleUi.type(screen.getByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));

  await waitFor(() => expect(vi.mocked(ordersApi.stockSale)).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText("acc-1")).not.toBeInTheDocument());
});

describe("库存售出三表单分支", () => {
  it("代挂账号售出：全款收佣金入账、售出金额仅记录、不提供分期并挂寄售方", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => [
      ...allFormFields().filter((field) => field.order_type_code === scope),
      ...(scope === "SALEDG" ? [{ id: 9001, order_type_code: scope, field_key: "sale_receipt", label: "售出凭据", field_type: "TEXT", options: [], required: true, is_active: true, sort_order: 99, locked: false, is_custom: true, section: "FINANCE", note: null },
        { id: 9002, order_type_code: scope, field_key: "optional_number", label: "售出附加数字", field_type: "NUMBER", required: false, is_active: true, sort_order: 100, locked: false, is_custom: true, section: "BUSINESS" }] : []),
    ] as never);
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([{
      account: { ...accounts[0], id: 5, source_order_id: 21, game_account: "acc-5", inventory_type: "CONSIGNMENT" },
      order: { id: 21, order_no: "DG-2026-0001", order_type: "DG", trade_date: "2026-10-01", account_id: 5, account_status: "WAITING", status: "ACTIVE" },
    }], { type_counts: { CONSIGNMENT: 1 }, stats: { account_count: 1, occupied_cost: "50.00", over_7d_count: 0, over_30d_count: 0 } }) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-5");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出代挂账号")).toBeInTheDocument();
    expect(screen.getByLabelText("利润")).toBeInTheDocument();
    expect(screen.getByLabelText("售出金额（仅记录）")).toBeInTheDocument();
    expect(screen.queryByText("付款方式")).toBeNull();
    expect(screen.queryByText("分期付款")).toBeNull();
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByPlaceholderText("请输入利润（代挂佣金）"), "200");
    await saleUi.type(screen.getByPlaceholderText("代挂无买入价，此处仅作记录，不计入利润"), "1000");
    await saleUi.type(await screen.findByLabelText("售出凭据"), "全款凭据");
    await saleUi.type(screen.getByLabelText("售出附加数字"), "17");
    await saleUi.clear(screen.getByLabelText("售出附加数字"));
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
    await waitFor(() => expect(vi.mocked(ordersApi.stockSale)).toHaveBeenCalled());
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
    expect(vi.mocked(ordersApi.stockSale)).toHaveBeenCalledWith(21, expect.objectContaining({
      amount: "200", pool_id: 3, sale_amount: "1000", form_extra: { sale_receipt: "全款凭据" }, customer_input: expect.objectContaining({ display_name: "买家A", role: "CONSIGNOR" }),
    }));
    expect(vi.mocked(ordersApi.addCustomerRole)).not.toHaveBeenCalled();
    expect(vi.mocked(installmentsApi.create)).not.toHaveBeenCalled();
  });

  it("代挂售出复用买号交付信息块，交付操作人提交落库到来源单", async () => {
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([{
      account: { ...accounts[0], id: 5, source_order_id: 21, game_account: "acc-5", inventory_type: "CONSIGNMENT" },
      order: { id: 21, order_no: "DG-2026-0001", order_type: "DG", trade_date: "2026-10-01", account_id: 5, account_status: "WAITING", status: "ACTIVE" },
    }], { type_counts: { CONSIGNMENT: 1 }, stats: { account_count: 1, occupied_cost: "50.00", over_7d_count: 0, over_30d_count: 0 } }) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-5");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出代挂账号")).toBeInTheDocument();
    expect(screen.getByText("交付操作人")).toBeInTheDocument();
    expect(screen.getByText("交易平台")).toBeInTheDocument();
    expect(screen.getByText("中介类型")).toBeInTheDocument();
    expect(screen.getByText("包赔类型")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("交付操作人").closest(".ant-select")).toHaveTextContent("管理员"));
    await saleUi.click(screen.getByLabelText("交易平台"));
    await saleUi.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    await saleUi.type(await screen.findByLabelText("其他平台"), "星河平台");
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByPlaceholderText("请输入利润（代挂佣金）"), "200");
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
    await waitFor(() => expect(vi.mocked(ordersApi.stockSale)).toHaveBeenCalledWith(21, expect.objectContaining({
      delivery_form_extra: expect.objectContaining({ delivery_responsible_ids: [1], intermediary_platform: "其他", intermediary_platform_other: "星河平台" }),
    })));
  });

  it("分期售出金额字段拒绝超过两位小数", async () => {
    vi.mocked(installmentsApi.previewSalePlan).mockReturnValue(new Promise(() => {}));
    renderLight(<RecoverySaleModal account={accounts[0] as Account} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    fireEvent.change(await screen.findByLabelText("售出金额"), { target: { value: "1.234" } });
    await ui.click(screen.getByText("分期付款"));
    for (const label of ["首付金额", "分期服务费总额", "每期服务费", "每期金额"]) {
      fireEvent.change(await screen.findByLabelText(label), { target: { value: "1.234" } });
    }
    await ui.click(screen.getByRole("button", { name: /确认售出/ }));
    for (const label of ["售出金额", "首付金额", "分期服务费总额", "每期服务费", "每期金额"]) {
      expect(await screen.findByText(`${label}必须是数字，最多两位小数`)).toBeInTheDocument();
    }
    expect(installmentsApi.stockSale).not.toHaveBeenCalled();
  });

  it("代挂售出金额和利润拒绝超过两位小数", async () => {
    renderLight(<ConsignmentSaleModal account={accounts[0] as Account} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    fireEvent.change(await screen.findByLabelText("售出金额（仅记录）"), { target: { value: "1.234" } });
    fireEvent.change(screen.getByLabelText("利润"), { target: { value: "1.234" } });
    await ui.click(screen.getByRole("button", { name: /确认售出/ }));
    expect(await screen.findByText("售出金额（仅记录）必须是数字，最多两位小数")).toBeInTheDocument();
    expect(await screen.findByText("利润必须是数字，最多两位小数")).toBeInTheDocument();
    expect(ordersApi.stockSale).not.toHaveBeenCalled();
  });

  it("分期首付超过大额售出金额一分时提示并阻止提交", async () => {
    vi.mocked(installmentsApi.previewSalePlan).mockReturnValue(new Promise(() => {}));
    renderLight(<RecoverySaleModal account={accounts[0] as Account} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    fireEvent.change(await screen.findByLabelText("售出金额"), { target: { value: "9999999999999999.98" } });
    await ui.click(screen.getByText("分期付款"));
    fireEvent.change(await screen.findByLabelText("首付金额"), { target: { value: "9999999999999999.99" } });
    await ui.click(screen.getByRole("button", { name: /确认售出/ }));
    expect(await screen.findByText("首付不能为负数或超过售出金额")).toBeInTheDocument();
    expect(installmentsApi.stockSale).not.toHaveBeenCalled();
  });

  it("分期预览回填大额金额并保留用户修改的分位", async () => {
    const preview = { per_period: "9999999999999999.98", per_period_service_fee: "9999999999999999.98" } as never;
    vi.mocked(installmentsApi.previewSalePlan).mockReturnValue(new Promise(() => {})).mockResolvedValueOnce(preview);
    renderLight(<RecoverySaleModal account={accounts[0] as Account} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    fireEvent.change(await screen.findByLabelText("售出金额"), { target: { value: "100" } });
    await ui.click(screen.getByText("分期付款"));
    const perPeriod = await screen.findByLabelText("每期金额");
    const fee = screen.getByLabelText("每期服务费");
    await waitFor(() => expect(perPeriod).toHaveValue("9999999999999999.98"));
    expect(fee).toHaveValue("9999999999999999.98");
    const calls = vi.mocked(installmentsApi.previewSalePlan).mock.calls.length;
    vi.mocked(installmentsApi.previewSalePlan).mockResolvedValueOnce(preview);
    fireEvent.change(perPeriod, { target: { value: "9999999999999999.99" } });
    await waitFor(() => expect(installmentsApi.previewSalePlan).toHaveBeenCalledTimes(calls + 1));
    await waitFor(() => expect(perPeriod).toHaveValue("9999999999999999.99"));
  });

  it("分期金额变更后等待新预览时不显示旧的最后一期金额", async () => {
    const preview = { per_period: "50.00", per_period_service_fee: "0.00", last_period: "49.99" } as never;
    vi.mocked(installmentsApi.previewSalePlan).mockReset().mockResolvedValue(preview);
    renderLight(<RecoverySaleModal account={accounts[0] as Account} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    fireEvent.change(await screen.findByLabelText("售出金额"), { target: { value: "100" } });
    await ui.click(screen.getByText("分期付款"));
    await waitFor(() => expect(screen.getByText("最后一期：49.99 元")).toBeInTheDocument());
    vi.mocked(installmentsApi.previewSalePlan).mockReturnValue(new Promise(() => {}));
    fireEvent.change(screen.getByLabelText("售出金额"), { target: { value: "120" } });
    await waitFor(() => expect(screen.queryByText("最后一期：49.99 元")).not.toBeInTheDocument());
  });

  it("提号库存售出可选择分期出售，确立时收首付", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => [
      ...allFormFields().filter((field) => field.order_type_code === scope),
      ...(scope === "SALETH" ? [{ id: 9002, order_type_code: scope, field_key: "sale_receipt", label: "售出凭据", field_type: "TEXT", options: [], required: true, is_active: true, sort_order: 99, locked: false, is_custom: true, note: null }] : []),
    ] as never);
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([{
      account: { ...accounts[0], id: 6, source_order_id: 21, game_account: "pickup-acc", inventory_type: "PICKUP", cost_amount: "0.00" },
      order: { id: 21, order_no: "TH-2026-0001", order_type: "TH", trade_date: "2026-10-01", account_id: 6, account_status: "WAITING", status: "ACTIVE" },
    }], { type_counts: { PICKUP: 1 }, stats: { account_count: 1, occupied_cost: "0.00", over_7d_count: 0, over_30d_count: 0 } }) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("pickup-acc");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出提号账号")).toBeInTheDocument();
    await saleUi.click(screen.getByLabelText("交易平台"));
    await saleUi.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    await saleUi.type(await screen.findByLabelText("其他平台"), "分期平台");
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByPlaceholderText("请输入金额"), "1200");
    await saleUi.click(await screen.findByText("分期付款"));
    await saleUi.clear(screen.getByLabelText("首付金额"));
    await saleUi.type(screen.getByLabelText("首付金额"), "300");
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.clear(screen.getByLabelText("分期期数"));
    await saleUi.type(screen.getByLabelText("分期期数"), "2");
    await saleUi.clear(screen.getByLabelText("每期金额"));
    await saleUi.type(screen.getByLabelText("每期金额"), "600");
    await saleUi.type(await screen.findByLabelText("售出凭据"), "分期凭据");
    expect(screen.getByLabelText("第 1 期到期日")).toBeInTheDocument();
    expect(screen.getByLabelText("第 2 期到期日")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(vi.mocked(installmentsApi.stockSale)).toHaveBeenCalledWith(expect.objectContaining({
      order_id: 21, principal: "1200", down_payment: "300", pool_id: 3, operator_user_ids: [1], form_extra: { sale_receipt: "分期凭据" },
      delivery_form_extra: expect.objectContaining({ intermediary_platform: "其他", intermediary_platform_other: "分期平台" }),
    })));
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
    expect(vi.mocked(ordersApi.postEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(installmentsApi.create)).not.toHaveBeenCalled();
    expect(vi.mocked(installmentsApi.pay)).not.toHaveBeenCalled();
  });

  it("库存中心不为售出单提供取消入口", async () => {
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([]) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await waitFor(() => expect(screen.queryByText("acc-2")).toBeNull());
    expect(screen.getByText("暂无账号")).toBeInTheDocument();
    expect(vi.mocked(ordersApi.postEvent)).not.toHaveBeenCalled();
  });

  it("售出表单统一使用资金明细且不增加支出", async () => {
    renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    expect(await screen.findByText("资金明细")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /增加支出/ })).not.toBeInTheDocument();
    expect(screen.queryByText("售出金额2")).not.toBeInTheDocument();
    expect(screen.queryByText("资金账户2")).not.toBeInTheDocument();
  });

  it("回收、提号、代挂三种售出表单都展示统一的交付信息", async () => {
    const deliveryLabels = ["换绑手机号", "手机号绑定人", "交易平台", "中介类型", "包赔类型", "交付操作人", "售出操作人"];
    const cases = [
      [RecoverySaleModal, accounts[0]],
      [PickupSaleModal, { ...accounts[0], inventory_type: "PICKUP" }],
      [ConsignmentSaleModal, { ...accounts[0], inventory_type: "CONSIGNMENT" }],
    ] as const;
    for (const [Modal, account] of cases) {
      const { unmount } = renderLight(<Modal account={account} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
      expect(await screen.findByText("交付信息")).toBeInTheDocument();
      for (const label of deliveryLabels) expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("分期出售只对回收与提号开放，代挂仅全款", async () => {
    const cases = [
      [RecoverySaleModal, accounts[0], "买家信息", true],
      [PickupSaleModal, { ...accounts[0], inventory_type: "PICKUP" }, "买家信息", true],
      [ConsignmentSaleModal, { ...accounts[0], inventory_type: "CONSIGNMENT" }, "委托方信息", false],
    ] as const;
    for (const [Modal, account, buyerSection, supportsInstallment] of cases) {
      const { unmount } = renderLight(<Modal account={account} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
      await screen.findByText(buyerSection);
      if (supportsInstallment) expect(screen.getByText("付款方式")).toBeInTheDocument();
      else expect(screen.queryByText("付款方式")).toBeNull();
      unmount();
    }
  });

  it("三类售出各取独立作用域配置，互不共用", async () => {
    const cases = [
      [RecoverySaleModal, accounts[0], "SALEREC"],
      [PickupSaleModal, { ...accounts[0], inventory_type: "PICKUP" }, "SALETH"],
      [ConsignmentSaleModal, { ...accounts[0], inventory_type: "CONSIGNMENT" }, "SALEDG"],
    ] as const;
    for (const [Modal, account, scope] of cases) {
      vi.mocked(orderFormFieldsApi.list).mockClear();
      vi.mocked(orderFormFieldsApi.listSectionLabels).mockClear();
      const { unmount } = renderLight(<Modal account={account} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
      await waitFor(() => expect(orderFormFieldsApi.list).toHaveBeenCalledWith(scope, true));
      expect(vi.mocked(orderFormFieldsApi.list).mock.calls.every(([code]) => code === scope)).toBe(true);
      expect(orderFormFieldsApi.listSectionLabels).toHaveBeenCalledWith(scope);
      unmount();
    }
  });

  it("P1/FE-042：已拉黑客户不能参与库存售出", async () => {
    vi.mocked(ordersApi.stockSale).mockRejectedValueOnce(new Error("客户已拉黑，不能作为售出买家"));
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }] as never);
    vi.mocked(employeesApi.list).mockResolvedValueOnce([{ id: 1, username: "admin", display_name: "管理员", is_active: true }] as never);
    renderLight(
      <RecoverySaleModal
        account={{ id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", game_account: "acc-1", status: "WAITING", inventory_type: "RECOVERY" } as never}
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
      { user: "admin" },
    );
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    await screen.findByText("买家信息");
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByLabelText("售出金额"), "350");
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(screen.getByText(/客户已拉黑，不能作为售出买家/)).toBeInTheDocument());
    expect(ordersApi.addCustomerRole).not.toHaveBeenCalled();
    expect(ordersApi.postEvent).not.toHaveBeenCalled();
  });
});

});
