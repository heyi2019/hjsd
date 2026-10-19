import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { message } from "antd";
import { CustomersPage } from "./CustomersPage";

import * as catalog from "../shared/api/catalog";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("../shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api/catalog")>();
  const METHODS = [
    "list", "get", "create", "update", "patch", "post", "postEvent", "remove",
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
vi.mock("./CustomerLeadPanel", () => ({ CustomerLeadPanel: () => <div /> }));

const fieldDefs = [
  { id: 1, entity_type: "customer", field_key: "game_category", label: "常玩品类", field_type: "MULTI_SELECT", options: ["王者荣耀", "和平精英"], required: false, sort_order: 10, is_active: true },
  { id: 2, entity_type: "customer", field_key: "credit_level", label: "信用评级", field_type: "SELECT", options: ["优质", "一般", "观察", "黑名单"], required: false, sort_order: 20, is_active: true },
  { id: 3, entity_type: "customer", field_key: "referrer", label: "转介绍人", field_type: "TEXT", options: null, required: false, sort_order: 30, is_active: true },
  { id: 4, entity_type: "customer", field_key: "legacy_note", label: "历史备注", field_type: "TEXT", options: null, required: false, sort_order: 40, is_active: false },
] as unknown as import("../shared/api/catalog").FieldDefinition[];

const customers = [
  { id: 1, customer_no: "CUS-0001", display_name: "张三", phone: "138****8888", wechat: "zhangsan", qq: "10001", status: "ACTIVE", extra_values: { credit_level: "优质", legacy_note: "早期客户" } },
  { id: 2, customer_no: "CUS-0002", display_name: "李四", phone: "139****9999", wechat: "", qq: "", status: "DISABLED", extra_values: {} },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.customersApi.list).mockResolvedValue(customers);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.fieldsApi.list).mockResolvedValue(fieldDefs);
  vi.mocked(catalog.customersApi.detail).mockResolvedValue({
    customer: customers[0],
    overview: { order_count: 1, active_order_count: 1, completed_order_count: 0, cancelled_order_count: 0, last_trade_date: "2026-10-18", installment_paid_total: "100.00", installment_receivable_total: "1000.00", installment_remaining_total: "900.00", overdue_period_count: 1 },
    business: [{ order_id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "STOCK", status: "ACTIVE", trade_date: "2026-10-18", roles: ["BUYER"] }],
    installments: [{ id: 20, inst_no: "HS-2026-0010-INS01", order_id: 10, order_no: "HS-2026-0010", contract_type: "STOCK_SALE", status: "OVERDUE", principal: "1000.00", total_receivable: "1000.00", paid_amount: "100.00", remaining_amount: "900.00", overdue_periods: 1, first_due_on: "2026-10-17" }],
    audit: [],
  });
});

describe("CustomersPage：权限门控与写操作", () => {
  it("admin 可见「新建客户」入口，且非 ACTIVE 客户合并按钮禁用", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    // 合并两个同为 admin 上下文的静态断言，省一次完整 antd 挂载
    expect(screen.getByRole("button", { name: /新建/ })).toBeInTheDocument();
    const mergeButtons = screen.getAllByRole("button", { name: /合\s*并/ });
    expect(mergeButtons.length).toBe(2);
    expect(mergeButtons.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    expect(mergeButtons.some((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("viewer 无 customer.create 权限 → 新建入口不渲染", async () => {
    renderLight(<CustomersPage />, { user: "viewer" });
    await screen.findByText("CUS-0001");
    expect(screen.queryByRole("button", { name: /新建/ })).toBeNull();
  });

  it("新建客户提交后回传字段并刷新列表", async () => {
    vi.mocked(catalog.customersApi.create).mockResolvedValueOnce({ customer: { id: 3, customer_no: "CUS-0003" }, duplicate_candidates: [] });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("button", { name: /新建/ }));
    await ui.type(await screen.findByLabelText("名字"), "王五");
    await ui.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(vi.mocked(catalog.customersApi.create)).toHaveBeenCalled());
    expect(vi.mocked(catalog.customersApi.create).mock.calls[0][0]).toMatchObject({ display_name: "王五" });
  });

  it("重复候选不拦截，只提示（创建仍成功）", async () => {
    const warningSpy = vi.spyOn(message, "warning");
    vi.mocked(catalog.customersApi.create).mockResolvedValueOnce({ customer: { id: 4 }, duplicate_candidates: [{ id: 2 }] });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("button", { name: /新建/ }));
    await ui.type(await screen.findByLabelText("名字"), "李四");
    await ui.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(vi.mocked(catalog.customersApi.create)).toHaveBeenCalled());
    // 只提示：message.warning 携带「重复候选」文案（renderLight 未用 antd <App>，静态 message 不进 React 树，故不查 DOM 文本）
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("重复候选"));
    // 未拦截：创建成功后走成功分支刷新列表（customersApi.list 第 2 次调用）
    await waitFor(() => expect(vi.mocked(catalog.customersApi.list)).toHaveBeenCalledTimes(2));
  });

  it("客户详情加载经营概览、关联订单和分期收款", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getAllByRole("button", { name: /详\s*情/ })[0]);
    expect(vi.mocked(catalog.customersApi.detail)).toHaveBeenCalledWith(1);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("经营概览")).toBeInTheDocument();
    expect(within(drawer).getAllByText("关联订单").length).toBeGreaterThanOrEqual(2);
    expect(within(drawer).getAllByText("HS-2026-0010").length).toBeGreaterThanOrEqual(2);
    expect(within(drawer).getByText("分期收款")).toBeInTheDocument();
    expect(within(drawer).getByText("逾期 1 期")).toBeInTheDocument();
  });

  it("客户列表支持关键词搜索并把条件传给后端", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.type(screen.getByLabelText("搜索客户"), "张三");
    await ui.keyboard("{Enter}");
    // 用 toHaveBeenCalledWith 而非 toHaveBeenLastCalledWith：搜索后页面可能再触发一次刷新调用，
    // 断言「关键词确实传给了后端」才是本用例的意图，避免与刷新调用竞争导致偶发红。
    await waitFor(() => expect(vi.mocked(catalog.customersApi.list)).toHaveBeenCalledWith({ keyword: "张三" }));
  });
});

