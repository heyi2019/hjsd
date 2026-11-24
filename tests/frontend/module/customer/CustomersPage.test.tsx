import { CustomerPanel } from "@/customer-center/CustomerPanel";
import { CustomerEditModal } from "@/customer-center/CustomerEditModal";
import { CustomerCreateModal } from "@/customer-center/CustomerCreateModal";
import { appMessage } from "@/shared/ui/appFeedback";
import { Form } from "antd";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { CustomersPage } from "@/customer-center/CustomersPage";

import { counterpartiesApi, customersApi } from "@/shared/api/customers.api";
import { employeesApi } from "@/shared/api/org.api";
import { orderFormFieldsApi } from "@/shared/api/orders.api";
import type { OrderFormField } from "@/shared/api/types/forms";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { resolveMockOnce } from "@fixtures/mock-api";
import { customerDetail, customerSummary, pageResponse } from "@fixtures/api-responses";
import { currentReportPeriod } from "@/shared/lib/reportPeriod";
import { notifyReferenceDataChanged } from "@/shared/state/referenceDataEvents";
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
vi.mock("@/shared/api/stocks.api");
vi.mock("@/customer-center/CustomerLeadPanel", () => ({ CustomerLeadPanel: () => <div /> }));

const customerRows = vi.fn<(params?: Parameters<typeof customersApi.page>[0]) => Promise<import("@/shared/api/types/customers").Customer[]>>();

