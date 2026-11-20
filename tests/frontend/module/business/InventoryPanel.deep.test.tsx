import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { renderLight } from "@fixtures/render";
import { InventoryPanel } from "@/business/stocks/InventoryPanel";
import { consignmentRecords } from "@/business/operations/offsale";
import { OrderPlatformOffsaleModal } from "@/business/operations";
import { installmentsApi } from "@/shared/api/installments.api";
import { orderFormFieldsApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { resolveMock } from "@fixtures/mock-api";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { inventoryLedgerResponse } from "@fixtures/api-responses";
import type { AccountExecutionDetail } from "@/shared/api/types/account-execution";
import type { Account } from "@/shared/api/types/accounts";
import type { Installment } from "@/shared/api/types/installments";

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

let ui: ReturnType<typeof userEvent.setup>;

const inStockRow = {
  id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "安卓",
  status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01",
  created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "初始描述",
} as unknown as Account;

const soldRow = {
  id: 2, source_order_no: "HS-2026-0002", game_account: "acc-2", platform: "安卓",
  status: "SOLD", inventory_type: "RECOVERY", cost_amount: "200.00", buy_date: "2026-10-02",
  created_by: "admin", created_at: "2026-10-02T09:30:00",
} as unknown as Account;

const installmentRow = {
  id: 3, source_order_no: "HS-2026-0003", game_account: "acc-3", platform: "安卓",
  status: "SOLD", inventory_status: "OUT_OF_STOCK", inventory_type: "RECOVERY", cost_amount: "300.00", buy_date: "2026-10-03",
  created_by: "admin", created_at: "2026-10-03T09:30:00",
} as unknown as Account;

const sellDetail = {
  account: soldRow,
  orders: [
    {
      order_id: 55,
      status: "COMPLETED",
      events: [{ id: 901, event_type: "SELL", amount: "500.00", portion: "PRINCIPAL", occurred_on: "2026-10-05", is_posted: true }],
    },
  ],
} as unknown as AccountExecutionDetail;

const noSaleDetail = {
  account: soldRow,
  orders: [{ order_id: 55, status: "COMPLETED", events: [{ id: 900, event_type: "BUY", amount: "500.00", portion: "PRINCIPAL", occurred_on: "2026-10-04", is_posted: true }] }],
} as unknown as AccountExecutionDetail;

const installmentDetail = {
  account: installmentRow,
  orders: [{ order_id: 77, status: "ACTIVE", events: [] }],
} as unknown as AccountExecutionDetail;

const consignmentRow = {
  ...inStockRow,
  source_order_id: 88,
  inventory_type: "CONSIGNMENT",
} as unknown as Account;

const consignmentDetail = {
  account: consignmentRow,
  orders: [{
    order_id: 88,
    order_no: "DG-88",
    order_type: "DG",
    status: "ACTIVE",
    created_at: "2026-10-29T03:54:00",
    trade_date: "2026-10-29",
    events: [{
      id: 801,
      event_type: "OPERATE",
      operation_type: "CONSIGNMENT",
      form_extra: { consignment_platforms: ["千寻"], listed_at: "2026-10-29T03:54" },
    }],
  }],
} as unknown as AccountExecutionDetail;

const contract = { id: 21, inst_no: "INS-21", order_id: 77, contract_type: "INSTALLMENT", status: "ACTIVE" } as unknown as Installment;

async function openPanel(rows: Account[]) {
  vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse(rows.map((row) => ({
      account: row,
      order: {
        id: row.source_order_id ?? row.id,
        order_no: row.source_order_no ?? `HS-${row.id}`,
        order_type: row.inventory_type === "CONSIGNMENT" ? "DG" : "HS",
        trade_date: "2026-10-15",
        account_id: row.id,
        account_status: "WAITING",
        status: "ACTIVE",
      },
    })), {
      type_counts: { RECOVERY: rows.length },
      game_types: ["王者荣耀"],
      stats: { account_count: rows.length, occupied_cost: "100.00", over_7d_count: 0, over_30d_count: 0 },
    }) as never);
  renderLight(<InventoryPanel />, { user: "admin" });
  await waitFor(() => expect(document.querySelector("tbody tr")).toBeTruthy());
}

