import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appMessage as message } from "../shared/ui/appFeedback";
import { renderLight } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";
import * as catalog from "../shared/api/catalog";
import { resolveMock } from "../test/mock-api";
import { seedOptionSets } from "../test/formFieldsSeed";
import type { Account, AccountExecutionDetail, Installment } from "../shared/api/catalog";

vi.mock("../shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api/catalog")>();
  const METHODS = [
    "list", "get", "create", "update", "patch", "post", "postEvent", "remove", "cancel", "skip", "markUnlinked",
    "setStatus", "setActive", "resolve", "release", "settle", "approve", "reject",
    "reverse", "close", "convert", "detail", "allocations", "setAllocations",
    "balance", "executionDetail", "updateProfile", "updateExecution", "merge", "search",
  ];
  const mk = (api: Record<string, unknown>) => {
    const o: Record<string, unknown> = { ...api };
    for (const m of METHODS) {
      if (m in o) o[m] = vi.fn();
    }
    return o;
  };
  const out: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(actual)) {
    const v = (actual as Record<string, unknown>)[key];
    if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).some((x) => typeof x === "function")) {
      out[key] = mk(v as Record<string, unknown>);
    }
  }
  return out as unknown as typeof actual;
});

let ui: ReturnType<typeof userEvent.setup>;

const inStockRow = {
  id: 1, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "安卓",
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
    extra_values: { consignment_platform: "千寻", listed_at: "2026-10-29T03:54" },
    events: [],
  }],
} as unknown as AccountExecutionDetail;

const contract = { id: 21, inst_no: "INS-21", order_id: 77, contract_type: "INSTALLMENT", status: "ACTIVE" } as unknown as Installment;

async function openPanel(rows: Account[]) {
  resolveMock(vi.mocked(catalog.stocksApi.list), rows);
  renderLight(<InventoryPanel />, { user: "admin" });
  await waitFor(() => expect(document.querySelector("tbody tr")).toBeTruthy());
}

function rowOf(id: number): HTMLElement {
  const rows = Array.from(document.querySelectorAll("tbody tr")) as HTMLElement[];
  const row = rows.find((r) => r.textContent?.includes(`acc-${id}`));
  return row as HTMLElement;
}

async function clickMore(row: HTMLElement, item: string) {
  fireEvent.click(within(row).getByRole("button", { name: /更多/ }));
  // 菜单项文本可能与行内按钮/弹窗标题重名，必须限定在 role=menu 内点击
  fireEvent.click(within(await screen.findByRole("menu")).getByText(item));
}

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
  URL.revokeObjectURL = vi.fn();
  seedOptionSets(catalog);
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.installmentsApi.list).mockResolvedValue([contract]);
  vi.mocked(catalog.installmentsApi.cancel).mockResolvedValue({} as never);
  vi.mocked(catalog.ordersApi.postEvent).mockResolvedValue({} as never);
  vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue(sellDetail);
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "warning").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "info").mockImplementation((() => undefined) as never);
});

