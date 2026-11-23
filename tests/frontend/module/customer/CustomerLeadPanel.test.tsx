import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { CustomerLeadPanel } from "@/customer-center/CustomerLeadPanel";
import { CounterpartyPanel } from "@/customer-center/CounterpartyPanel";
import { useCounterpartyList } from "@/customer-center/useCounterpartyList";
import { useCustomerLeadList } from "@/customer-center/useCustomerLeadList";
import { useCustomerController } from "@/customer-center/useCustomerController";
import { counterpartiesApi, customersApi, leadsApi } from "@/shared/api/customers.api";
import { employeesApi } from "@/shared/api/org.api";
import { orderFormFieldsApi } from "@/shared/api/orders.api";
import type { Customer, Lead } from "@/shared/api/types/customers";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { pageResponse } from "@fixtures/api-responses";

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

const customers: Customer[] = [
  { id: 1, customer_no: "C-1", display_name: "张三", status: "ACTIVE" },
];

const leads: Lead[] = [
  { id: 1, lead_no: "LD-1", customer_id: 1, customer_display_name: "张三", request_type: "FIND_ACCOUNT", budget: "100.00", target: "找一个号", status: "OPEN" },
  { id: 2, lead_no: "LD-2", customer_id: 1, customer_display_name: "张三", request_type: "SELL_ACCOUNT", budget: null, target: "卖个号", status: "CLOSED" },
];

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  seedOrderFormFields();
  vi.mocked(leadsApi.page).mockResolvedValue(pageResponse(leads));
  vi.mocked(leadsApi.summary).mockResolvedValue({ total_count: 2, open_count: 1 });
  vi.mocked(customersApi.options).mockResolvedValue(customers);
  vi.mocked(leadsApi.create).mockResolvedValue(leads[0]);
  vi.mocked(leadsApi.close).mockResolvedValue(leads[0]);
  vi.mocked(leadsApi.convert).mockResolvedValue(leads[0]);
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "管理员", is_active: true },
  ]);
  vi.spyOn(message, "success").mockReturnValue(undefined as never);
  vi.spyOn(message, "error").mockReturnValue(undefined as never);
});

describe("客户中心工具栏搜索", () => {
  it("客户、合作方与需求保存完成后刷新当前筛选条件", async () => {
    vi.mocked(customersApi.page).mockResolvedValue(pageResponse([]));
    vi.mocked(customersApi.summary).mockResolvedValue({ month_count: 0, today_count: 0 });
    vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse([]));
    const customer = renderHook(() => useCustomerController({ active: true }));
    const counterparty = renderHook(() => useCounterpartyList(true));
    const lead = renderHook(() => useCustomerLeadList(true));
    const oldRefresh = [customer.result.current.load, counterparty.result.current.load, lead.result.current.load];
    act(() => {
      customer.result.current.setKeyword("新客户筛选");
      counterparty.result.current.setKeyword("新合作方筛选");
      lead.result.current.setKeyword("新需求筛选");
    });
    await waitFor(() => expect(leadsApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "新需求筛选" })));
    await act(async () => { await Promise.all(oldRefresh.map((refresh) => refresh())); });
    expect(customersApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "新客户筛选" }));
    expect(counterpartiesApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "新合作方筛选" }));
    expect(leadsApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "新需求筛选" }));
    expect(leadsApi.summary).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "新需求筛选" }));
  });

  it("合作方按关键词查询，并将日历放在搜索之后", async () => {
    vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse([]));
    renderLight(<CounterpartyPanel createdPicker={<span data-testid="toolbar-date">日期</span>} />, { user: "admin" });
    const search = await screen.findByRole("searchbox", { name: "搜索合作方" });
    expect(screen.getByRole("button", { name: "搜索合作方" })).toBeInTheDocument();
    expect(search.compareDocumentPosition(screen.getByTestId("toolbar-date")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await ui.type(search, "同行甲{enter}");
    await waitFor(() => expect(counterpartiesApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "同行甲", offset: 0 })));
    await ui.clear(search);
    await waitFor(() => expect(counterpartiesApi.page).toHaveBeenLastCalledWith(expect.not.objectContaining({ keyword: expect.anything() })));
  });

  it("需求池按关键词查询列表和统计，并将日历放在搜索之后", async () => {
    renderLight(<CustomerLeadPanel createdPicker={<span data-testid="toolbar-date">日期</span>} />, { user: "admin" });
    const search = await screen.findByRole("searchbox", { name: "搜索客户需求" });
    expect(screen.getByRole("button", { name: "搜索客户需求" })).toBeInTheDocument();
    expect(search.compareDocumentPosition(screen.getByTestId("toolbar-date")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await ui.type(search, "张三{enter}");
    await waitFor(() => expect(leadsApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "张三", offset: 0 })));
    await waitFor(() => expect(leadsApi.summary).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "张三" })));
  });
});

