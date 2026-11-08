import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { CustomersPage } from "@/customers/CustomersPage";

import * as catalog from "@/shared/api/catalog";
import { seedOptionSets } from "@fixtures/formFieldsSeed";
import { resolveMockOnce } from "@fixtures/mock-api";
vi.mock("@/shared/api/catalog")
vi.mock("@/customers/CustomerLeadPanel", () => ({ CustomerLeadPanel: () => <div /> }));

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

  it("FE-242：客户接口失败时统计显示不可用并保护依赖入口", async () => {
    vi.mocked(catalog.customersApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "customers down" });
    renderLight(<CustomersPage />, { user: "admin" });

    expect(await screen.findByText("客户数据不可用，请点击重新加载")).toBeInTheDocument();
    const stats = document.querySelector(".ui-stat-row") as HTMLElement;
    expect(within(stats).getAllByText("不可用")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "导出客户CSV" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /新建客户/ })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "客户状态" })).toBeDisabled();
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

  it("已合并（终态）客户行只保留详情，不暴露合并/拉黑/解除拉黑", async () => {
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

describe("CustomersPage：行内动作", () => {
  let ui: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    ui = userEvent.setup({ pointerEventsCheck: 0 });
  });


  const fieldDefs = [
    { id: 1, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "game_category", label: "常玩品类", field_type: "MULTI_SELECT", options: [{ value: "王者荣耀", label: "王者荣耀" }, { value: "和平精英", label: "和平精英" }], required: false, sort_order: 10, is_active: true },
    { id: 2, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "credit_level", label: "信用评级", field_type: "SELECT", options: [{ value: "优质", label: "优质" }, { value: "一般", label: "一般" }, { value: "观察", label: "观察" }, { value: "黑名单", label: "黑名单" }], required: false, sort_order: 20, is_active: true },
    { id: 3, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "referrer", label: "转介绍人", field_type: "TEXT", options: null, required: false, sort_order: 30, is_active: true },
    { id: 4, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "legacy_note", label: "历史备注", field_type: "TEXT", options: null, required: false, sort_order: 40, is_active: false },
  ] as unknown as import("@/shared/api/catalog").OrderFormField[];

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
    business: [{ order_id: 10, order_no: "HS-2026-0010", order_type: "HS", status: "ACTIVE", trade_date: "2026-10-18", roles: ["BUYER"] }],
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

  describe("CustomersPage：客户与合作方操作流", () => {
    it("拉黑 ACTIVE 客户：确认后调用 setStatus(DISABLED) 并提示", async () => {
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getAllByRole("button", { name: /拉\s*黑/ })[0]);
      const confirm = await screen.findByRole("button", { name: /确\s*定|确\s*认/ });
      await ui.click(confirm);
      await waitFor(() => expect(vi.mocked(catalog.customersApi.setStatus)).toHaveBeenCalledWith(1, "DISABLED"));
    });

    it("合并客户：选择目标与原因后提交调用 merge", async () => {
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getAllByRole("button", { name: /合\s*并/ })[0]);
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
      await ui.click((await screen.findAllByRole("button", { name: /详\s*情/ }))[0]);
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

    it("FE-259：合作方拉黑使用后端 active 语义并调用状态接口", async () => {
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getByRole("tab", { name: /合作方/ }));
      const panel = await screen.findByRole("tabpanel");
      await ui.click(within(panel).getByRole("button", { name: /拉\s*黑/ }));
      const confirm = await screen.findByRole("button", { name: /确\s*定|确\s*认/ });
      await ui.click(confirm);
      await waitFor(() => expect(vi.mocked(catalog.counterpartiesApi.setStatus)).toHaveBeenCalledWith(11, false));
    });
  });
});

describe("CustomersPage：扩展字段（BAS-04）", () => {
  let ui: ReturnType<typeof userEvent.setup>;

  /** 扩展字段定义：MULTI_SELECT / SELECT / TEXT / 停用字段各一 */
  const liveFieldDefs = [
    {
      id: 1, order_type_code: "CUSTOMER", is_custom: true, locked: false,
      field_key: "game_category", label: "常玩品类", field_type: "MULTI_SELECT",
      options: [{ value: "王者荣耀", label: "王者荣耀" }, { value: "和平精英", label: "和平精英" }],
      required: false, sort_order: 10, is_active: true,
    },
    {
      id: 2, order_type_code: "CUSTOMER", is_custom: true, locked: false,
      field_key: "credit_level", label: "信用评级", field_type: "SELECT",
      options: [{ value: "优质", label: "优质" }, { value: "一般", label: "一般" }, { value: "观察", label: "观察" }, { value: "黑名单", label: "黑名单" }],
      required: false, sort_order: 20, is_active: true,
    },
    {
      id: 3, order_type_code: "CUSTOMER", is_custom: true, locked: false,
      field_key: "referrer", label: "转介绍人", field_type: "TEXT",
      options: null, required: false, sort_order: 30, is_active: true,
    },
    {
      id: 4, order_type_code: "CUSTOMER", is_custom: true, locked: false,
      field_key: "legacy_note", label: "历史备注", field_type: "TEXT",
      options: null, required: false, sort_order: 40, is_active: false,
    },
  ] as unknown as import("@/shared/api/catalog").OrderFormField[];

  beforeEach(() => {
    ui = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue(liveFieldDefs);
    vi.mocked(catalog.leadsApi.list).mockResolvedValue([]);
  });

  it("列表按字段定义渲染扩展字段摘要列", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    expect(await screen.findByText(/信用评级：优质/)).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(catalog.orderFormFieldsApi.list)).toHaveBeenCalledWith("CUSTOMER", true));
  });

  it("新建弹窗动态渲染扩展字段控件，提交时回传 extra_values", async () => {
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

  it("详情抽屉展示扩展字段值，停用字段标注保留历史值", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getAllByRole("button", { name: /详\s*情/ })[0]);
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("信用评级")).toBeInTheDocument();
    expect(within(drawer).getByText("优质")).toBeInTheDocument();
    expect(within(drawer).getByText("历史备注（已停用）")).toBeInTheDocument();
    expect(within(drawer).getByText("早期客户")).toBeInTheDocument();
  });

  it("扩展字段定义接口失败不阻断客户页渲染", async () => {
    vi.mocked(catalog.orderFormFieldsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<CustomersPage />, { user: "admin" });
    expect(await screen.findByText("CUS-0001")).toBeInTheDocument();
  });
});
