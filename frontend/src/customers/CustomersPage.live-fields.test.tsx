import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { CustomersPage } from "./CustomersPage";
import { resolveMockOnce } from "../test/mock-api";

import * as catalog from "../shared/api/catalog";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("../shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api/catalog")>();
  const mk = (api: Record<string, unknown>) => {
    const o: Record<string, unknown> = { ...api };
    for (const m of ["list","get","create","update","patch","post","postEvent","remove","setStatus","setActive","resolve","release","settle","approve","reject","reverse","close","convert","detail","allocations","setAllocations","balance","executionDetail","updateProfile","updateExecution","merge","search"]) {
      if (m in o) o[m] = vi.fn();
    }
    return o;
  };
  return {
    ...actual,
    customersApi: mk(actual.customersApi),
    counterpartiesApi: mk(actual.counterpartiesApi),
    fieldsApi: mk(actual.fieldsApi),
    leadsApi: mk(actual.leadsApi),
  };
});

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
  vi.mocked(catalog.customersApi.list).mockResolvedValue(customers);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.leadsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.fieldsApi.list).mockResolvedValue(fieldDefs);
  vi.mocked(catalog.customersApi.detail).mockResolvedValue({
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
describe("CustomersPage：活字段（BAS-04）", () => {
  it("列表按字段定义渲染活字段摘要列", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    expect(await screen.findByText(/信用评级：优质/)).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(catalog.fieldsApi.list)).toHaveBeenCalledWith({ entity_type: "customer" }));
  });

  it("新建弹窗动态渲染活字段控件，提交时回传 extra_values", async () => {
    resolveMockOnce(vi.mocked(catalog.customersApi.create), { customer: { id: 3 }, duplicate_candidates: [] });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("button", { name: /新建/ }));
    await ui.type(await screen.findByLabelText("名字"), "王五");
    await ui.type(await screen.findByLabelText("转介绍人"), "老王");
    await ui.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(vi.mocked(catalog.customersApi.create)).toHaveBeenCalled());
    expect(vi.mocked(catalog.customersApi.create).mock.calls[0][0]).toMatchObject({ display_name: "王五", extra_values: { referrer: "老王" } });
  });

  it("详情抽屉展示活字段值，停用字段标注保留历史值", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getAllByRole("button", { name: /详\s*情/ })[0]);
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("信用评级")).toBeInTheDocument();
    expect(within(drawer).getByText("优质")).toBeInTheDocument();
    expect(within(drawer).getByText("历史备注（已停用）")).toBeInTheDocument();
    expect(within(drawer).getByText("早期客户")).toBeInTheDocument();
  });

  it("活字段定义接口失败不阻断客户页渲染", async () => {
    vi.mocked(catalog.fieldsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<CustomersPage />, { user: "admin" });
    expect(await screen.findByText("CUS-0001")).toBeInTheDocument();
  });
});