const customers = [
  {
    id: 1,
    customer_no: "CUS-0001",
    display_name: "张三",
    phone: "13800008888",
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
    phone: "13900009999",
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
    created_by: "admin",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  seedOptionSets();
  vi.mocked(customerRows).mockResolvedValue(customers);
  vi.mocked(customersApi.options).mockResolvedValue(customers);
  vi.mocked(customersApi.page).mockImplementation(async (params) => {
    const items = await vi.mocked(customerRows)(params);
    return pageResponse(items, { limit: params?.limit ?? 10, offset: params?.offset ?? 0 });
  });
  vi.mocked(customersApi.summary).mockResolvedValue(customerSummary({ month_count: 1, today_count: 1 }));
  vi.mocked(counterpartiesApi.list).mockResolvedValue([]);
  vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse([]));
  vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
  vi.mocked(customersApi.detail).mockResolvedValue(customerDetail(customers[0], {
    overview: {
      order_count: 1,
      active_order_count: 1,
      completed_order_count: 0,
      cancelled_order_count: 0,
      last_trade_date: "2026-10-18",
      cumulative_profit: "250.00",
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
  }));
});
describe("CustomersPage：客户档案", () => {
  it("合作方末页拉黑后回到仍有数据的页", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let changed = false;
    const last = { ...counterparties[0], id: 12, counterparty_no: "CP-LAST" };
    vi.mocked(counterpartiesApi.page).mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      return pageResponse(offset ? (changed ? [] : [last]) : [counterparties[0]], { total: changed ? 10 : 11, offset, limit: 10 });
    });
    vi.mocked(counterpartiesApi.setStatus).mockImplementation(async () => { changed = true; return last; });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    await screen.findByText("CP-0001");
    await user.click(screen.getByTitle("2"));
    const row = (await screen.findByText("CP-LAST")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /拉\s*黑/ }));
    await user.click(await screen.findByRole("button", { name: /确\s*定|确\s*认/ }));
    await waitFor(() => expect(counterpartiesApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })));
    expect(await screen.findByText("CP-0001")).toBeVisible();
  });

  it("切换创建日期只刷新当前客户页签", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    await waitFor(() => expect(counterpartiesApi.page).toHaveBeenCalledTimes(1));
    vi.mocked(customersApi.page).mockClear();
    vi.mocked(customersApi.summary).mockClear();
    vi.mocked(counterpartiesApi.page).mockClear();
    await user.click(screen.getByRole("button", { name: "上期" }));
    await waitFor(() => expect(counterpartiesApi.page).toHaveBeenCalledTimes(1));
    const period = vi.mocked(counterpartiesApi.page).mock.calls[0][0];
    expect(customersApi.page).not.toHaveBeenCalled();
    expect(customersApi.summary).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "客户档案" }));
    await waitFor(() => expect(customersApi.page).toHaveBeenCalledTimes(1));
    expect(customersApi.page).toHaveBeenCalledWith(expect.objectContaining({ created_from: period?.created_from, created_to: period?.created_to }));
    expect(customersApi.summary).toHaveBeenCalledTimes(1);
  });

  it("统计尚未返回时先展示已返回的客户列表", async () => {
    let finish!: (value: ReturnType<typeof customerSummary>) => void;
    const pending = new Promise<ReturnType<typeof customerSummary>>((resolve) => { finish = resolve; });
    vi.mocked(customersApi.summary).mockReturnValueOnce(pending);
    vi.mocked(customersApi.page).mockResolvedValueOnce(pageResponse(customers, { total: 11, limit: 10 }));
    renderLight(<CustomersPage />, { user: "admin" });
    expect(await screen.findByText("CUS-0001")).toBeVisible();
    expect(screen.getByText("本月新增客户数").closest(".ui-stat")).toHaveTextContent("-");
    await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByTitle("2"));
    await waitFor(() => expect(customersApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 10 })));
    expect(customersApi.summary).toHaveBeenCalledTimes(1);
    await act(async () => { finish(customerSummary({ month_count: 3, today_count: 1 })); await pending; });
    expect(screen.getByText("本月新增客户数").closest(".ui-stat")).toHaveTextContent("3");
  });

  it("统计请求失败时保留客户列表并提示重试", async () => {
    vi.mocked(customersApi.summary).mockRejectedValueOnce(new Error("客户统计读取失败"));
    renderLight(<CustomersPage />, { user: "admin" });
    expect(await screen.findByText("CUS-0001")).toBeVisible();
    expect(await screen.findByText(/客户统计读取失败/)).toBeVisible();
    expect(screen.getByText("本月新增客户数").closest(".ui-stat")).toHaveTextContent("不可用");
    await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.getByText("本月新增客户数").closest(".ui-stat")).toHaveTextContent("1"));
  });

  it("客户筛选失败隐藏旧数据，重试后显示当前结果", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    vi.mocked(customersApi.page).mockRejectedValueOnce(new Error("客户筛选失败"));
    await user.click(screen.getByRole("button", { name: "上期" }));
    expect(await screen.findByText(/客户筛选失败/)).toBeVisible();
    expect(screen.queryByText("CUS-0001")).toBeNull();
    expect(screen.getByText("客户数据不可用，请点击重新加载")).toBeVisible();
    expect(screen.getByText("客户总数").closest(".ui-stat")).toHaveTextContent("不可用");
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("CUS-0001")).toBeInTheDocument();
  });

  it("合作方首屏失败后显示不可用并可重试", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(counterpartiesApi.page).mockRejectedValueOnce(new Error("合作方读取失败"));
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    expect(await screen.findByText(/合作方读取失败/)).toBeVisible();
    expect(screen.getByText("合作方数据不可用，请点击重新加载")).toBeVisible();
    vi.mocked(counterpartiesApi.page).mockResolvedValueOnce(pageResponse(counterparties));
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("CP-0001")).toBeInTheDocument();
  });
  it("客户详情失败时保留列表，并可在详情内重试", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(customersApi.detail).mockRejectedValueOnce(new Error("客户详情读取失败"));
    renderLight(<CustomersPage />, { user: "admin" });
    await user.click(await screen.findByText("CUS-0001"));
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText(/客户详情读取失败/)).toBeVisible();
    expect(screen.getByText("CUS-0002")).toBeInTheDocument();
    expect(screen.queryByText("客户数据不可用，请点击重新加载")).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole("button", { name: "重新加载" }));
    expect(await within(drawer).findByText("13800008888")).toBeVisible();
  });

  it("合作方详情失败时保留列表，并可在详情内重试", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse(counterparties));
    vi.mocked(counterpartiesApi.get).mockRejectedValueOnce(new Error("合作方详情读取失败")).mockResolvedValueOnce(counterparties[0] as never);
    renderLight(<CustomersPage />, { user: "admin" });
    await user.click(await screen.findByRole("tab", { name: /合作方/ }));
    await user.click(await screen.findByText("CP-0001"));
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText(/合作方详情读取失败/)).toBeVisible();
    expect(screen.queryByText("合作方数据不可用，请点击重新加载")).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole("button", { name: "重新加载" }));
    expect(await within(drawer).findByText("李经理")).toBeVisible();
  });
  it("深链打开客户详情失败后仍可在抽屉中重试", async () => {
    vi.mocked(customersApi.detail).mockRejectedValueOnce(new Error("客户详情读取失败"));
    renderLight(<CustomersPage focusCustomerId={1} />, { user: "admin" });
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText(/客户详情读取失败/)).toBeVisible();
    await userEvent.setup({ pointerEventsCheck: 0 }).click(within(drawer).getByRole("button", { name: "重新加载" }));
    expect(await within(drawer).findByText("13800008888")).toBeVisible();
    expect(customersApi.detail).toHaveBeenLastCalledWith(1);
  });

  it("深链打开合作方详情失败后仍可在抽屉中重试", async () => {
    vi.mocked(counterpartiesApi.get).mockRejectedValueOnce(new Error("合作方详情读取失败")).mockResolvedValueOnce(counterparties[0] as never);
    renderLight(<CustomersPage focusCounterpartyId={11} />, { user: "admin" });
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText(/合作方详情读取失败/)).toBeVisible();
    await userEvent.setup({ pointerEventsCheck: 0 }).click(within(drawer).getByRole("button", { name: "重新加载" }));
    expect(await within(drawer).findByText("李经理")).toBeVisible();
    expect(counterpartiesApi.get).toHaveBeenLastCalledWith(11);
  });
  it("客户档案翻页时保留统计且不重复请求汇总", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(customersApi.page).mockImplementation(async (params) => pageResponse(
      params?.offset === 10 ? [{ ...customers[1], customer_no: "CUS-PAGE2" }] : [customers[0]],
      { total: 11, limit: params?.limit ?? 10, offset: params?.offset ?? 0 },
    ));
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await waitFor(() => expect(screen.getByText("本月新增客户数").closest(".ui-stat")).toHaveTextContent("1"));
    let finish!: (value: ReturnType<typeof pageResponse>) => void;
    const pending = new Promise<ReturnType<typeof pageResponse>>((resolve) => { finish = resolve; });
    vi.mocked(customersApi.page).mockReturnValueOnce(pending as never);
    await user.click(screen.getByTitle("2"));
    expect(screen.getByText("本月新增客户数").closest(".ui-stat")).toHaveTextContent("1");
    expect(customersApi.summary).toHaveBeenCalledTimes(1);
    await act(async () => { finish(pageResponse([{ ...customers[1], customer_no: "CUS-PAGE2" }], { total: 11, limit: 10, offset: 10 })); await pending; });
    expect(await screen.findByText("CUS-PAGE2")).toBeInTheDocument();
    expect(customersApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 10, offset: 10 }));
  });

  it("客户档案在后续页切换周期时只请求新周期第一页", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(customersApi.page).mockImplementation(async (params) => pageResponse(
      params?.offset === 10 ? [{ ...customers[1], customer_no: "CUS-PAGE2" }] : [customers[0]],
      { total: 11, limit: params?.limit ?? 10, offset: params?.offset ?? 0 },
    ));
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await user.click(screen.getByTitle("2"));
    await screen.findByText("CUS-PAGE2");
    vi.mocked(customersApi.page).mockClear();
    vi.mocked(customersApi.summary).mockClear();
    await user.click(screen.getByRole("button", { name: "上期" }));
    await screen.findByText("CUS-0001");
    expect(customersApi.page).toHaveBeenCalledTimes(1);
    expect(customersApi.page).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
    expect(customersApi.summary).toHaveBeenCalledTimes(1);
  });

  it("合作方翻页时加载后台下一页", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(counterpartiesApi.page).mockImplementation(async (params) => pageResponse(
      [{ ...counterparties[0], counterparty_no: params?.offset === 10 ? "CP-PAGE2" : "CP-0001" }],
      { total: 11, limit: params?.limit ?? 10, offset: params?.offset ?? 0 },
    ));
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    await screen.findByText("CP-0001");
    await user.click(screen.getByTitle("2"));
    expect(await screen.findByText("CP-PAGE2")).toBeInTheDocument();
    expect(counterpartiesApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 10, offset: 10 }));
  });

  it("合作方在后续页切换周期时只请求新周期第一页", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(counterpartiesApi.page).mockImplementation(async (params) => pageResponse(
      [{ ...counterparties[0], counterparty_no: params?.offset === 10 ? "CP-PAGE2" : "CP-0001" }],
      { total: 11, limit: params?.limit ?? 10, offset: params?.offset ?? 0 },
    ));
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    await screen.findByText("CP-0001");
    await user.click(screen.getByTitle("2"));
    await screen.findByText("CP-PAGE2");
    vi.mocked(counterpartiesApi.page).mockClear();
    await user.click(screen.getByRole("button", { name: "上期" }));
    await screen.findByText("CP-0001");
    expect(counterpartiesApi.page).toHaveBeenCalledTimes(1);
    expect(counterpartiesApi.page).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
  });
  it("切换创建日期时不显示旧周期的客户统计", async () => {
    let finish!: (value: ReturnType<typeof pageResponse>) => void;
    const pending = new Promise<ReturnType<typeof pageResponse>>((resolve) => { finish = resolve; });
    vi.mocked(customersApi.page).mockResolvedValueOnce(pageResponse(customers)).mockReturnValueOnce(pending as never);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    const stat = screen.getByText("客户总数").closest(".ui-stat") as HTMLElement;
    expect(within(stat).getByText("2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "上期" }));
    await waitFor(() => expect(customersApi.page).toHaveBeenCalledTimes(2));
    expect(within(stat).getByText("-")).toBeInTheDocument();
    await act(async () => { finish(pageResponse([])); await pending; });
    expect(within(stat).getByText("0")).toBeInTheDocument();
  });
  it("从客户中心深链参数打开指定客户卡片", async () => {
    renderLight(<CustomersPage focusCustomerId={1} />);
    expect(await screen.findByText("客户档案 · CUS-0001")).toBeInTheDocument();
  });

  it("深链客户详情不等待客户列表返回", async () => {
    let finish!: (value: Awaited<ReturnType<typeof customersApi.page>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof customersApi.page>>>((resolve) => { finish = resolve; });
    vi.mocked(customersApi.page).mockReturnValueOnce(pending);
    renderLight(<CustomersPage focusCustomerId={1} />);
    expect(await screen.findByText("客户档案 · CUS-0001")).toBeInTheDocument();
    expect(customersApi.detail).toHaveBeenCalledWith(1);
    await act(async () => finish(pageResponse([]) as never));
  });

  it("切换深链客户时忽略较晚返回的旧详情", async () => {
    let finish!: (value: Awaited<ReturnType<typeof customersApi.detail>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof customersApi.detail>>>((resolve) => { finish = resolve; });
    vi.mocked(customersApi.detail).mockReturnValueOnce(pending).mockResolvedValueOnce(customerDetail(customers[1]));
    const view = renderLight(<CustomersPage focusCustomerId={1} />);
    await waitFor(() => expect(customersApi.detail).toHaveBeenCalledWith(1));
    view.rerender(<CustomersPage focusCustomerId={2} />);
    expect(await screen.findByText("客户档案 · CUS-0002")).toBeVisible();
    await act(async () => finish(customerDetail(customers[0])));
    expect(screen.getByText("客户档案 · CUS-0002")).toBeVisible();
    expect(screen.queryByText("客户档案 · CUS-0001")).toBeNull();
  });

  it("从客户中心深链参数打开指定合作方卡片", async () => {
    vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse([]));
    vi.mocked(counterpartiesApi.get).mockResolvedValue(counterparties[0]);
    renderLight(<CustomersPage focusCounterpartyId={11} />);
    expect(await screen.findByText("合作方档案 · CP-0001")).toBeInTheDocument();
    expect(counterpartiesApi.get).toHaveBeenCalledWith(11);
  });

  it("关闭并打开另一合作方后，迟到的详情不能覆盖当前档案", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const second = { ...counterparties[0], id: 12, counterparty_no: "CP-0002", display_name: "同行乙", contact_name: "乙联系人" };
    let finishFirst!: (value: Awaited<ReturnType<typeof counterpartiesApi.get>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof counterpartiesApi.get>>>((resolve) => { finishFirst = resolve; });
    vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse([counterparties[0], second]));
    vi.mocked(counterpartiesApi.get).mockImplementation((id) => id === 11 ? first : Promise.resolve(second));
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    await user.click(await screen.findByRole("link", { name: "CP-0001" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("link", { name: "CP-0002" }));
    expect(await screen.findByText("乙联系人")).toBeInTheDocument();
    await act(async () => { finishFirst(counterparties[0]); await first; });
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("乙联系人")).toBeInTheDocument();
    expect(within(drawer).queryByText("李经理")).not.toBeInTheDocument();
  });

  it("加载成功后渲染客户编号与状态标签", async () => {
    renderLight(<CustomersPage />);
    expect(await screen.findByText("CUS-0001")).toBeInTheDocument();
    expect(screen.getByText("CUS-0002")).toBeInTheDocument();
    // ACTIVE 文案现由 CUSTOMER_STATUS 选项词典提供（设置页可改）
    expect(screen.getByText("启用中")).toBeInTheDocument(); // ACTIVE
    expect(screen.getAllByText("已拉黑").length).toBeGreaterThanOrEqual(1); // DISABLED
  });

  it("客户编号和合作方编号点击后打开详情", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse(counterparties));
    vi.mocked(counterpartiesApi.get).mockResolvedValue({
      ...counterparties[0],
      overview: { order_count: 2, active_order_count: 1, completed_order_count: 1, cumulative_profit: "350.00" },
      orders: [{ order_id: 10, order_no: "TH-2026-0010", order_type: "TH", status: "COMPLETED", trade_date: "2026-10-18", roles: ["PEER"], profit: "350.00" }],
    });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");

    await user.click(screen.getByRole("link", { name: "CUS-0001" }));
    expect(await screen.findByText("客户档案 · CUS-0001")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    const panel = await screen.findByRole("tabpanel");
    await user.click(within(panel).getByRole("link", { name: "CP-0001" }));
    expect(await screen.findByText("合作方档案 · CP-0001")).toBeInTheDocument();
    expect(screen.getByText("订单数")).toBeInTheDocument();
    expect(screen.getByText("累计利润")).toBeInTheDocument();
    const orderCountCard = screen.getByTestId("counterparty-detail-order-count");
    const profitCard = screen.getByTestId("counterparty-detail-profit");
    const ordersHeading = screen.getByRole("heading", { name: "成单明细" });
    expect(orderCountCard.compareDocumentPosition(ordersHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(profitCard.compareDocumentPosition(ordersHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(orderCountCard.closest(".ui-stat")).toBeInTheDocument();
    expect(profitCard.closest(".ui-stat")).toBeInTheDocument();
    expect(screen.getByText("成单明细")).toBeInTheDocument();
    expect(screen.getByText("TH-2026-0010")).toBeInTheDocument();
  });

  it("客户搜索按钮不嵌套 button，保持合法且可访问的 DOM 结构", async () => {
    renderLight(<CustomersPage />);
    await screen.findByText("CUS-0001");
    expect(document.querySelector(".customer-list-filters button button")).toBeNull();
  });

  it("客户状态筛选覆盖已合并状态", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await user.click(screen.getByRole("combobox", { name: "客户状态" }));
    expect(await screen.findByText("已合并", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("客户档案和合作方支持按创建操作人多选筛选", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(employeesApi.list).mockResolvedValue([
      { id: 1, username: "admin", display_name: "管理员", is_active: true },
      { id: 2, username: "alice", display_name: "小雅", is_active: true },
    ]);
    vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse(counterparties));
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");

    await user.click(screen.getByRole("combobox", { name: "客户创建操作人筛选" }));
    await user.click((await screen.findAllByText("管理员", { selector: ".ant-select-item-option-content" }))[0]);
    await waitFor(() => expect(customersApi.page).toHaveBeenLastCalledWith({
      created_by: ["admin"],
      created_from: currentReportPeriod().from,
      created_to: currentReportPeriod().to,
      limit: 10,
      offset: 0,
    }));
    expect(customersApi.summary).toHaveBeenLastCalledWith(expect.objectContaining({ created_by: ["admin"] }));

    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    const panel = await screen.findByRole("tabpanel");
    await user.click(within(panel).getByRole("combobox", { name: "合作方创建操作人筛选" }));
    const creatorOptions = await screen.findAllByText("管理员", { selector: ".ant-select-item-option-content" });
    await user.click(creatorOptions[creatorOptions.length - 1]);
    await waitFor(() => expect(counterpartiesApi.page).toHaveBeenLastCalledWith({
      created_by: ["admin"],
      created_from: currentReportPeriod().from,
      created_to: currentReportPeriod().to,
      limit: 10,
      offset: 0,
    }));
  });

  it("后端不可达时显示错误条而不是空白页", async () => {
    vi.mocked(customerRows).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<CustomersPage />);
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("FE-242：客户接口失败时统计显示不可用并保护依赖入口", async () => {
    vi.mocked(customerRows).mockRejectedValueOnce({ isAxiosError: true, message: "customers down" });
    renderLight(<CustomersPage />, { user: "admin" });

    expect(await screen.findByText("客户数据不可用，请点击重新加载")).toBeInTheDocument();
    const stats = document.querySelector(".ui-stat-row") as HTMLElement;
    expect(within(stats).getAllByText("不可用")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "导出客户数据" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /新建客户/ })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "客户状态" })).toBeDisabled();
  });

  it("业务错误码给出可执行的处置提示", async () => {
    vi.mocked(customerRows).mockRejectedValueOnce({
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
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => (
      scope === "CUSTOMER"
        ? [{ id: 101, order_type_code: "CUSTOMER", field_key: "display_name", label: "客户称呼", field_type: "TEXT", options: null, required: true, is_active: true, sort_order: 10, locked: false, is_custom: false, note: null }]
        : [{ id: 102, order_type_code: "COUNTERPARTY", field_key: "type", label: "合作类型", field_type: "SELECT", options: null, required: true, is_active: true, sort_order: 10, locked: false, is_custom: false, note: null }]
    ) as never);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");

    await user.click(screen.getByRole("button", { name: /新建客户$/ }));
    await waitFor(() => expect(orderFormFieldsApi.list).toHaveBeenCalledWith("CUSTOMER", true));
    expect(screen.getByLabelText("客户称呼")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    await user.click((await screen.findByRole("button", { name: /新建合作方$/ })));
    await waitFor(() => expect(orderFormFieldsApi.list).toHaveBeenCalledWith("COUNTERPARTY", true));
    expect(screen.getByLabelText("合作类型")).toBeInTheDocument();
  });

  it("客户和合作方页面已打开时，自定义字段变更后无需刷新即可使用", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let updated = false;
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => updated ? [{
      id: scope === "CUSTOMER" ? 201 : 202,
      order_type_code: scope,
      field_key: "new_custom_field",
      label: scope === "CUSTOMER" ? "客户新字段" : "合作方新字段",
      field_type: "TEXT",
      options: null,
      required: false,
      is_active: true,
      sort_order: 1,
      locked: false,
      is_custom: true,
    }] as never : []);
    vi.mocked(counterpartiesApi.create).mockResolvedValue({ id: 12 } as never);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    await waitFor(() => expect(orderFormFieldsApi.list).toHaveBeenCalledWith("COUNTERPARTY", true));

    updated = true;
    await act(async () => { notifyReferenceDataChanged("formFields"); });
    await user.click(screen.getByRole("button", { name: /新建合作方$/ }));
    await user.type(await screen.findByLabelText("名称"), "新合作方");
    await user.type(await screen.findByLabelText("合作方新字段"), "更新后的字段值");
    await user.click(screen.getByRole("button", { name: "建档" }));
    await waitFor(() => expect(counterpartiesApi.create).toHaveBeenCalledWith(expect.objectContaining({
      extra_values: { new_custom_field: "更新后的字段值" },
    })));
    await user.click(screen.getByRole("tab", { name: "客户档案" }));
    await user.click(screen.getByRole("button", { name: /新建客户$/ }));
    expect(await screen.findByLabelText("客户新字段")).toBeInTheDocument();
  });

  it("合作方字段配置失败后必须重新加载，不能丢弃已填写的扩展字段", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let calls = 0;
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => {
      if (scope !== "COUNTERPARTY") return [];
      calls += 1;
      if (calls === 1) throw new Error("字段配置暂不可用");
      return [{ id: 202, order_type_code: scope, field_key: "new_custom_field", label: "合作方新字段", field_type: "TEXT", options: null, required: false, is_active: true, sort_order: 1, locked: false, is_custom: true }] as never;
    });
    vi.mocked(counterpartiesApi.create).mockResolvedValue({ id: 12 } as never);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    await waitFor(() => expect(calls).toBe(1));
    await user.click(screen.getByRole("button", { name: /新建合作方$/ }));
    expect(await screen.findByText(/字段配置暂不可用/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "建档" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "建档" })).toBeEnabled());
    await user.type(screen.getByLabelText("名称"), "新合作方");
    await user.type(await screen.findByLabelText("合作方新字段"), "保留字段值");
    await user.click(screen.getByRole("button", { name: "建档" }));
    await waitFor(() => expect(counterpartiesApi.create).toHaveBeenCalledWith(expect.objectContaining({
      extra_values: { new_custom_field: "保留字段值" },
    })));
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
    vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse(counterparties));
    vi.mocked(counterpartiesApi.get).mockResolvedValue(counterparties[0]);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");

    await user.click(screen.getByRole("tab", { name: /合作方/ }));
    const panel = await screen.findByRole("tabpanel");
    expect(within(panel).getByText("CP-0001")).toBeInTheDocument();
    expect(within(panel).getByText("admin")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /详情/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /编辑/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /拉黑/ })).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: /详情/ }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("合作方档案 · CP-0001")).toBeInTheDocument();
    expect(within(drawer).getByText("创建操作人")).toBeInTheDocument();
    expect(within(drawer).getByText("admin")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /编辑/ })).toBeInTheDocument();
  });

  it("已合并（终态）客户行只保留详情，不暴露合并/拉黑/解除拉黑（L1595）", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(customerRows).mockResolvedValue([
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

describe("CustomersPage：联系方式直接展示", () => {
  it("列表直接展示完整联系方式，不提供额外揭示动作", async () => {
    vi.mocked(customerRows).mockResolvedValue([customers[0]]);
    renderLight(<CustomersPage />, { user: "admin" });

    expect(await screen.findByText("13800008888")).toBeInTheDocument();
    expect(screen.getByText("zhangsan")).toBeInTheDocument();
    expect(screen.getByText("10001")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查看/ })).not.toBeInTheDocument();
  });

  it("编辑保存时提交完整联系方式", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(customerRows).mockResolvedValue([customers[0]]);
    vi.mocked(customersApi.patch).mockResolvedValue(customers[0]);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("13800008888");

    await user.click(screen.getAllByRole("button", { name: /详情/ })[0]);
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: /编辑/ }));

    const nameInput = await screen.findByLabelText("名字");
    await user.clear(nameInput);
    await user.type(nameInput, "张三改");
    await user.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => expect(customersApi.patch).toHaveBeenCalled());
    const payload = vi.mocked(customersApi.patch).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.display_name).toBe("张三改");
    expect(payload.phone).toBe("13800008888");
    expect(payload.wechat).toBe("zhangsan");
    expect(payload.qq).toBe("10001");
  });
});