describe("CustomerLeadPanel：客户需求池", () => {
  it("新增需求可通过后端搜索选择客户", async () => {
    vi.mocked(customersApi.options).mockImplementation(async (keyword) => keyword === "后续客户"
      ? [{ id: 2, customer_no: "C-LATER", display_name: "后续客户" }]
      : []);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: "新增需求" }));
    const modal = (await screen.findByText("新增客户需求")).closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("客户"), "后续客户");
    await ui.click(await screen.findByText("C-LATER · 后续客户", { selector: ".ant-select-item-option-content" }));
    expect(within(modal).getByText("C-LATER · 后续客户", { selector: ".ant-select-selection-item" })).toBeInTheDocument();
  });

  it("新增需求核心字段在旧配置停用时仍展示并必填", async () => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([
      { id: 1, order_type_code: "LEAD", field_key: "customer_id", label: "关联客户", field_type: "SELECT", required: false, is_active: false },
      { id: 2, order_type_code: "LEAD", field_key: "request_type", label: "需求类别", field_type: "SELECT", required: false, is_active: false },
      { id: 3, order_type_code: "LEAD", field_key: "target", label: "具体目标", field_type: "TEXT", required: false, is_active: false },
    ] as never);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: "新增需求" }));
    const modal = (await screen.findByText("新增客户需求")).closest(".ant-modal-content") as HTMLElement;
    expect(await within(modal).findByLabelText("关联客户")).toBeInTheDocument();
    expect(within(modal).getByLabelText("需求类别")).toBeInTheDocument();
    expect(within(modal).getByLabelText("具体目标")).toBeInTheDocument();
    await ui.click(within(modal).getByRole("button", { name: "创建需求" }));
    await waitFor(() => expect(within(modal).getAllByText(/必填|请选择|请输入/).length).toBeGreaterThan(0));
    expect(leadsApi.create).not.toHaveBeenCalled();
  });
  it("新增需求时立即打开表单并等待客户名单", async () => {
    let finish!: (value: Customer[]) => void;
    const pending = new Promise<Customer[]>((resolve) => { finish = resolve; });
    vi.mocked(customersApi.options).mockReturnValueOnce(pending);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: "新增需求" }));
    const modal = (await screen.findByText("新增客户需求")).closest(".ant-modal-content") as HTMLElement;
    expect(within(modal).getByRole("button", { name: "创建需求" })).toBeDisabled();
    await waitFor(() => expect(orderFormFieldsApi.list).toHaveBeenCalledWith("LEAD", true));
    await act(async () => finish(customers));
    await waitFor(() => expect(within(modal).getByRole("button", { name: "创建需求" })).toBeEnabled());
  });

  it("关闭后重新打开需求表单时忽略旧名单请求", async () => {
    let fail!: (error: Error) => void;
    const pending = new Promise<Customer[]>((_resolve, reject) => { fail = reject; });
    vi.mocked(customersApi.options).mockReturnValueOnce(pending);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: "新增需求" }));
    const modal = (await screen.findByText("新增客户需求")).closest(".ant-modal-content") as HTMLElement;
    await ui.click(within(modal).getByRole("button", { name: "Close" }));
    await ui.click(screen.getByRole("button", { name: "新增需求" }));
    const reopened = (await screen.findByText("新增客户需求")).closest(".ant-modal-content") as HTMLElement;
    await waitFor(() => expect(within(reopened).getByRole("button", { name: "创建需求" })).toBeEnabled());
    await act(async () => { fail(new Error("旧名单失败")); await pending.catch(() => undefined); });
    expect(within(reopened).getByRole("button", { name: "创建需求" })).toBeEnabled();
    expect(screen.queryByText(/旧名单失败/)).not.toBeInTheDocument();
  });

  it("统计未返回时先显示需求列表及分页总数", async () => {
    let finish!: (value: { total_count: number; open_count: number }) => void;
    const pending = new Promise<{ total_count: number; open_count: number }>((resolve) => { finish = resolve; });
    vi.mocked(leadsApi.summary).mockReturnValueOnce(pending);
    vi.mocked(leadsApi.page).mockResolvedValueOnce(pageResponse(leads, { total: 11, limit: 10 }));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText("LD-1")).toBeVisible();
    expect(screen.getByTitle("2")).toBeVisible();
    expect(screen.getByText("需求总数").closest(".ui-stat")).toHaveTextContent("-");
    await ui.click(screen.getByTitle("2"));
    await waitFor(() => expect(leadsApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 10 })));
    expect(leadsApi.summary).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ total_count: 11, open_count: 3 }); await pending; });
    expect(screen.getByText("待跟进").closest(".ui-stat")).toHaveTextContent("3");
  });

  it("当前末页的数据被移除后回到仍有数据的页", async () => {
    let closed = false;
    const last = { ...leads[0], id: 3, lead_no: "LD-LAST" };
    vi.mocked(leadsApi.page).mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      return pageResponse(offset ? (closed ? [] : [last]) : [leads[0]], { total: closed ? 10 : 11, offset, limit: 10 });
    });
    vi.mocked(leadsApi.close).mockImplementation(async () => { closed = true; return last; });
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await screen.findByText("LD-1");
    await ui.click(screen.getByTitle("2"));
    const row = (await screen.findByText("LD-LAST")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: "关闭" }));
    const modal = screen.getByText("关闭客户需求").closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("关闭原因"), "客户取消");
    await ui.click(within(modal).getByRole("button", { name: "确认关闭" }));
    await waitFor(() => expect(leadsApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })));
    expect(await screen.findByText("LD-1")).toBeVisible();
  });

  it("统计失败时保留需求列表并允许重试", async () => {
    vi.mocked(leadsApi.summary).mockRejectedValueOnce(new Error("需求统计读取失败"))
      .mockResolvedValueOnce({ total_count: 2, open_count: 1 });
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText("LD-1")).toBeVisible();
    expect(await screen.findByText(/需求统计读取失败/)).toBeVisible();
    expect(screen.getByText("待跟进").closest(".ui-stat")).toHaveTextContent("不可用");
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.getByText("待跟进").closest(".ui-stat")).toHaveTextContent("1"));
  });

  it("需求建档请求进行时快速重复提交只创建一次", async () => {
    let finish!: (value: Lead) => void;
    const pending = new Promise<Lead>((resolve) => { finish = resolve; });
    vi.mocked(leadsApi.create).mockReturnValueOnce(pending);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: "新增需求" }));
    const modal = (await screen.findByText("新增客户需求")).closest(".ant-modal-content") as HTMLElement;
    await ui.click(within(modal).getByLabelText("客户").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("C-1 · 张三", { selector: ".ant-select-item-option-content" }));
    await ui.click(within(modal).getByLabelText("需求类型").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("找号", { selector: ".ant-select-item-option-content" }));
    await ui.type(within(modal).getByLabelText("需求目标"), "需求测试");
    const form = modal.querySelector("form") as HTMLFormElement;
    await act(async () => { fireEvent.submit(form); });
    await waitFor(() => expect(leadsApi.create).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.submit(form); });
    expect(leadsApi.create).toHaveBeenCalledTimes(1);
    await act(async () => { finish(leads[0]); await pending; });
  });
  it("客户搜索失败时提示错误", async () => {
    vi.mocked(customersApi.options).mockRejectedValueOnce(new Error("客户名单读取失败"));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: "新增需求" }));
    expect(await screen.findByText(/客户名单读取失败/)).toBeVisible();
  });
  it("搜索客户失败时保留需求草稿与列表，并可在弹窗内重试", async () => {
    vi.mocked(customersApi.options).mockResolvedValueOnce(customers)
      .mockRejectedValueOnce(new Error("客户搜索失败"))
      .mockResolvedValueOnce(customers);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText("LD-1")).toBeVisible();
    await ui.click(screen.getByRole("button", { name: "新增需求" }));
    const modal = (await screen.findByText("新增客户需求")).closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("需求目标"), "保留的草稿");
    await ui.type(within(modal).getByLabelText("客户"), "张三");
    expect(await within(modal).findByText(/客户搜索失败/)).toBeVisible();
    expect(within(modal).getByLabelText("需求目标")).toHaveValue("保留的草稿");
    expect(screen.getByText("LD-1")).toBeInTheDocument();
    await ui.click(within(modal).getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(customersApi.options).toHaveBeenLastCalledWith("张三"));
    await waitFor(() => expect(within(modal).queryByText(/客户搜索失败/)).not.toBeInTheDocument());
    expect(within(modal).getByLabelText("需求目标")).toHaveValue("保留的草稿");
  });
  it("需求日期筛选失败隐藏旧数据，重试后恢复", async () => {
    const view = renderLight(<CustomerLeadPanel createdPeriod={{ from: "2026-10-01", to: "2026-10-31" }} />, { user: "admin" });
    await screen.findByText("LD-1");
    vi.mocked(leadsApi.page).mockRejectedValueOnce(new Error("需求筛选失败"));
    view.rerender(<CustomerLeadPanel createdPeriod={{ from: "2026-11-01", to: "2026-11-30" }} />);
    expect(await screen.findByText(/需求筛选失败/)).toBeVisible();
    expect(screen.queryByText("LD-1")).toBeNull();
    expect(screen.getByText("客户需求数据不可用，请点击重新加载")).toBeVisible();
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("LD-1")).toBeInTheDocument();
  });
  it("需求列表翻页时保留统计且不重复请求汇总", async () => {
    vi.mocked(leadsApi.summary).mockResolvedValueOnce({ total_count: 11, open_count: 11 }).mockResolvedValueOnce({ total_count: 11, open_count: 11 });
    vi.mocked(leadsApi.page).mockImplementation(async (params) => pageResponse(
      [{ ...leads[0], lead_no: params?.offset === 10 ? "LD-PAGE2" : "LD-1" }],
      { total: 11, limit: params?.limit ?? 10, offset: params?.offset ?? 0 },
    ));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await screen.findByText("LD-1");
    await waitFor(() => expect(screen.getByText("待跟进").closest(".ui-stat")).toHaveTextContent("11"));
    let finish!: (value: ReturnType<typeof pageResponse<Lead>>) => void;
    const pending = new Promise<ReturnType<typeof pageResponse<Lead>>>((resolve) => { finish = resolve; });
    vi.mocked(leadsApi.page).mockReturnValueOnce(pending);
    await ui.click(screen.getByTitle("2"));
    expect(screen.getByText("待跟进").closest(".ui-stat")).toHaveTextContent("11");
    expect(leadsApi.summary).toHaveBeenCalledTimes(1);
    await act(async () => { finish(pageResponse([{ ...leads[0], lead_no: "LD-PAGE2" }], { total: 11, limit: 10, offset: 10 })); await pending; });
    expect(await screen.findByText("LD-PAGE2")).toBeInTheDocument();
    expect(leadsApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 10, offset: 10 }));
  });
  it("需求池在后续页切换周期时只请求新周期第一页", async () => {
    vi.mocked(leadsApi.page).mockImplementation(async (params) => pageResponse(
      [{ ...leads[0], lead_no: params?.offset === 10 ? "LD-PAGE2" : "LD-1" }],
      { total: 11, limit: params?.limit ?? 10, offset: params?.offset ?? 0 },
    ));
    const view = renderLight(<CustomerLeadPanel createdPeriod={{ from: "2026-10-01", to: "2026-10-31" }} />, { user: "admin" });
    await screen.findByText("LD-1");
    await ui.click(screen.getByTitle("2"));
    await screen.findByText("LD-PAGE2");
    vi.mocked(leadsApi.page).mockClear();
    vi.mocked(leadsApi.summary).mockClear();
    view.rerender(<CustomerLeadPanel createdPeriod={{ from: "2026-11-01", to: "2026-11-30" }} />);
    await screen.findByText("LD-1");
    expect(leadsApi.page).toHaveBeenCalledTimes(1);
    expect(leadsApi.page).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, created_from: "2026-11-01" }));
    expect(leadsApi.summary).toHaveBeenCalledTimes(1);
  });
  it("加载成功后渲染需求列表、客户名与统计", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText("LD-1")).toBeInTheDocument();
    expect(screen.getAllByText("张三").length).toBeGreaterThan(0);
    expect(screen.getByText("找号")).toBeInTheDocument();
    expect(screen.getByText("需求总数")).toBeInTheDocument();
    expect(screen.getByText("待跟进")).toBeInTheDocument();
    const shell = document.querySelector(".customer-lead-shell");
    expect(shell).toBeTruthy();
    expect(within(shell as HTMLElement).getByText("客户需求池")).toBeInTheDocument();
  });

  it("无需求时显示空态文案", async () => {
    vi.mocked(leadsApi.page).mockResolvedValue(pageResponse([]));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText("暂无客户需求")).toBeInTheDocument();
  });

  it("加载失败展示错误横幅", async () => {
    vi.mocked(leadsApi.page).mockRejectedValue(new Error("lead down"));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText(/lead down/)).toBeInTheDocument();
  });

  it("客户列表为空时允许打开新增但要求选择客户", async () => {
    vi.mocked(customersApi.options).mockResolvedValue([]);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText("需求总数")).toBeInTheDocument();
    const createButton = screen.getByRole("button", { name: /新增需求/ });
    expect(createButton).toBeEnabled();
    await ui.click(createButton);
    const modal = await screen.findByText("新增客户需求");
    await ui.click(within(modal.closest(".ant-modal-content") as HTMLElement).getByRole("button", { name: /创建需求/ }));
    expect(leadsApi.create).not.toHaveBeenCalled();
  });

  it("首屏不加载客户全集，点击新增时才加载客户选项", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await screen.findByText("LD-1");
    expect(customersApi.options).not.toHaveBeenCalled();

    await ui.click(screen.getByRole("button", { name: /新增需求/ }));
    await screen.findByText("新增客户需求");
    expect(customersApi.options).toHaveBeenCalledWith("");
  });

  it("需求列表直接展示后端返回的客户名称", async () => {
    vi.mocked(customersApi.options).mockResolvedValue([]);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    expect(within(row).getByText("张三")).toBeInTheDocument();
  });

  it("需求列表由后台分页并传入当前页参数", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await screen.findByText("LD-1");
    expect(leadsApi.page).toHaveBeenCalledWith({ limit: 10, offset: 0 });
  });

  it("重新激活客户需求池时刷新列表", async () => {
    const view = renderLight(<CustomerLeadPanel active={false} />, { user: "admin" });
    expect(leadsApi.page).not.toHaveBeenCalled();

    view.rerender(<CustomerLeadPanel active />);
    expect(await screen.findByText("LD-1")).toBeInTheDocument();
    await waitFor(() => expect(leadsApi.page).toHaveBeenCalledWith({ limit: 10, offset: 0 }));
  });

  it("新增需求填表并提交调用 leadsApi.create", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: /新增需求/ }));
    const modal = screen.getByText("新增客户需求").closest(".ant-modal-content") as HTMLElement;
    expect(modal.closest(".ant-modal")).toHaveStyle({ width: "520px" });
    await ui.click(screen.getByLabelText("客户").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("C-1 · 张三", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByLabelText("需求类型").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("找号", { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("预算"), "100");
    await ui.type(screen.getByLabelText("需求目标"), "找一个号");
    await ui.click(within(modal).getByRole("button", { name: /创建需求/ }));
    await waitFor(() => expect(leadsApi.create).toHaveBeenCalled());
    expect(leadsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: 1, request_type: "FIND_ACCOUNT", budget: "100", target: "找一个号" }),
    );
    await waitFor(() => expect(leadsApi.summary).toHaveBeenCalledTimes(2));
  });

  it("新增需求接口失败时展示错误", async () => {
    vi.mocked(leadsApi.create).mockRejectedValueOnce(new Error("create boom"));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: /新增需求/ }));
    const modal = screen.getByText("新增客户需求").closest(".ant-modal-content") as HTMLElement;
    await ui.click(screen.getByLabelText("客户").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("C-1 · 张三", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByLabelText("需求类型").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("找号", { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("预算"), "100");
    await ui.type(screen.getByLabelText("需求目标"), "找一个号");
    await ui.click(within(modal).getByRole("button", { name: /创建需求/ }));
    expect(await within(modal).findByText(/create boom/)).toBeVisible();
    expect(within(modal).getByLabelText("需求目标")).toHaveValue("找一个号");
    await ui.click(within(modal).getByRole("button", { name: /创建需求/ }));
    await waitFor(() => expect(leadsApi.create).toHaveBeenCalledTimes(2));
  });

  it.each([
    { action: "关闭", title: "关闭客户需求", field: "关闭原因", value: "取消", submit: "确认关闭", method: "close" as const },
    { action: "转单", title: "需求转单", field: "订单编号", value: "HS0001", submit: "确认转单", method: "convert" as const },
  ])("$action 失败在弹窗显示原因并保留输入", async ({ action, title, field, value, submit, method }) => {
    vi.mocked(leadsApi[method]).mockRejectedValueOnce(new Error("操作未完成"));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: action }));
    const modal = screen.getByText(title).closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText(field), value);
    await ui.click(within(modal).getByRole("button", { name: submit }));
    expect(await within(modal).findByText(/操作未完成/)).toBeVisible();
    expect(within(modal).getByLabelText(field)).toHaveValue(value);
    await ui.click(within(modal).getByRole("button", { name: "Close" }));
    await ui.click(within(row).getByRole("button", { name: action }));
    const reopened = screen.getByText(title).closest(".ant-modal-content") as HTMLElement;
    expect(within(reopened).queryByText(/操作未完成/)).toBeNull();
    expect(within(reopened).getByLabelText(field)).toHaveValue("");
  });

  it("点击行内关闭打开弹窗并提交调用 leadsApi.close", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /关闭/ }));
    const modal = screen.getByText("关闭客户需求").closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("关闭原因"), "已成交");
    await ui.click(within(modal).getByRole("button", { name: /确认关闭/ }));
    await waitFor(() => expect(leadsApi.close).toHaveBeenCalledWith(1, "已成交", undefined, [1]));
  });

  it("取消后重开关闭需求仍默认当前操作人", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: "关闭" }));
    let modal = screen.getByText("关闭客户需求").closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("关闭原因"), "草稿");
    await ui.click(within(modal).getByRole("button", { name: "取消" }));
    await ui.click(within(row).getByRole("button", { name: "关闭" }));
    modal = screen.getByText("关闭客户需求").closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("关闭原因"), "重新填写");
    await ui.click(within(modal).getByRole("button", { name: "确认关闭" }));
    await waitFor(() => expect(leadsApi.close).toHaveBeenCalledWith(1, "重新填写", undefined, [1]));
  });

  it("点击行内转单打开弹窗并提交调用 leadsApi.convert", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /转单/ }));
    const modal = screen.getByText("需求转单").closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("订单编号"), "HS0001");
    await ui.click(within(modal).getByRole("button", { name: /确认转单/ }));
    await waitFor(() => expect(leadsApi.convert).toHaveBeenCalledWith(1, "HS0001", undefined, [1]));
  });

  it("转单时订单编号必填", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /转单/ }));
    const modal = screen.getByText("需求转单").closest(".ant-modal-content") as HTMLElement;
    await ui.click(within(modal).getByRole("button", { name: /确认转单/ }));

    expect(await screen.findByText("请输入订单编号")).toBeInTheDocument();
    expect(vi.mocked(leadsApi.convert)).not.toHaveBeenCalled();
  });

  it.each([
    { action: "关闭", title: "关闭客户需求", field: "关闭原因", value: "已结束", submit: "确认关闭", method: "close" as const },
    { action: "转单", title: "需求转单", field: "订单编号", value: "HS0001", submit: "确认转单", method: "convert" as const },
  ])("$action 提交期间不能切换目标", async ({ action, title, field, value, submit, method }) => {
    let finish!: (value: Lead) => void;
    vi.mocked(leadsApi[method]).mockReturnValueOnce(new Promise<Lead>((resolve) => { finish = resolve; }));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: action }));
    const modal = screen.getByText(title).closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText(field), value);
    await ui.click(within(modal).getByRole("button", { name: submit }));
    await waitFor(() => expect(leadsApi[method]).toHaveBeenCalledTimes(1));
    expect(within(modal).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByText(title)).toBeVisible();
    await act(async () => finish(leads[0]));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith(method === "close" ? "需求已关闭" : "需求已转单"));
  });

  it.each([
    { scope: "LEADCLOSE", key: "reason", label: "结案原因", action: "关闭", title: "关闭客户需求", submit: "确认关闭", method: "close" as const },
    { scope: "LEADCONVERT", key: "order_id", label: "关联订单号", action: "转单", title: "需求转单", submit: "确认转单", method: "convert" as const },
  ])("$scope 的核心字段即使旧配置停用且选填仍须填写", async ({ scope, key, label, action, title, submit, method }) => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([
      { id: 1, order_type_code: scope, field_key: key, label, field_type: "TEXT", options: null, required: false, is_active: false, sort_order: 10, locked: false, is_custom: false, note: null },
    ] as never);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: action }));
    const modal = screen.getByText(title).closest(".ant-modal-content") as HTMLElement;
    const input = await within(modal).findByLabelText(label);
    await ui.type(input, "   ");
    await ui.click(within(modal).getByRole("button", { name: submit }));
    await waitFor(() => expect(within(modal).getByText(/请输入/)).toBeVisible());
    expect(leadsApi[method]).not.toHaveBeenCalled();
  });

  it("转单弹窗「订单编号」标签取配置值", async () => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([
      { id: 2, order_type_code: "LEADCONVERT", field_key: "order_id", label: "关联订单号", field_type: "TEXT", options: null, required: true, is_active: true, sort_order: 10, locked: false, is_custom: false, note: null },
    ] as never);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /转单/ }));
    const modal = screen.getByText("需求转单").closest(".ant-modal-content") as HTMLElement;
    await waitFor(() => expect(within(modal).getByLabelText("关联订单号")).toBeInTheDocument());
  });

  it("已关闭需求不渲染行内操作按钮", async () => {
    vi.mocked(leadsApi.page).mockResolvedValue(pageResponse([
      { id: 2, lead_no: "LD-2", customer_id: 1, customer_display_name: "张三", request_type: "SELL_ACCOUNT", budget: null, target: "卖个号", status: "CLOSED" },
    ]));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await screen.findByText("LD-2");
    expect(screen.queryByRole("button", { name: /转单/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /关闭/ })).toBeNull();
  });
});
