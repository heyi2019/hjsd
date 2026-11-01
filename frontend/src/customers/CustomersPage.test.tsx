import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { CustomersPage } from "./CustomersPage";

import * as catalog from "../shared/api/catalog";
import { seedOptionSets } from "../test/formFieldsSeed";
vi.mock("../shared/api/catalog")
vi.mock("./CustomerLeadPanel", () => ({ CustomerLeadPanel: () => <div /> }));

const customers = [
  {
    id: 1,
    customer_no: "CUS-0001",
    display_name: "张三",
    phone: "138****8888",
    wechat: "zhangsan",
    qq: "10001",
    status: "ACTIVE",
    created_at: "2026-10-18T09:00:00",
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
    created_at: "2026-09-30T09:00:00",
    extra_values: {},
  },
];

const counterparties = [
  {
    id: 11,
    counterparty_no: "CP-0001",
    display_name: "同行甲",
    type: "PEER",
    contact_name: "李经理",
    phone: "136****6666",
    wechat: "peer_a",
    qq: "20001",
    status: "ACTIVE",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  seedOptionSets(catalog);
  vi.mocked(catalog.customersApi.list).mockResolvedValue(customers);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([]);
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
describe("CustomersPage：客户档案", () => {
  it("从客户中心深链参数打开指定客户卡片", async () => {
    renderLight(<CustomersPage focusCustomerId={1} />);
    expect(await screen.findByText("客户档案 · CUS-0001")).toBeInTheDocument();
  });

  it("从客户中心深链参数打开指定合作方卡片", async () => {
    vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue(counterparties);
    vi.mocked(catalog.counterpartiesApi.get).mockResolvedValue(counterparties[0]);
    renderLight(<CustomersPage focusCounterpartyId={11} />);
    expect(await screen.findByText("合作方档案 · CP-0001")).toBeInTheDocument();
  });

  it("加载成功后渲染客户编号与状态标签", async () => {
    renderLight(<CustomersPage />);
    expect(await screen.findByText("CUS-0001")).toBeInTheDocument();
    expect(screen.getByText("CUS-0002")).toBeInTheDocument();
    // ACTIVE 文案现由 CUSTOMER_STATUS 选项词典提供（设置页可改）
    expect(screen.getByText("启用中")).toBeInTheDocument(); // ACTIVE
    expect(screen.getAllByText("已拉黑").length).toBeGreaterThanOrEqual(1); // DISABLED
  });

  it("客户状态筛选覆盖已合并状态", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await user.click(screen.getByRole("combobox", { name: "客户状态" }));
    expect(await screen.findByText("已合并", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("后端不可达时显示错误条而不是空白页", async () => {
    vi.mocked(catalog.customersApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<CustomersPage />);
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("业务错误码给出可执行的处置提示", async () => {
    vi.mocked(catalog.customersApi.list).mockRejectedValueOnce({
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

  it("新建客户与合作方分别加载各自的表单字段配置", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(catalog.orderFormFieldsApi.list).mockImplementation(async (scope) => (
      scope === "CUSTOMER"
        ? [{ id: 101, order_type_code: "CUSTOMER", field_key: "display_name", label: "客户称呼", field_type: "TEXT", options: null, required: true, is_active: true, sort_order: 10, locked: false, is_custom: false, note: null }]
        : [{ id: 102, order_type_code: "COUNTERPARTY", field_key: "type", label: "合作类型", field_type: "SELECT", options: null, required: true, is_active: true, sort_order: 10, locked: false, is_custom: false, note: null }]
    ) as never);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");

    await user.click(screen.getByRole("button", { name: /新建客户$/ }));
    await waitFor(() => expect(catalog.orderFormFieldsApi.list).toHaveBeenCalledWith("CUSTOMER", true));
    expect(screen.getByLabelText("客户称呼")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    await user.click((await screen.findByRole("button", { name: /新建合作方$/ })));
    await waitFor(() => expect(catalog.orderFormFieldsApi.list).toHaveBeenCalledWith("COUNTERPARTY", true));
    expect(screen.getByLabelText("合作类型")).toBeInTheDocument();
  });

  it("统计卡片与筛选条之间保留清晰的分组间距", async () => {
    renderLight(<CustomersPage />);
    await screen.findByText("CUS-0001");

    const stats = document.querySelector(".ui-stat-row");
    const filters = document.querySelector(".customer-list-filters");

    expect(stats).toBeInTheDocument();
    expect(filters).toHaveClass("customer-list-filters--separated");
    expect(stats?.nextElementSibling).toBe(filters);
  });

  it("统计区只展示总数、本月新增和今日新增", async () => {
    vi.setSystemTime(new Date("2026-10-18T12:00:00"));
    renderLight(<CustomersPage />);
    await screen.findByText("CUS-0001");

    expect(screen.getByText("客户总数")).toBeInTheDocument();
    expect(screen.getByText("本月新增客户数")).toBeInTheDocument();
    expect(screen.getByText("今日新增客户数")).toBeInTheDocument();

    const stats = document.querySelector(".ui-stat-row");
    expect(stats?.children).toHaveLength(3);
    expect(within(stats as HTMLElement).getByText("客户总数")).toBeInTheDocument();
    expect(within(stats as HTMLElement).getByText("本月新增客户数")).toBeInTheDocument();
    expect(within(stats as HTMLElement).getByText("今日新增客户数")).toBeInTheDocument();
    expect(within(stats as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(within(stats as HTMLElement).getAllByText("1")).toHaveLength(2);
  });

  it("合作方复用客户的详情、编辑和拉黑操作", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue(counterparties);
    vi.mocked(catalog.counterpartiesApi.get).mockResolvedValue(counterparties[0]);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");

    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    const panel = await screen.findByRole("tabpanel");
    expect(within(panel).getByText("CP-0001")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /详情/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /编辑/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /拉黑/ })).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: /详情/ }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("合作方档案 · CP-0001")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /编辑/ })).toBeInTheDocument();
  });

  it("已合并（终态）客户行只保留详情，不暴露合并/拉黑/解除拉黑（L1595）", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(catalog.customersApi.list).mockResolvedValue([
      {
        id: 3,
        customer_no: "CUS-0010",
        display_name: "王五",
        phone: "137****7777",
        wechat: "",
        qq: "",
        status: "MERGED",
        created_at: "2026-08-01T09:00:00",
        extra_values: {},
      },
    ]);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0010");

    const row = screen.getByText("CUS-0010").closest("tr") as HTMLElement;
    expect(within(row).getByText("详情")).toBeInTheDocument();
    // 终态只保留详情，合并/拉黑/解除拉黑均不应出现
    expect(within(row).queryByText("合并")).not.toBeInTheDocument();
    expect(within(row).queryByText("拉黑")).not.toBeInTheDocument();
    expect(within(row).queryByText("解除拉黑")).not.toBeInTheDocument();
  });
});

describe("CustomersPage：联系方式脱敏与按需查看", () => {
  const masked = {
    ...customers[0],
    phone: "138****8888",
    wechat: "zh***",
    qq: "1***1",
    contact_masked: true,
  };
  const revealedCustomer = {
    ...masked,
    phone: "13800008888",
    wechat: "zhangsan",
    qq: "10001",
    contact_masked: false,
  };

  it("脱敏行先显示打码值，点「查看」才向后端要明文并就地替换", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(catalog.customersApi.list).mockResolvedValue([masked]);
    vi.mocked(catalog.customersApi.get).mockResolvedValue(revealedCustomer);
    renderLight(<CustomersPage />, { user: "admin" });

    expect(await screen.findByText("138****8888")).toBeInTheDocument();
    // 未点查看前，明文不应出现在页面上
    expect(screen.queryByText("13800008888")).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /查看/ })[0]);

    await waitFor(() => expect(catalog.customersApi.get).toHaveBeenCalledWith(1, true));
    expect(await screen.findByText("13800008888")).toBeInTheDocument();
    // 三个联系字段一起放开
    expect(screen.getByText("zhangsan")).toBeInTheDocument();
    expect(screen.getByText("10001")).toBeInTheDocument();
  });

  it("脱敏且未查看时，编辑保存不提交联系方式，避免打码值覆盖真实号码", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(catalog.customersApi.list).mockResolvedValue([masked]);
    vi.mocked(catalog.customersApi.patch).mockResolvedValue(masked);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("138****8888");

    await user.click(screen.getAllByRole("button", { name: /详情/ })[0]);
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: /编辑/ }));

    const nameInput = await screen.findByLabelText("名字");
    await user.clear(nameInput);
    await user.type(nameInput, "张三改");
    await user.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => expect(catalog.customersApi.patch).toHaveBeenCalled());
    const payload = vi.mocked(catalog.customersApi.patch).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.display_name).toBe("张三改");
    expect(payload).not.toHaveProperty("phone");
    expect(payload).not.toHaveProperty("wechat");
    expect(payload).not.toHaveProperty("qq");
  });
});