// —— 原 CustomersPage.actions.test.tsx ——
// 同一页面、同一份 catalog automock + 同一份 CustomerLeadPanel 替身。
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
  ] as unknown as import("@/shared/api/types/forms").OrderFormField[];

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
    overview: { order_count: 1, active_order_count: 1, completed_order_count: 0, cancelled_order_count: 0, last_trade_date: "2026-10-18", cumulative_profit: "250.00", installment_paid_total: "100.00", installment_receivable_total: "1000.00", installment_remaining_total: "900.00", overdue_period_count: 1 },
    business: [{ order_id: 10, order_no: "HS-2026-0010", order_type: "HS", status: "ACTIVE", trade_date: "2026-10-18", roles: ["BUYER"] }],
    installments: [{ id: 20, inst_no: "HS-2026-0010-INS01", order_id: 10, order_no: "HS-2026-0010", contract_type: "STOCK_SALE", status: "OVERDUE", principal: "1000.00", total_receivable: "1000.00", paid_amount: "100.00", remaining_amount: "900.00", overdue_periods: 1, first_due_on: "2026-10-17" }],
    audit: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    seedOptionSets();
    vi.mocked(customerRows).mockResolvedValue(customers as unknown as never);
    vi.mocked(customersApi.options).mockResolvedValue(customers.filter((item) => item.status === "ACTIVE"));
    vi.mocked(customersApi.page).mockImplementation(async (params) => {
      const items = await vi.mocked(customerRows)(params);
      return pageResponse(items, { limit: params?.limit ?? 10, offset: params?.offset ?? 0 });
    });
    vi.mocked(counterpartiesApi.list).mockResolvedValue(counterparties as unknown as never);
    vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse(counterparties));
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue(fieldDefs as unknown as never);
    vi.mocked(customersApi.detail).mockResolvedValue(detail as unknown as never);
    vi.mocked(counterpartiesApi.get).mockResolvedValue(counterparties[0] as unknown as never);
  });

  describe("CustomersPage：客户与合作方操作流", () => {
    it("合并弹窗重开后忽略上一次迟到的客户名单", async () => {
      let finishFirst!: (value: Awaited<ReturnType<typeof customersApi.options>>) => void;
      const first = new Promise<Awaited<ReturnType<typeof customersApi.options>>>((resolve) => { finishFirst = resolve; });
      let candidateRequests = 0;
      vi.mocked(customersApi.options).mockImplementation(async () => {
        candidateRequests += 1;
        return candidateRequests === 1 ? first : [customers[1]];
      });
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getAllByRole("button", { name: /合并/ })[0]);
      const dialog = await screen.findByRole("dialog");
      await ui.click(dialog.querySelector(".ant-modal-close") as Element);
      await ui.click(screen.getAllByRole("button", { name: /合并/ })[0]);
      await waitFor(() => expect(candidateRequests).toBe(2));
      await act(async () => { finishFirst([{ ...customers[0], id: 3, customer_no: "CUS-0003", display_name: "旧名单" }]); await first; });
      const reopened = await screen.findByRole("dialog");
      await ui.click(reopened.querySelector(".ant-select-selector") as Element);
      expect(await screen.findByText("CUS-0002 李四", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
      expect(screen.queryByText("CUS-0003 旧名单", { selector: ".ant-select-item-option-content" })).not.toBeInTheDocument();
    });
    it("合并客户可按名称搜索候选", async () => {
      vi.mocked(customersApi.options).mockImplementation(async (keyword) => keyword === "李四" ? [customers[1]] : []);
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getAllByRole("button", { name: /合并/ })[0]);
      const modal = await screen.findByRole("dialog");
      await ui.type(within(modal).getByLabelText("目标客户（需为有效客户）"), "李四");
      expect(await screen.findByText("CUS-0002 李四", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    });
    it("客户建档请求未完成时不能重复提交", async () => {
      let finish!: (value: Awaited<ReturnType<typeof customersApi.create>>) => void;
      const pending = new Promise<Awaited<ReturnType<typeof customersApi.create>>>((resolve) => { finish = resolve; });
      vi.mocked(customersApi.create).mockReturnValueOnce(pending);
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getByRole("button", { name: "新建客户" }));
      const modal = await screen.findByRole("dialog");
      await ui.type(within(modal).getByLabelText("名字"), "测试客户");
      const button = within(modal).getByRole("button", { name: "建档" });
      await ui.click(button);
      await waitFor(() => expect(customersApi.create).toHaveBeenCalledTimes(1));
      await ui.click(button);
      expect(customersApi.create).toHaveBeenCalledTimes(1);
      await act(async () => { finish({ customer: customers[0], duplicate_candidates: [] } as never); await pending; });
    });

    it("合作方建档请求未完成时不能重复提交", async () => {
      let finish!: (value: Awaited<ReturnType<typeof counterpartiesApi.create>>) => void;
      const pending = new Promise<Awaited<ReturnType<typeof counterpartiesApi.create>>>((resolve) => { finish = resolve; });
      vi.mocked(counterpartiesApi.create).mockReturnValueOnce(pending);
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getByRole("tab", { name: /合作方/ }));
      await ui.click(await screen.findByRole("button", { name: "新建合作方" }));
      const modal = await screen.findByRole("dialog");
      await ui.type(within(modal).getByLabelText("名称"), "测试合作方");
      const button = within(modal).getByRole("button", { name: "建档" });
      await ui.click(button);
      await waitFor(() => expect(counterpartiesApi.create).toHaveBeenCalledTimes(1));
      await ui.click(button);
      expect(counterpartiesApi.create).toHaveBeenCalledTimes(1);
      await act(async () => { finish(counterparties[0] as never); await pending; });
    });
    it("新建客户失败在弹窗显示原因", async () => {
      vi.mocked(customersApi.create).mockRejectedValueOnce(new Error("客户建档失败"));
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getByRole("button", { name: "新建客户" }));
      const modal = await screen.findByRole("dialog");
      await ui.type(within(modal).getByLabelText("名字"), "待建客户");
      await ui.click(within(modal).getByRole("button", { name: "建档" }));
      expect(await within(modal).findByText(/客户建档失败/)).toBeVisible();
      expect(within(modal).getByLabelText("名字")).toHaveValue("待建客户");
    });

    it("新建合作方失败在弹窗显示原因", async () => {
      vi.mocked(counterpartiesApi.create).mockRejectedValueOnce(new Error("合作方建档失败"));
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getByRole("tab", { name: /合作方/ }));
      await ui.click(await screen.findByRole("button", { name: "新建合作方" }));
      const modal = await screen.findByRole("dialog");
      await ui.type(within(modal).getByLabelText("名称"), "待建合作方");
      await ui.click(within(modal).getByRole("button", { name: "建档" }));
      expect(await within(modal).findByText(/合作方建档失败/)).toBeVisible();
      expect(within(modal).getByLabelText("名称")).toHaveValue("待建合作方");
    });
    it("客户编辑失败在弹窗显示原因并可重试", async () => {
      vi.mocked(customersApi.patch).mockRejectedValueOnce(new Error("客户保存失败"));
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click((await screen.findAllByRole("button", { name: /详情/ }))[0]);
      await ui.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /编辑/ }));
      const modal = (await screen.findByText("编辑客户 · CUS-0001")).closest(".ant-modal-content") as HTMLElement;
      await ui.clear(within(modal).getByLabelText("名字"));
      await ui.type(within(modal).getByLabelText("名字"), "新名字");
      await ui.click(within(modal).getByRole("button", { name: "保存" }));
      expect(await within(modal).findByText(/客户保存失败/)).toBeVisible();
      expect(within(modal).getByLabelText("名字")).toHaveValue("新名字");
      await ui.click(within(modal).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(customersApi.patch).toHaveBeenCalledTimes(2));
    });

    it("合作方编辑失败在弹窗显示原因并可重试", async () => {
      vi.mocked(counterpartiesApi.patch).mockRejectedValueOnce(new Error("合作方保存失败"));
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getByRole("tab", { name: /合作方/ }));
      await ui.click(within(await screen.findByRole("tabpanel")).getByRole("button", { name: "编辑" }));
      const modal = (await screen.findByText("编辑合作方 · CP-0001")).closest(".ant-modal-content") as HTMLElement;
      await ui.clear(within(modal).getByLabelText("名称"));
      await ui.type(within(modal).getByLabelText("名称"), "合作方新名称");
      await ui.click(within(modal).getByRole("button", { name: "保存" }));
      expect(await within(modal).findByText(/合作方保存失败/)).toBeVisible();
      expect(within(modal).getByLabelText("名称")).toHaveValue("合作方新名称");
      await ui.click(within(modal).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(counterpartiesApi.patch).toHaveBeenCalledTimes(2));
    });
    it("拉黑 ACTIVE 客户：确认后调用 setStatus(DISABLED) 并提示", async () => {
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getAllByRole("button", { name: /拉\s*黑/ })[0]);
      const confirm = await screen.findByRole("button", { name: /确\s*定|确\s*认/ });
      await ui.click(confirm);
      await waitFor(() => expect(vi.mocked(customersApi.setStatus)).toHaveBeenCalledWith(1, "DISABLED"));
    });

    it("合并客户：选择目标与原因后提交调用 merge", async () => {
      renderLight(<CustomersPage />, { user: "admin" });
      await screen.findByText("CUS-0001");
      await ui.click(screen.getAllByRole("button", { name: /合\s*并/ })[0]);
      await waitFor(() => expect(vi.mocked(customersApi.options)).toHaveBeenCalledWith(""));
      const modal = await screen.findByRole("dialog");
      const selector = modal.querySelector(".ant-select-selector") as Element;
      await ui.click(selector);
      const dropdowns = document.querySelectorAll(".ant-select-dropdown");
      const current = dropdowns[dropdowns.length - 1] as HTMLElement;
      await ui.click(await within(current).findByText("CUS-0002 李四"));
      await ui.type(modal.querySelector("#reason") ?? modal, "重复建档合并");
      await ui.click(within(modal).getByRole("button", { name: /确认合并/ }));
      await waitFor(() => expect(vi.mocked(customersApi.merge)).toHaveBeenCalled());
      const [id, targetId, reason] = vi.mocked(customersApi.merge).mock.calls[0] as [number, number, string];
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
      await waitFor(() => expect(vi.mocked(customersApi.patch)).toHaveBeenCalled());
      const [id, payload] = vi.mocked(customersApi.patch).mock.calls[0] as [number, Record<string, unknown>];
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
      await waitFor(() => expect(vi.mocked(counterpartiesApi.patch)).toHaveBeenCalled());
      const [id, payload] = vi.mocked(counterpartiesApi.patch).mock.calls[0] as [number, Record<string, unknown>];
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
      await waitFor(() => expect(vi.mocked(counterpartiesApi.setStatus)).toHaveBeenCalledWith(11, false));
    });
  });

  it("FE-194：客户 CSV 导出完成后给出成功反馈", async () => {
    vi.mocked(customerRows).mockResolvedValueOnce([
      { id: 1, customer_no: "CUS-0001", display_name: "测试客户", status: "ACTIVE" },
    ] as never);
    vi.mocked(customersApi.exportCsv).mockResolvedValueOnce(new Blob(["csv"]) as never);
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:customer");
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const successSpy = vi.spyOn(appMessage, "success").mockImplementation(() => ({} as never));
    const keeper = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<CustomerPanel />, { user: "admin" });

    await screen.findByText("CUS-0001");
    expect(screen.getByRole("button", { name: "导出客户数据" }).closest(".customer-list-filters")).not.toBeNull();
    await keeper.click(screen.getByRole("button", { name: "最旧在前" }));
    await keeper.click(screen.getByRole("button", { name: "导出客户数据" }));
    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("客户数据已导出"));
    expect(customersApi.exportCsv).toHaveBeenCalledWith(expect.objectContaining({ sort_desc: false }));
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    clickSpy.mockRestore();
    successSpy.mockRestore();
  });
});