describe("InventoryPanel：更多菜单 / 退款取消 / 导出", () => {
  it("更多菜单 → 描述：打开描述编辑弹窗", async () => {
    await openPanel([inStockRow]);
    await clickMore(rowOf(1), "描述");
    expect((await screen.findAllByText("描述")).length).toBeGreaterThan(0);
  });

  it("更多菜单 → 作图：打开图片编辑弹窗", async () => {
    await openPanel([inStockRow]);
    await clickMore(rowOf(1), "作图");
    expect((await screen.findAllByText("作图")).length).toBeGreaterThan(0);
  });

  it("非代挂在库账号不展示下架入口", async () => {
    await openPanel([inStockRow]);
    fireEvent.click(within(rowOf(1)).getByRole("button", { name: /更多/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("下架")).toBeNull();
    expect(within(menu).getByText("描述")).toBeInTheDocument();
    expect(within(menu).getByText("作图")).toBeInTheDocument();
  });

  it("取消弹窗要求退回金额和收款账户，并按填写值冲销", async () => {
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({
      account: inStockRow,
      orders: [{
        order_id: 21,
        order_type: "HS",
        status: "ACTIVE",
        events: [{ id: 31, event_type: "BUY", amount: "100.00", portion: "PRINCIPAL", is_posted: true }],
      }],
    } as unknown as AccountExecutionDetail);
    vi.mocked(catalog.poolsApi.list).mockResolvedValue([{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }] as never);
    await openPanel([inStockRow]);
    const cancelRow = (await screen.findByText("acc-1")).closest("tr") as HTMLElement;
    await clickMore(cancelRow, "取消");

    const modal = await screen.findByRole("dialog");
    const amount = within(modal).getByLabelText("退回金额");
    const account = within(modal).getByLabelText("收款账户");
    expect(within(modal).getByText("取消原因")).toBeInTheDocument();
    expect(within(modal).queryByText("下架原因")).toBeNull();
    expect(amount.closest(".adaptive-form-grid")).toBe(account.closest(".adaptive-form-grid"));
    expect(amount.closest(".adaptive-form-grid")).toHaveClass("inventory-void-fields");

    await ui.clear(amount);
    await ui.type(amount, "80");
    await ui.click(account.closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("利润池（HJ_PROFIT）", { selector: ".ant-select-item-option-content" }));
    await ui.type(within(modal).getByLabelText("取消原因"), "取消交易");
    await ui.click(within(modal).getByRole("button", { name: /确认下架/ }));

    await waitFor(() => expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(
      21,
      expect.objectContaining({ amount: "80", pool_id: 3, event_type: "CANCEL" }),
    ));
  });

  it("FE-264：系统下架完整提交关闭弹窗并给出成功结果", async () => {
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({
      account: inStockRow,
      orders: [{
        order_id: 21,
        order_type: "HS",
        status: "ACTIVE",
        events: [{ id: 31, event_type: "BUY", amount: "100.00", portion: "PRINCIPAL", is_posted: true }],
      }],
    } as unknown as AccountExecutionDetail);
    vi.mocked(catalog.poolsApi.list).mockResolvedValue([{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }] as never);
    await openPanel([inStockRow]);
    await clickMore(rowOf(1), "取消");
    const modal = await screen.findByRole("dialog");
    await ui.clear(within(modal).getByLabelText("退回金额"));
    await ui.type(within(modal).getByLabelText("退回金额"), "80");
    await ui.click(within(modal).getByLabelText("收款账户").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("利润池（HJ_PROFIT）", { selector: ".ant-select-item-option-content" }));
    await ui.type(within(modal).getByLabelText("取消原因"), "系统下架回归");
    await ui.click(within(modal).getByRole("button", { name: /确认下架/ }));

    await waitFor(() => expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(21, expect.objectContaining({ event_type: "CANCEL", amount: "80", pool_id: 3 })));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith("账号已下架"));
  });

  it("代挂下架平台选项包含本系统并显示入库时间", async () => {
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue(consignmentDetail);
    await openPanel([consignmentRow]);
    await clickMore(rowOf(1), "下架");

    expect(await screen.findByText("本系统")).toBeInTheDocument();
    expect(screen.getByText("2026-10-01 09:30")).toBeInTheDocument();
  });

  it("代挂选择本系统下架时直接取消代挂订单并退出库存中心", async () => {
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue(consignmentDetail);
    vi.mocked(catalog.ordersApi.cancel).mockResolvedValue({ status: "CANCELLED" } as never);
    await openPanel([consignmentRow]);
    await clickMore(rowOf(1), "下架");

    const modal = await screen.findByRole("dialog");
    await ui.click(modal.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText(/本系统（上架于 2026-10-01 09:30）/, { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("下架原因"), "代挂结束");
    await ui.click(screen.getByRole("button", { name: "确认出库" }));

    await waitFor(() => expect(catalog.ordersApi.cancel).toHaveBeenCalledWith(
      88,
      expect.objectContaining({
        reason: "代挂结束",
        form_extra_scope: "INVOID",
        form_extra: expect.objectContaining({ platform_unlist_scope: "SYSTEM" }),
      }),
    ));
    expect(screen.queryByText("系统下架登记")).toBeNull();
  });

  it("导出：读取明细并提示失败条数", async () => {
    const secondInStockRow = { ...inStockRow, id: 4, game_account: "acc-4" } as unknown as Account;
    await openPanel([inStockRow, secondInStockRow]);
    vi.mocked(catalog.stocksApi.executionDetail)
      .mockResolvedValueOnce(sellDetail)
      .mockRejectedValueOnce(new Error("detail down"));
    await ui.click(screen.getByRole("button", { name: /导出/ }));
    await waitFor(() => expect(catalog.stocksApi.executionDetail).toHaveBeenCalled());
    await waitFor(() => expect(message.warning).toHaveBeenCalledWith("1 条明细读取失败，已导出其余可用字段"));
  });

  it("导出成功后给出完成反馈", async () => {
    await openPanel([inStockRow]);
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValueOnce(sellDetail);
    await ui.click(screen.getByRole("button", { name: /导出/ }));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith("库存 CSV 已导出"));
  });

  it("FE-258：图片资料保存失败时保留弹窗并显示可重试错误态", async () => {
    vi.mocked(catalog.stocksApi.updateProfile).mockRejectedValueOnce(new Error("image save timeout"));
    await openPanel([inStockRow]);
    await clickMore(rowOf(1), "作图");
    await ui.click(screen.getByRole("button", { name: /保存/ }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect((await screen.findAllByText("作图")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /保存/ })).toBeInTheDocument();
  });
});
