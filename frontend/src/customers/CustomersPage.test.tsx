import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { CustomersPage } from "./CustomersPage";

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
  counterpartiesApi: {
    list: (...a: unknown[]) => cpList(...a),
    create: vi.fn(),
    setStatus: vi.fn(),
  },
  fieldsApi: {
    list: (...a: unknown[]) => fieldsList(...a),
    create: vi.fn(),
    setActive: vi.fn(),
    remove: vi.fn(),
  },
}));

/** 活字段定义：SELECT / MULTI_SELECT / 停用字段各一，覆盖动态渲染与历史值展示 */
const fieldDefs = [
  {
    id: 1,
    entity_type: "customer",
    field_key: "game_category",
    label: "常玩品类",
    field_type: "MULTI_SELECT",
    options: ["王者荣耀", "和平精英"],
    required: false,
    sort_order: 10,
    is_active: true,
  },
  {
    id: 2,
    entity_type: "customer",
    field_key: "credit_level",
    label: "信用评级",
    field_type: "SELECT",
    options: ["优质", "一般", "观察", "黑名单"],
    required: false,
    sort_order: 20,
    is_active: true,
  },
  {
    id: 3,
    entity_type: "customer",
    field_key: "referrer",
    label: "转介绍人",
    field_type: "TEXT",
    options: null,
    required: false,
    sort_order: 30,
    is_active: true,
  },
  {
    id: 4,
    entity_type: "customer",
    field_key: "legacy_note",
    label: "历史备注",
    field_type: "TEXT",
    options: null,
    required: false,
    sort_order: 40,
    is_active: false,
  },
] as unknown as import("../shared/api/catalog").FieldDefinition[];

const customers = [
  {
    id: 1,
    customer_no: "CUS-0001",
    display_name: "张三",
    phone: "138****8888",
    wechat: "zhangsan",
    qq: "10001",
    status: "ACTIVE",
    extra_values: { credit_level: "优质", legacy_note: "早期客户" },
  },
  {
    id: 2,
    customer_no: "CUS-0002",
    display_name: "李四",
    phone: "139****9999",
    wechat: "",
    qq: "",
    status: "DISABLED",
    extra_values: {},
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(customers);
  cpList.mockResolvedValue([]);
  fieldsList.mockResolvedValue(fieldDefs);
  detail.mockResolvedValue({
    customer: customers[0],
    overview: {
      order_count: 1,
      active_order_count: 1,
      completed_order_count: 0,
      cancelled_order_count: 0,
      last_trade_date: "2026-10-18",
      installment_paid_total: "100.00",
      installment_receivable_total: "1000.00",
      installment_remaining_total: "900.00",
      overdue_period_count: 1,
    },
    business: [{
      order_id: 10,
      order_no: "HS-2026-0010",
      order_type: "HS",
      capital_type: "STOCK",
      status: "ACTIVE",
      trade_date: "2026-10-18",
      roles: ["BUYER"],
    }],
    installments: [{
      id: 20,
      inst_no: "HS-2026-0010-INS01",
      order_id: 10,
      order_no: "HS-2026-0010",
      contract_type: "STOCK_SALE",
      status: "OVERDUE",
      principal: "1000.00",
      total_receivable: "1000.00",
      paid_amount: "100.00",
      remaining_amount: "900.00",
      overdue_periods: 1,
      first_due_on: "2026-10-17",
    }],
    audit: [],
  });
});
describe("CustomersPage：客户档案", () => {
  it("加载成功后渲染客户编号与状态标签", async () => {
    renderLight(<CustomersPage />);
    expect(await screen.findByText("CUS-0001")).toBeInTheDocument();
    expect(screen.getByText("CUS-0002")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument(); // ACTIVE
    // 「已停用」同时出现在统计卡与状态标签 → 用 All 变体（skill 提示的重复文案坑）
    expect(screen.getAllByText("已停用").length).toBeGreaterThanOrEqual(1); // DISABLED
  });

  it("后端不可达时显示错误条而不是空白页", async () => {
    list.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<CustomersPage />);
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("业务错误码给出可执行的处置提示", async () => {
    list.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "PERMISSION_DENIED", message: "当前角色无此权限" } },
      message: "Request failed",
    });
    renderLight(<CustomersPage />);
    expect(await screen.findByText(/联系管理员/)).toBeInTheDocument();
  });

  it("客户与合作方分 Tab，不混用（CUS-01）", async () => {
    renderLight(<CustomersPage />);
    await screen.findByText("CUS-0001");
    expect(screen.getByRole("tab", { name: "客户档案" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /合作方/ })).toBeInTheDocument();
  });
});