function rowOf(id: number): HTMLElement {
  const rows = Array.from(document.querySelectorAll("tbody tr")) as HTMLElement[];
  const row = rows.find((r) => r.textContent?.includes(`acc-${id}`));
  return row as HTMLElement;
}

async function clickOperation(row: HTMLElement, item: string) {
  if (item === "取消") {
    await ui.click(within(row).getByRole("button", { name: "取消" }));
    return;
  }
  await ui.click(within(row).getByRole("button", { name: "运营" }));
  // 菜单项文本可能与行内按钮/弹窗标题重名，必须限定在 role=menu 内点击
  await ui.click(within(await screen.findByRole("menu")).getByText(item));
}

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(orderFormFieldsApi.list).mockImplementation(async () => []);
  URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  seedOptionSets();
  vi.mocked(employeesApi.list).mockResolvedValue([{ id: 1, username: "admin", display_name: "管理员", is_active: true }]);
  vi.mocked(installmentsApi.list).mockResolvedValue([contract]);
  vi.mocked(installmentsApi.cancel).mockResolvedValue({} as never);
  vi.mocked(ordersApi.postEvent).mockResolvedValue({} as never);
  vi.mocked(ordersApi.inventoryOffsale).mockResolvedValue({ ok: true });
  vi.mocked(ordersApi.executionDetail).mockResolvedValue(sellDetail);
  vi.mocked(stocksApi.inventoryLedgerExport).mockResolvedValue({ blob: new Blob(["csv"]), failedDetailCount: 0 });
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "warning").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "info").mockImplementation((() => undefined) as never);
});

