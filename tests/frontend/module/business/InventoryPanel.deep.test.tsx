import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { renderLight } from "@fixtures/render";
import { InventoryPanel } from "@/stocks/InventoryPanel";
import { consignmentRecords } from "@/orders/operations/offsale";
import { installmentsApi } from "@/shared/api/installments.api";
import { ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { resolveMock } from "@fixtures/mock-api";
import { seedOptionSets } from "@fixtures/formFieldsSeed";
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
vi.mock("@/shared/api/policy.api");
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
  vi.mocked(stocksApi.inventoryLedger).mockResolvedValue({
    items: rows.map((row) => ({
      account: row,
      order: {
        id: row.source_order_id ?? row.id,
        order_no: row.source_order_no ?? `HS-${row.id}`,
        order_type: row.inventory_type === "CONSIGNMENT" ? "DG" : "HS",
        capital_type: "SELF",
        trade_date: "2026-10-15",
        account_id: row.id,
        account_status: "WAITING",
        status: "ACTIVE",
      },
    })),
    total: rows.length,
    facet_total: rows.length,
    type_counts: { RECOVERY: rows.length },
    game_types: ["王者荣耀"],
    stats: { account_count: rows.length, occupied_cost: "100.00", over_7d_count: 0, over_30d_count: 0 },
  } as never);
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
  URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  seedOptionSets();
  vi.mocked(employeesApi.list).mockResolvedValue([]);
  vi.mocked(installmentsApi.list).mockResolvedValue([contract]);
  vi.mocked(installmentsApi.cancel).mockResolvedValue({} as never);
  vi.mocked(ordersApi.postEvent).mockResolvedValue({} as never);
  vi.mocked(ordersApi.executionDetail).mockResolvedValue(sellDetail);
  vi.mocked(stocksApi.inventoryLedgerExport).mockResolvedValue({ blob: new Blob(["csv"]), failedDetailCount: 0 });
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "warning").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "info").mockImplementation((() => undefined) as never);
});

describe("InventoryPanel：运营动作 / 退款取消 / 导出", () => {
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
    const account = within(modal).getByLabelText("收款账户");
    // 弹窗默认值直接取后端 cancellable_amount（不再由前端按 amount − 已冲销 算）。
    expect((amount as HTMLInputElement).value).toBe("100.00");

    await ui.clear(amount);
    await ui.type(amount, "80");
    await ui.click(account.closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("利润池（HJ_PROFIT）", { selector: ".ant-select-item-option-content" }));
    await ui.type(within(modal).getByLabelText("取消原因"), "取消");
    await ui.click(within(modal).getByRole("button", { name: /确认下架/ }));

    await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledWith(
      21,
      expect.objectContaining({ amount: "80", pool_id: 3, event_type: "CANCEL" }),
    ));
  });

  it("FE-264：系统下架完整提交关闭弹窗并给出成功结果", async () => {
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
    await ui.type(within(modal).getByLabelText("退回金额"), "80");
    await ui.click(within(modal).getByLabelText("收款账户").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("利润池（HJ_PROFIT）", { selector: ".ant-select-item-option-content" }));
    await ui.type(within(modal).getByLabelText("取消原因"), "系统下架回归");
    await ui.click(within(modal).getByRole("button", { name: /确认下架/ }));

    await waitFor(() => expect(ordersApi.postEvent).toHaveBeenCalledWith(21, expect.objectContaining({ event_type: "CANCEL", amount: "80", pool_id: 3 })));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith("账号已下架"));
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
    await ui.click(screen.getByRole("button", { name: "确认出库" }));

    await waitFor(() => expect(ordersApi.cancel).toHaveBeenCalledWith(
      88,
      expect.objectContaining({
        reason: "代挂结束",
        form_extra_scope: "INVOID",
        form_extra: expect.objectContaining({ platform_unlist_scope: "SYSTEM" }),
      }),
    ));
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
    await waitFor(() => expect(message.success).toHaveBeenCalledWith("库存 CSV 已导出"));
  });

});