// —— 原 CustomersPage.write.test.tsx ——
// 同一页面、同一份 jsdom+antd 启动；保留独立 fixture 作用域，避免与上面的展示/行内动作数据互相污染。
describe("CustomersPage：权限门控与写操作", () => {
  let ui: ReturnType<typeof userEvent.setup>;

  const fieldDefs = [
    { id: 1, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "game_category", label: "常玩品类", field_type: "MULTI_SELECT", options: [{ value: "王者荣耀", label: "王者荣耀" }, { value: "和平精英", label: "和平精英" }], required: false, sort_order: 10, is_active: true },
    { id: 2, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "credit_level", label: "信用评级", field_type: "SELECT", options: [{ value: "优质", label: "优质" }, { value: "一般", label: "一般" }, { value: "观察", label: "观察" }, { value: "黑名单", label: "黑名单" }], required: false, sort_order: 20, is_active: true },
    { id: 3, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "referrer", label: "转介绍人", field_type: "TEXT", options: null, required: false, sort_order: 30, is_active: true },
    { id: 4, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "legacy_note", label: "历史备注", field_type: "TEXT", options: null, required: false, sort_order: 40, is_active: false },
  ] as unknown as import("@/shared/api/types/forms").OrderFormField[];

  const customers = [
    { id: 1, customer_no: "CUS-0001", display_name: "张三", phone: "138****8888", wechat: "zhangsan", qq: "10001", status: "ACTIVE", created_by: "admin", extra_values: { credit_level: "优质", legacy_note: "早期客户" } },
    { id: 2, customer_no: "CUS-0002", display_name: "李四", phone: "139****9999", wechat: "", qq: "", status: "DISABLED", extra_values: {} },
  ];

  beforeEach(() => {
    ui = userEvent.setup({ pointerEventsCheck: 0 });
    vi.clearAllMocks();
    seedOptionSets();
    vi.mocked(customerRows).mockResolvedValue(customers);
  vi.mocked(customersApi.options).mockResolvedValue(customers);
    vi.mocked(customersApi.page).mockImplementation(async (params) => {
      const items = await vi.mocked(customerRows)(params);
      return pageResponse(items, { limit: params?.limit ?? 10, offset: params?.offset ?? 0 });
    });
    vi.mocked(counterpartiesApi.list).mockResolvedValue([]);
    vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse([]));
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue(fieldDefs);
    vi.mocked(customersApi.detail).mockResolvedValue(customerDetail(customers[0], {
      overview: { order_count: 1, active_order_count: 1, completed_order_count: 0, cancelled_order_count: 0, last_trade_date: "2026-10-18", cumulative_profit: "250.00", installment_paid_total: "100.00", installment_receivable_total: "1000.00", installment_remaining_total: "900.00", overdue_period_count: 1 },
      business: [{ order_id: 10, order_no: "HS-2026-0010", order_type: "HS", status: "ACTIVE", trade_date: "2026-10-18", roles: ["BUYER"] }],
      installments: [{ id: 20, inst_no: "HS-2026-0010-INS01", order_id: 10, order_no: "HS-2026-0010", contract_type: "STOCK_SALE", status: "OVERDUE", principal: "1000.00", total_receivable: "1000.00", paid_amount: "100.00", remaining_amount: "900.00", overdue_periods: 1, first_due_on: "2026-10-17" }],
    }));
  });

  it("admin 可见「新建客户」入口，且非 ACTIVE 客户合并按钮禁用", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
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
    resolveMockOnce(vi.mocked(customersApi.create), { customer: { id: 3, customer_no: "CUS-0003" }, duplicate_candidates: [] });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("button", { name: /新建/ }));
    await ui.type(await screen.findByLabelText("名字"), "王五");
    await ui.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(vi.mocked(customersApi.create)).toHaveBeenCalled());
    expect(vi.mocked(customersApi.create).mock.calls[0][0]).toMatchObject({ display_name: "王五" });
    await waitFor(() => expect(customersApi.summary).toHaveBeenCalledTimes(2));
  });

  it("重复候选不拦截，只提示（创建仍成功）", async () => {
    const warningSpy = vi.spyOn(appMessage, "warning");
    resolveMockOnce(vi.mocked(customersApi.create), { customer: { id: 4 }, duplicate_candidates: [{ id: 2 }] });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("button", { name: /新建/ }));
    await ui.type(await screen.findByLabelText("名字"), "李四");
    await ui.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(vi.mocked(customersApi.create)).toHaveBeenCalled());
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("重复候选"));
    await waitFor(() => expect(vi.mocked(customersApi.page)).toHaveBeenCalledTimes(2));
  });

  it("合并弹窗取消后重开不残留上次选的目标客户与原因", async () => {
    vi.mocked(customerRows).mockResolvedValue([
      { id: 1, customer_no: "CUS-0001", display_name: "张三", phone: "138****8888", status: "ACTIVE", extra_values: {} },
      { id: 2, customer_no: "CUS-0002", display_name: "李四", phone: "139****9999", status: "ACTIVE", extra_values: {} },
    ]);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    const mergeButtons = screen.getAllByRole("button", { name: /合\s*并/ });
    await ui.click(mergeButtons[0]);
    const dialog = await screen.findByRole("dialog");
    await ui.click(within(dialog).getByLabelText("目标客户（需为有效客户）").closest(".ant-form-item")!.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("CUS-0002 李四", { selector: ".ant-select-item-option-content" }));
    await ui.type(within(dialog).getByLabelText("合并原因"), "重复建档，保留李四");
    await ui.click(dialog.querySelector(".ant-modal-close") as Element);
    await ui.click(screen.getAllByRole("button", { name: /合\s*并/ })[0]);
    await waitFor(() => {
      const dialogs = document.querySelectorAll<HTMLElement>(".ant-modal-content");
      const reopened = Array.from(dialogs).find((el) => el.textContent?.includes("合并客户 · CUS-0001"));
      expect(reopened).toBeTruthy();
      expect(within(reopened!).getByLabelText("合并原因")).toHaveValue("");
      expect(reopened!.querySelector("#target_customer_id")?.closest(".ant-form-item")?.querySelector(".ant-select-selection-item")).toBeNull();
    });
  });

  it("客户详情加载经营概览、关联订单和分期收款", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getAllByRole("button", { name: /详\s*情/ })[0]);
    expect(vi.mocked(customersApi.detail)).toHaveBeenCalledWith(1);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("经营概览")).toBeInTheDocument();
    expect(within(drawer).getByText("累计利润")).toBeInTheDocument();
    expect(within(drawer).getByText("250.00")).toBeInTheDocument();
    expect(within(drawer).getByText("admin")).toBeInTheDocument();
    expect(within(drawer).getAllByText("关联订单").length).toBeGreaterThanOrEqual(2);
    expect(within(drawer).getAllByText("HS-2026-0010").length).toBeGreaterThanOrEqual(2);
    expect(within(drawer).getByText("分期收款")).toBeInTheDocument();
    expect(within(drawer).getByText("逾期 1 期")).toBeInTheDocument();
  });

  it("客户详情加载中不展示列表快照字段", async () => {
    let resolveDetail!: (value: unknown) => void;
    vi.mocked(customersApi.detail).mockImplementationOnce(() => new Promise((resolve) => { resolveDetail = resolve; }) as never);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getAllByRole("button", { name: /详情/ })[0]);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("status", { name: "正在加载客户详情" })).toBeInTheDocument();
    expect(within(drawer).queryByText("138****8888")).not.toBeInTheDocument();
    resolveDetail({ customer: customers[0], overview: {}, business: [], installments: [], audit: [] });
    await waitFor(() => expect(within(drawer).queryByRole("status", { name: "正在加载客户详情" })).toBeNull());
  });

  it("客户列表支持关键词搜索并把条件传给后端", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.type(screen.getByRole("searchbox", { name: "搜索客户" }), "张三");
    await ui.click(screen.getByRole("button", { name: "搜索客户" }));
    await waitFor(() => expect(vi.mocked(customersApi.page)).toHaveBeenCalledWith({ keyword: "张三", created_from: currentReportPeriod().from, created_to: currentReportPeriod().to, limit: 10, offset: 0 }));
  });

  it("客户 CSV 导出完成后给出成功反馈", async () => {
    const successSpy = vi.spyOn(appMessage, "success");
    vi.mocked(customersApi.exportCsv).mockResolvedValueOnce(new Blob(["csv"]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:customer");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("button", { name: "导出客户数据" }));
    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("客户数据已导出"));
  });
});

