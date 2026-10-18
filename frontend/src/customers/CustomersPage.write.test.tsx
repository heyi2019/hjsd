import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { CustomersPage } from "./CustomersPage";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

const list = vi.fn();
const create = vi.fn();
const merge = vi.fn();
const cpList = vi.fn();
const patch = vi.fn();
const fieldsList = vi.fn();
const detail = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  customersApi: {
    list: (...a: unknown[]) => list(...a),
    create: (...a: unknown[]) => create(...a),
    merge: (...a: unknown[]) => merge(...a),
    patch: (...a: unknown[]) => patch(...a),
    setStatus: vi.fn(),
    get: vi.fn(),
    detail: (...a: unknown[]) => detail(...a),
  },
  counterpartiesApi: { list: (...a: unknown[]) => cpList(...a), create: vi.fn(), setStatus: vi.fn() },
  fieldsApi: { list: (...a: unknown[]) => fieldsList(...a), create: vi.fn(), setActive: vi.fn(), remove: vi.fn() },
}));

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
  list.mockResolvedValue(customers);
  cpList.mockResolvedValue([]);
  fieldsList.mockResolvedValue(fieldDefs);
  detail.mockResolvedValue({
    customer: customers[0],
    overview: { order_count: 1, active_order_count: 1, completed_order_count: 0, cancelled_order_count: 0, last_trade_date: "2026-10-18", installment_paid_total: "100.00", installment_receivable_total: "1000.00", installment_remaining_total: "900.00", overdue_period_count: 1 },
    business: [{ order_id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "STOCK", status: "ACTIVE", trade_date: "2026-10-18", roles: ["BUYER"] }],
    installments: [{ id: 20, inst_no: "HS-2026-0010-INS01", order_id: 10, order_no: "HS-2026-0010", contract_type: "STOCK_SALE", status: "OVERDUE", principal: "1000.00", total_receivable: "1000.00", paid_amount: "100.00", remaining_amount: "900.00", overdue_periods: 1, first_due_on: "2026-10-17" }],
    audit: [],
  });
});

describe("CustomersPage：权限门控与写操作", () => {
  it("admin 可见「新建客户」入口", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    expect(screen.getByRole("button", { name: /新建/ })).toBeInTheDocument();
  });

  it("viewer 无 customer.create 权限 → 新建入口不渲染", async () => {
    renderLight(<CustomersPage />, { user: "viewer" });
    await screen.findByText("CUS-0001");
    expect(screen.queryByRole("button", { name: /新建/ })).toBeNull();
  });

  it("非 ACTIVE 客户的合并按钮禁用（不能合并已停用客户）", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    const mergeButtons = screen.getAllByRole("button", { name: /合\s*并/ });
    expect(mergeButtons.length).toBe(2);
    expect(mergeButtons.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    expect(mergeButtons.some((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("新建客户提交后回传字段并刷新列表", async () => {
    create.mockResolvedValueOnce({ customer: { id: 3, customer_no: "CUS-0003" }, duplicate_candidates: [] });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("button", { name: /新建/ }));
    await ui.type(await screen.findByLabelText("名字"), "王五");
    await ui.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ display_name: "王五" });
  });

  it("重复候选不拦截，只提示（创建仍成功）", async () => {
    create.mockResolvedValueOnce({ customer: { id: 4 }, duplicate_candidates: [{ id: 2 }] });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("button", { name: /新建/ }));
    await ui.type(await screen.findByLabelText("名字"), "李四");
    await ui.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(await screen.findByText(/重复候选/)).toBeInTheDocument();
  });

  it("客户详情加载经营概览、关联订单和分期收款", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getAllByRole("button", { name: /详\s*情/ })[0]);
    expect(detail).toHaveBeenCalledWith(1);
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
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ keyword: "张三" }));
  });
});