describe("InventoryPanel：运营动作 / 退款取消 / 导出", () => {
  it("上一单下架完成后，不清空新订单的下架表单", async () => {
    let finish!: (value: Awaited<ReturnType<typeof ordersApi.postEvent>>) => void;
    vi.mocked(ordersApi.postEvent).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const records = consignmentRecords(consignmentDetail.orders);
    const onClose = vi.fn();
    const onChanged = vi.fn();
    const onSystemOffsale = vi.fn();
    const { rerender } = renderLight(<OrderPlatformOffsaleModal account={consignmentRow} records={records} onClose={onClose} onChanged={onChanged} onSystemOffsale={onSystemOffsale} />, { user: "admin" });
    await ui.click(screen.getByRole("combobox", { name: "下架平台" }));
    await ui.click(await screen.findByText(/千寻（上架于/, { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("下架原因"), "第一单下架");
    await ui.click(screen.getByRole("button", { name: "确认下架" }));
    await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledTimes(1));
    const second = { ...consignmentRow, id: 2, source_order_id: 99, game_account: "acc-2" } as Account;
    rerender(<OrderPlatformOffsaleModal account={second} records={records} onClose={onClose} onChanged={onChanged} onSystemOffsale={onSystemOffsale} />);
    fireEvent.change(screen.getByLabelText("下架原因"), { target: { value: "第二单草稿" } });
    await act(async () => finish({} as never));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("下架原因")).toHaveValue("第二单草稿");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it("在库账号卡片使用后端账号统计，不使用分页订单行数", async () => {
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse([{
        account: inStockRow,
        order: { id: 21, order_no: "HS-2026-0001", order_type: "HS", trade_date: "2026-10-15", account_id: 1, account_status: "WAITING", status: "ACTIVE" },
      }], {
        total: 2,
        facet_total: 2,
        type_counts: { RECOVERY: 2 },
        game_types: ["王者荣耀"],
        stats: { account_count: 1, occupied_cost: "100.00", over_7d_count: 0, over_30d_count: 0 },
      }) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    const card = screen.getByText("在库账号").closest(".ui-stat");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("1")).toBeInTheDocument();
  });

  it("库存中心提供入库负责人多选筛选", async () => {
    await openPanel([inStockRow]);

    const filter = screen.getByRole("combobox", { name: "入库负责人筛选" });
    await ui.click(filter);
    await ui.click(screen.getByText("管理员", { selector: ".ant-select-item-option-content" }));

    await waitFor(() => expect(vi.mocked(stocksApi.inventoryLedger)).toHaveBeenLastCalledWith(
      expect.objectContaining({ inventory_operator_ids: [1] }),
    ));
  });

  it("库存超期深链按库龄筛选", async () => {
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValue(inventoryLedgerResponse([]) as never);
    renderLight(<InventoryPanel initialAgeGtDays={30} />, { user: "admin" });

    await waitFor(() => expect(vi.mocked(stocksApi.inventoryLedger)).toHaveBeenCalledWith(
      expect.objectContaining({ age_gt_days: 30 }),
    ));
  });

  it("运营 → 描述：打开描述编辑弹窗", async () => {
    await openPanel([inStockRow]);
    await clickOperation(rowOf(1), "描述");
    expect((await screen.findAllByText("描述")).length).toBeGreaterThan(0);
  });

  it("运营 → 作图：打开图片编辑弹窗", async () => {
    await openPanel([inStockRow]);
    await clickOperation(rowOf(1), "作图");
    expect((await screen.findAllByText("作图")).length).toBeGreaterThan(0);
  });

  it("非代挂在库账号不展示下架入口", async () => {
    await openPanel([inStockRow]);
    await ui.click(within(rowOf(1)).getByRole("button", { name: "运营" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("下架")).toBeNull();
  });

  it("取消弹窗要求退回金额和收款账户，并按填写值冲销", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: inStockRow,
      orders: [{
        order_id: 21,
        order_type: "HS",
        status: "ACTIVE",
        events: [{ id: 31, event_type: "BUY", amount: "100.00", cancellable_amount: "100.00", portion: "PRINCIPAL", is_posted: true }],
      }],
    } as unknown as AccountExecutionDetail);
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }] as never);
    await openPanel([inStockRow]);
    const cancelRow = (await screen.findByText("acc-1")).closest("tr") as HTMLElement;
    await clickOperation(cancelRow, "取消");

    const modal = await screen.findByRole("dialog");
    const amount = within(modal).getByLabelText("退回金额");
    // 弹窗默认值直接取后端 cancellable_amount（不再由前端按 amount − 已冲销 算）。
    expect((amount as HTMLInputElement).value).toBe("100.00");

    await ui.clear(amount);
    await ui.type(amount, "80");
    await ui.click(within(modal).getByLabelText("收款账户").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("利润池", { selector: ".ant-select-item-option-content" }));
    await ui.type(within(modal).getByLabelText("取消原因"), "   ");
    expect(within(modal).getByText(/按实际退回金额冲销/)).toBeInTheDocument();
    await ui.click(within(modal).getByRole("button", { name: /确认冲销/ }));
    expect(await within(modal).findByText("请填写取消原因")).toBeInTheDocument();
    expect(ordersApi.inventoryOffsale).not.toHaveBeenCalled();
    await ui.clear(within(modal).getByLabelText("取消原因"));
    await ui.type(within(modal).getByLabelText("取消原因"), "取消");
    await ui.click(within(modal).getByRole("button", { name: /确认冲销/ }));

    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(
      21,
      expect.objectContaining({ amount: "80", pool_id: 3, offset_event_id: 31 }),
    ));
  });

  it("回收账号全额取消入库后提示退出库存", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: inStockRow,
      orders: [{
        order_id: 21,
        order_type: "HS",
        status: "ACTIVE",
        events: [{ id: 31, event_type: "BUY", amount: "100.00", cancellable_amount: "100.00", portion: "PRINCIPAL", is_posted: true }],
      }],
    } as unknown as AccountExecutionDetail);
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }] as never);
    await openPanel([inStockRow]);
    await clickOperation(rowOf(1), "取消");
    const modal = await screen.findByRole("dialog");
    await ui.clear(within(modal).getByLabelText("退回金额"));
    await ui.type(within(modal).getByLabelText("退回金额"), "100");
    await ui.click(within(modal).getByLabelText("收款账户").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("利润池", { selector: ".ant-select-item-option-content" }));
    await ui.type(within(modal).getByLabelText("取消原因"), "取消入库回归");
    await ui.click(within(modal).getByRole("button", { name: /确认冲销/ }));

    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(21, expect.objectContaining({ amount: "100", pool_id: 3 })));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith("入库已取消，账号已退出库存"));
  });

  it("未售出账号没有买入流水时可零退款取消", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: inStockRow, orders: [{ order_id: 21, order_type: "HS", status: "ACTIVE", events: [] }] } as unknown as AccountExecutionDetail);
    vi.mocked(poolsApi.list).mockResolvedValue([]);
    await openPanel([inStockRow]);
    await clickOperation(rowOf(1), "取消");
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("退回金额")).toHaveValue("0.00");
    await ui.type(within(modal).getByLabelText("取消原因"), "取消交易");
    await ui.click(within(modal).getByRole("button", { name: "确认冲销" }));
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(21, expect.objectContaining({ amount: "0.00", reason: "取消交易" })));
    expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(21, expect.not.objectContaining({ pool_id: expect.anything() }));
  });

  it("库存取消入库使用退款表单字段并过滤已清空的值", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => scope === "INVREFUND" ? [
      { id: 901, order_type_code: scope, field_key: "receipt", label: "取消凭据", field_type: "TEXT",
        required: true, is_active: true, sort_order: 1, locked: false, is_custom: true, section: "FINANCE" },
      { id: 902, order_type_code: scope, field_key: "optional_number", label: "可选数字", field_type: "NUMBER",
        required: false, is_active: true, sort_order: 2, locked: false, is_custom: true, section: "BUSINESS" },
    ] : []);
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: inStockRow, orders: [{
      order_id: 21, order_type: "HS", status: "ACTIVE", events: [],
    }] } as unknown as AccountExecutionDetail);
    vi.mocked(poolsApi.list).mockResolvedValue([]);
    await openPanel([inStockRow]);
    await clickOperation(rowOf(1), "取消");
    const modal = await screen.findByRole("dialog");
    await ui.type(within(modal).getByLabelText("取消原因"), "取消交易");
    await ui.type(await within(modal).findByLabelText("取消凭据"), "凭据A");
    const optional = within(modal).getByLabelText("可选数字");
    await ui.type(optional, "17");
    await ui.clear(optional);
    await ui.click(within(modal).getByRole("button", { name: "确认冲销" }));
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(21,
      expect.objectContaining({ amount: "0.00", form_extra: { receipt: "凭据A" } })));
    expect(orderFormFieldsApi.list).toHaveBeenCalledWith("INVREFUND", true);
  });

  it.each([
    { mode: "平台下架", option: /千寻（上架于/, button: "确认下架" },
    { mode: "代挂出库", option: /本系统（上架于/, button: "确认出库" },
  ])("$mode 显示其他板块字段并过滤清空的值", async ({ button, option }) => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => scope === "INVOID" ? [
      { id: 901, order_type_code: scope, field_key: "receipt", label: "下架凭据", field_type: "TEXT",
        required: true, is_active: true, sort_order: 1, locked: false, is_custom: true, section: "FINANCE" },
      { id: 902, order_type_code: scope, field_key: "optional_number", label: "可选数字", field_type: "NUMBER",
        required: false, is_active: true, sort_order: 2, locked: false, is_custom: true, section: "BUSINESS" },
    ] : []);
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(consignmentDetail);
    await openPanel([consignmentRow]);
    await clickOperation(rowOf(1), "下架");
    const modal = await screen.findByRole("dialog");
    await ui.click(within(modal).getByRole("combobox", { name: "下架平台" }));
    await ui.click(await screen.findByText(option, { selector: ".ant-select-item-option-content" }));
    await ui.type(within(modal).getByLabelText("下架原因"), "交易结束");
    await ui.type(await within(modal).findByLabelText("下架凭据"), "凭据A");
    const optional = within(modal).getByLabelText("可选数字");
    await ui.type(optional, "17");
    await ui.clear(optional);
    await ui.click(within(modal).getByRole("button", { name: button }));
    const request = button === "确认下架" ? ordersApi.postEvent : ordersApi.inventoryOffsale;
    await waitFor(() => expect(request).toHaveBeenCalled());
    const payload = vi.mocked(request).mock.calls[0][1] as { form_extra?: Record<string, unknown> };
    expect(payload.form_extra).toEqual(expect.objectContaining({ receipt: "凭据A" }));
    expect(payload.form_extra).not.toHaveProperty("optional_number");
  });

  it("代挂下架平台选项包含本系统并显示入库时间", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(consignmentDetail);
    await openPanel([consignmentRow]);
    await clickOperation(rowOf(1), "下架");

    expect(await screen.findByText("本系统")).toBeInTheDocument();
  });

  it("FE-129：无平台的初始代挂动作不生成空平台上架记录", () => {
    const records = consignmentRecords([{
      order_id: 89,
      order_no: "DG-89-BASE",
      order_type: "DG",
      status: "ACTIVE",
      created_at: "2026-11-02T10:00:00",
      trade_date: "2026-11-02",
      extra_values: {},
      events: [],
    }] as unknown as AccountExecutionDetail["orders"]);

    expect(records).toEqual([]);
  });

  it("代挂选择本系统下架时直接取消代挂订单并退出库存中心", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(consignmentDetail);
    vi.mocked(ordersApi.cancel).mockResolvedValue({ status: "CANCELLED" } as never);
    await openPanel([consignmentRow]);
    await clickOperation(rowOf(1), "下架");

    const modal = await screen.findByRole("dialog");
    await ui.click(modal.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText(/本系统（上架于 2026-10-01 09:30）/, { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("下架原因"), "代挂结束");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "操作人" }).closest(".ant-select")).toHaveTextContent("管理员"));
    await ui.click(screen.getByRole("button", { name: "确认出库" }));

    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(
      88,
      expect.objectContaining({
        reason: "代挂结束",
        unlisted_at: expect.any(String),
      }),
    ));
  });

  it.each([
    { label: "平台下架", option: /千寻（上架于/, button: "确认下架", request: ordersApi.postEvent },
    { label: "代挂出库", option: /本系统（上架于/, button: "确认出库", request: ordersApi.inventoryOffsale },
  ])("$label 提交期间防止重复操作", async ({ option, button, request }) => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(consignmentDetail);
    if (button === "确认下架") vi.mocked(ordersApi.postEvent).mockReturnValue(new Promise(() => {}));
    else vi.mocked(ordersApi.inventoryOffsale).mockReturnValue(new Promise(() => {}));
    await openPanel([consignmentRow]);
    await clickOperation(rowOf(1), "下架");
    const modal = await screen.findByRole("dialog");
    await ui.click(modal.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText(option, { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("下架原因"), "结束上架");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "操作人" }).closest(".ant-select")).toHaveTextContent("管理员"));
    const form = screen.getByLabelText("下架原因").closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    fireEvent.submit(form);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: button })).toHaveClass("ant-btn-loading");
  });

  it("平台下架提交填写的原因", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(consignmentDetail);
    await openPanel([consignmentRow]);
    await clickOperation(rowOf(1), "下架");
    const modal = await screen.findByRole("dialog");
    await ui.click(modal.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText(/千寻（上架于/, { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("下架原因"), "平台停售");
    await ui.click(screen.getByRole("button", { name: "确认下架" }));
    await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledWith(88, expect.objectContaining({ reason: "平台停售" })));
  });

  it("平台下架后已展开的库存订单详情显示新的下架记录", async () => {
    const updatedDetail = {
      ...consignmentDetail,
      orders: [{
        ...consignmentDetail.orders[0],
        events: [
          ...consignmentDetail.orders[0].events,
          { id: 802, event_type: "OPERATE", operation_type: "UNLIST", reason: "平台停售", form_extra: { consignment_event_id: 801, consignment_platforms: ["千寻"], platform_unlist_scope: "PLATFORM" } },
        ],
      }],
    } as AccountExecutionDetail;
    let unlisted = false;
    vi.mocked(ordersApi.executionDetail).mockImplementation(async () => unlisted ? updatedDetail : consignmentDetail);
    vi.mocked(ordersApi.postEvent).mockImplementationOnce(async () => { unlisted = true; return {} as never; });
    await openPanel([consignmentRow]);
    fireEvent.click(rowOf(1).querySelector(".ant-table-row-expand-icon") as Element);
    const operationSection = await waitFor(() => {
      const section = document.querySelector<HTMLElement>(".order-detail__section--operation");
      expect(section).toBeTruthy();
      return section!;
    });
    await waitFor(() => expect(within(operationSection).getByText("千寻")).toBeInTheDocument());

    await clickOperation(rowOf(1), "下架");
    const modal = await screen.findByRole("dialog");
    await ui.click(modal.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText(/千寻（上架于/, { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("下架原因"), "平台停售");
    await ui.click(screen.getByRole("button", { name: "确认下架" }));

    await waitFor(() => {
      const section = document.querySelector<HTMLElement>(".order-detail__section--operation");
      expect(section).toBeTruthy();
      expect(within(section!).getByText("千寻 / 下架原因：平台停售")).toBeInTheDocument();
    });
  });

  it("平台下架原因不能只填写空格", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue(consignmentDetail);
    await openPanel([consignmentRow]);
    await clickOperation(rowOf(1), "下架");
    const modal = await screen.findByRole("dialog");
    await ui.click(modal.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText(/千寻（上架于/, { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("下架原因"), "   ");
    await ui.click(screen.getByRole("button", { name: "确认下架" }));
    expect(await screen.findByText("请填写下架原因")).toBeInTheDocument();
    expect(ordersApi.postEvent).not.toHaveBeenCalled();
  });

  it("代挂没有外部上架记录时仍可出库来源订单", async () => {
    const account = { ...consignmentRow, source_order_id: 88 } as Account;
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      ...consignmentDetail,
      account,
      orders: [{ ...consignmentDetail.orders[0], events: [] }],
    });
    vi.mocked(ordersApi.cancel).mockResolvedValue({ status: "CANCELLED" } as never);
    await openPanel([account]);
    await clickOperation(rowOf(1), "下架");
    const modal = await screen.findByRole("dialog");
    await ui.click(modal.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText(/本系统（上架于/, { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("下架原因"), "代挂结束");
    await ui.click(screen.getByRole("button", { name: "确认出库" }));
    await waitFor(() => expect(ordersApi.inventoryOffsale).toHaveBeenCalledWith(88, expect.objectContaining({ reason: "代挂结束" })));
  });

  it("导出：读取明细并提示失败条数", async () => {
    const secondInStockRow = { ...inStockRow, id: 4, game_account: "acc-4" } as unknown as Account;
    await openPanel([inStockRow, secondInStockRow]);
    vi.mocked(stocksApi.inventoryLedgerExport).mockResolvedValueOnce({
      blob: new Blob(["csv"]),
      failedDetailCount: 1,
    });
    await ui.click(screen.getByRole("button", { name: /导出/ }));
    await waitFor(() => expect(stocksApi.inventoryLedgerExport).toHaveBeenCalled());
    await waitFor(() => expect(message.warning).toHaveBeenCalledWith("1 条明细读取失败，已导出其余可用字段"));
  });

  it("导出成功后给出完成反馈", async () => {
    await openPanel([inStockRow]);
    vi.mocked(stocksApi.inventoryLedgerExport).mockResolvedValueOnce({ blob: new Blob(["csv"]), failedDetailCount: 0 });
    await ui.click(screen.getByRole("button", { name: /导出/ }));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith("库存数据已导出"));
  });

});