// —— 原 CustomersPage.live-fields.test.tsx ——
// 扩展字段（BAS-04）：列表摘要列 / 新建弹窗动态控件 / 详情抽屉停用字段 / 定义接口失败降级。
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
  ] as unknown as import("@/shared/api/types/forms").OrderFormField[];

  beforeEach(() => {
    ui = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue(liveFieldDefs);
  });

  it("列表按字段定义渲染扩展字段摘要列", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    expect(await screen.findByText(/信用评级：优质/)).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(orderFormFieldsApi.list)).toHaveBeenCalledWith("CUSTOMER", true));
  });

  it("新建弹窗动态渲染扩展字段控件，提交时回传 extra_values", async () => {
    resolveMockOnce(vi.mocked(customersApi.create), { customer: { id: 3 }, duplicate_candidates: [] });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("button", { name: /新建/ }));
    await ui.type(await screen.findByLabelText("名字"), "王五");
    await ui.type(await screen.findByLabelText("转介绍人"), "老王");
    await ui.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(vi.mocked(customersApi.create)).toHaveBeenCalled());
    expect(vi.mocked(customersApi.create).mock.calls[0][0]).toMatchObject({ display_name: "王五", extra_values: { referrer: "老王" } });
  });

  it.each([["新建", "必填"], ["编辑", "必填"], ["新建", "条件必填"], ["编辑", "条件必填"]])(
    "客户%s时自定义文本%s不接受纯空白", async (mode, requiredMode) => {
      const def = { ...liveFieldDefs[2], required: requiredMode === "必填",
        required_when: requiredMode === "条件必填" ? { field: "phone", op: "filled" as const } : null };
      const onSubmit = vi.fn();
      function Harness() {
        const [form] = Form.useForm();
        return mode === "新建"
          ? <CustomerCreateModal createOpen activeDefs={[def]} form={form} onCancel={() => undefined} onSubmit={onSubmit} />
          : <CustomerEditModal editTarget={customers[0] as never} activeDefs={[def]} editForm={form} onCancel={() => undefined} onSubmit={onSubmit} />;
      }
      renderLight(<Harness />, { user: "admin" });
      if (mode === "新建") {
        await ui.type(await screen.findByLabelText("名字"), "客户甲");
        if (requiredMode === "条件必填") await ui.type(screen.getByLabelText("手机号"), "13800008888");
      }
      const field = await screen.findByLabelText("转介绍人");
      await ui.type(field, "   ");
      await ui.click(screen.getByRole("button", { name: mode === "新建" ? /建\s*档/ : "保存" }));
      await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it("合作方自定义字段提交到 extra_values", async () => {
    const counterpartyFieldDefs = [{
      id: 101,
      order_type_code: "COUNTERPARTY",
      is_custom: true,
      locked: false,
      field_key: "settlement_note",
      label: "结算备注",
      field_type: "TEXT",
      options: null,
      required: false,
      sort_order: 10,
      is_active: true,
    }] as unknown as import("@/shared/api/types/forms").OrderFormField[];
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => (
      scope === "COUNTERPARTY" ? counterpartyFieldDefs : liveFieldDefs
    ) as never);
    vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse([]));
    vi.mocked(counterpartiesApi.create).mockResolvedValue({ id: 12 } as never);

    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("tab", { name: /合作方/ }));
    await ui.click(await screen.findByRole("button", { name: /新建合作方$/ }));
    await ui.type(await screen.findByLabelText("名称"), "同行乙");
    await ui.type(await screen.findByLabelText("结算备注"), "月结");
    await ui.click(screen.getByRole("button", { name: "建档" }));

    await waitFor(() => expect(counterpartiesApi.create).toHaveBeenCalled());
    expect(counterpartiesApi.create).toHaveBeenCalledWith(expect.objectContaining({
      display_name: "同行乙",
      extra_values: { settlement_note: "月结" },
    }));
  });

  it("客户编辑时把日期扩展字段回填到日期控件", async () => {
    const dateDef = {
      id: 201,
      order_type_code: "CUSTOMER",
      is_custom: true,
      locked: false,
      field_key: "birthday",
      label: "生日",
      field_type: "DATE",
      options: null,
      required: false,
      sort_order: 10,
      is_active: true,
    } as unknown as import("@/shared/api/types/forms").OrderFormField;
    function DateEditHarness() {
      const [editForm] = Form.useForm();
      return (
        <CustomerEditModal
          editTarget={{ ...customers[0], extra_values: { birthday: "2026-11-16" } } as never}
          activeDefs={[dateDef]}
          editForm={editForm}
          onCancel={() => undefined}
          onSubmit={() => undefined}
        />
      );
    }
    renderLight(
      <DateEditHarness />,
    );

    expect(await screen.findByLabelText("生日")).toHaveValue("2026-11-16");
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
    vi.mocked(orderFormFieldsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<CustomersPage />, { user: "admin" });
    expect(await screen.findByText("CUS-0001")).toBeInTheDocument();
  });
});
