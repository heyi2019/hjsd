import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { CustomersPage } from "./CustomersPage";

import * as catalog from "../shared/api/catalog";
import { seedOptionSets } from "../test/formFieldsSeed";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("../shared/api/catalog");
vi.mock("./CustomerLeadPanel", () => ({ CustomerLeadPanel: () => <div /> }));

const fieldDefs = [
  { id: 1, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "game_category", label: "常玩品类", field_type: "MULTI_SELECT", options: [{ value: "王者荣耀", label: "王者荣耀" }, { value: "和平精英", label: "和平精英" }], required: false, sort_order: 10, is_active: true },
  { id: 2, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "credit_level", label: "信用评级", field_type: "SELECT", options: [{ value: "优质", label: "优质" }, { value: "一般", label: "一般" }, { value: "观察", label: "观察" }, { value: "黑名单", label: "黑名单" }], required: false, sort_order: 20, is_active: true },
  { id: 3, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "referrer", label: "转介绍人", field_type: "TEXT", options: null, required: false, sort_order: 30, is_active: true },
  { id: 4, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "legacy_note", label: "历史备注", field_type: "TEXT", options: null, required: false, sort_order: 40, is_active: false },
] as unknown as import("../shared/api/catalog").OrderFormField[];

const customers = [
  { id: 1, customer_no: "CUS-0001", display_name: "张三", contact_name: "张", phone: "138", wechat: "z", qq: "1", status: "ACTIVE", note: "老客户", extra_values: { credit_level: "优质" } },
  { id: 2, customer_no: "CUS-0002", display_name: "李四", contact_name: "李", phone: "139", wechat: "", qq: "2", status: "ACTIVE", note: "", extra_values: {} },
  { id: 3, customer_no: "CUS-0003", display_name: "王五", contact_name: "", phone: "", wechat: "", qq: "", status: "DISABLED", note: "", extra_values: {} },
];
const counterparties = [
  { id: 11, counterparty_no: "CP-0001", display_name: "同行甲", type: "PEER", contact_name: "李经理", phone: "136", wechat: "peer_a", qq: "20001", status: "ACTIVE" },
];
const detail = {
  customer: customers[0],
  overview: { order_count: 1, active_order_count: 1, completed_order_count: 0, cancelled_order_count: 0, last_trade_date: "2026-10-18", installment_paid_total: "100.00", installment_receivable_total: "1000.00", installment_remaining_total: "900.00", overdue_period_count: 1 },
  business: [{ order_id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "STOCK", status: "ACTIVE", trade_date: "2026-10-18", roles: ["BUYER"] }],
  installments: [{ id: 20, inst_no: "HS-2026-0010-INS01", order_id: 10, order_no: "HS-2026-0010", contract_type: "STOCK_SALE", status: "OVERDUE", principal: "1000.00", total_receivable: "1000.00", paid_amount: "100.00", remaining_amount: "900.00", overdue_periods: 1, first_due_on: "2026-10-17" }],
  audit: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  seedOptionSets(catalog);
  vi.mocked(catalog.customersApi.list).mockResolvedValue(customers as unknown as never);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue(counterparties as unknown as never);
  vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue(fieldDefs as unknown as never);
  vi.mocked(catalog.customersApi.detail).mockResolvedValue(detail as unknown as never);
  vi.mocked(catalog.counterpartiesApi.get).mockResolvedValue(counterparties[0] as unknown as never);
});

describe("CustomersPage：写操作提交流（加深覆盖）", () => {
  it("拉黑 ACTIVE 客户：确认后调用 setStatus(DISABLED) 并提示", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getAllByRole("button", { name: /拉\s*黑/ })[0]); // CUS-0001
    const confirm = await screen.findByRole("button", { name: /确\s*定|确\s*认/ });
    await ui.click(confirm);
    await waitFor(() => expect(vi.mocked(catalog.customersApi.setStatus)).toHaveBeenCalledWith(1, "DISABLED"));
  });

  it("合并客户：选择目标与原因后提交调用 merge", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getAllByRole("button", { name: /合\s*并/ })[0]); // CUS-0001
    const modal = await screen.findByRole("dialog");
    const selector = modal.querySelector(".ant-select-selector") as Element;
    await ui.click(selector);
    const dropdowns = document.querySelectorAll(".ant-select-dropdown");
    const current = dropdowns[dropdowns.length - 1] as HTMLElement;
    await ui.click(await within(current).findByText("CUS-0002 李四"));
    await ui.type(modal.querySelector("#reason") ?? modal, "重复建档合并");
    await ui.click(within(modal).getByRole("button", { name: /确认合并/ }));
    await waitFor(() => expect(vi.mocked(catalog.customersApi.merge)).toHaveBeenCalled());
    const [id, targetId, reason] = vi.mocked(catalog.customersApi.merge).mock.calls[0] as [number, number, string];
    expect(id).toBe(1);
    expect(targetId).toBe(2);
    expect(reason).toBe("重复建档合并");
  });

  it("编辑客户：详情抽屉内编辑入口修改名字后提交 patch", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    const detailButtons = await screen.findAllByRole("button", { name: /详\s*情/ });
    await ui.click(detailButtons[0]);
    const drawer = await screen.findByRole("dialog");
    await ui.click(within(drawer).getByRole("button", { name: /编\s*辑/ }));
    await screen.findByText("编辑客户 · CUS-0001");
    await ui.clear(screen.getByLabelText("名字"));
    await ui.type(screen.getByLabelText("名字"), "张三新");
    await ui.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(vi.mocked(catalog.customersApi.patch)).toHaveBeenCalled());
    const [id, payload] = vi.mocked(catalog.customersApi.patch).mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(1);
    expect(payload.display_name).toBe("张三新");
  });

  it("合作方编辑提交：修改名称后调用 counterpartiesApi.patch", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("tab", { name: /合作方/ }));
    const panel = await screen.findByRole("tabpanel");
    await ui.click(within(panel).getByRole("button", { name: /编\s*辑/ }));
    await screen.findByText("编辑合作方 · CP-0001");
    await ui.clear(screen.getByLabelText("名称"));
    await ui.type(screen.getByLabelText("名称"), "同行甲新");
    await ui.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(vi.mocked(catalog.counterpartiesApi.patch)).toHaveBeenCalled());
    const [id, payload] = vi.mocked(catalog.counterpartiesApi.patch).mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(11);
    expect(payload.display_name).toBe("同行甲新");
  });

  it("合作方拉黑：确认后调用 counterpartiesApi.setStatus", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("tab", { name: /合作方/ }));
    const panel = await screen.findByRole("tabpanel");
    await ui.click(within(panel).getByRole("button", { name: /拉\s*黑/ }));
    const confirm = await screen.findByRole("button", { name: /确\s*定|确\s*认/ });
    await ui.click(confirm);
    await waitFor(() => expect(vi.mocked(catalog.counterpartiesApi.setStatus)).toHaveBeenCalledWith(11, false));
  });

  it("窄屏（compact）渲染移动端客户列表", async () => {
    const matchMediaSpy = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: /max-width:\s*640px/.test(query),
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    renderLight(<CustomersPage />, { user: "admin" });
    expect(await screen.findByText(/CUS-0001/)).toBeInTheDocument();
    expect(document.querySelector(".customers-mobile-list")).toBeInTheDocument();
    matchMediaSpy.mockRestore();
  });
});
