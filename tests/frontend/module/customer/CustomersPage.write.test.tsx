import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { CustomersPage } from "@/customer-center/CustomersPage";
import { resolveMockOnce } from "@fixtures/mock-api";

import { counterpartiesApi, customersApi } from "@/shared/api/customers.api";
import { orderFormFieldsApi } from "@/shared/api/orders.api";
import type { OrderFormField } from "@/shared/api/types/forms";
import { seedOptionSets } from "@fixtures/optionSetsSeed";
import { pageResponse } from "@fixtures/api-responses";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;
vi.mock("@/customer-center/CustomerLeadPanel", () => ({ CustomerLeadPanel: () => <div /> }));

const fieldDefs = [
  { id: 1, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "game_category", label: "常玩品类", field_type: "MULTI_SELECT", options: [{ value: "王者荣耀", label: "王者荣耀" }, { value: "和平精英", label: "和平精英" }], required: false, sort_order: 10, is_active: true },
  { id: 2, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "credit_level", label: "信用评级", field_type: "SELECT", options: [{ value: "优质", label: "优质" }, { value: "一般", label: "一般" }, { value: "观察", label: "观察" }, { value: "黑名单", label: "黑名单" }], required: false, sort_order: 20, is_active: true },
  { id: 3, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "referrer", label: "转介绍人", field_type: "TEXT", options: null, required: false, sort_order: 30, is_active: true },
  { id: 4, order_type_code: "CUSTOMER", is_custom: true, locked: false, field_key: "legacy_note", label: "历史备注", field_type: "TEXT", options: null, required: false, sort_order: 40, is_active: false },
] as unknown as import("@/shared/api/types/forms").OrderFormField[];

const customers = [
  { id: 1, customer_no: "CUS-0001", display_name: "张三", phone: "138****8888", wechat: "zhangsan", qq: "10001", status: "ACTIVE", extra_values: { credit_level: "优质", legacy_note: "早期客户" } },
  { id: 2, customer_no: "CUS-0002", display_name: "李四", phone: "139****9999", wechat: "", qq: "", status: "DISABLED", extra_values: {} },
];

beforeEach(() => {
  vi.clearAllMocks();
  seedOptionSets();
  vi.mocked(customersApi.list).mockResolvedValue(customers);
  vi.mocked(customersApi.page).mockImplementation(async (params) => {
    const items = await vi.mocked(customersApi.list)(params);
    return pageResponse(items, { limit: params?.limit ?? 10, offset: params?.offset ?? 0 });
  });
  vi.mocked(counterpartiesApi.list).mockResolvedValue([]);
  vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse([]));
  vi.mocked(orderFormFieldsApi.list).mockResolvedValue(fieldDefs);
  vi.mocked(customersApi.detail).mockResolvedValue({
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
    resolveMockOnce(vi.mocked(customersApi.create), { customer: { id: 3, customer_no: "CUS-0003" }, duplicate_candidates: [] });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("button", { name: /新建/ }));
    await ui.type(await screen.findByLabelText("名字"), "王五");
    await ui.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(vi.mocked(customersApi.create)).toHaveBeenCalled());
    expect(vi.mocked(customersApi.create).mock.calls[0][0]).toMatchObject({ display_name: "王五" });
  });

  it("重复候选不拦截，只提示（创建仍成功）", async () => {
    const warningSpy = vi.spyOn(message, "warning");
    resolveMockOnce(vi.mocked(customersApi.create), { customer: { id: 4 }, duplicate_candidates: [{ id: 2 }] });
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await ui.click(screen.getByRole("button", { name: /新建/ }));
    await ui.type(await screen.findByLabelText("名字"), "李四");
    await ui.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(vi.mocked(customersApi.create)).toHaveBeenCalled());
    // 只提示：message.warning 携带「重复候选」文案（renderLight 未用 antd <App>，静态 message 不进 React 树，故不查 DOM 文本）
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("重复候选"));
    // 未拦截：创建成功后走成功分支刷新列表（客户分页接口第 2 次调用）
    await waitFor(() => expect(vi.mocked(customersApi.page)).toHaveBeenCalledTimes(2));
  });

  it("合并弹窗取消后重开不残留上次选的目标客户与原因", async () => {
    // 两个 ACTIVE 客户互为可合并目标；用本地覆盖避免污染其它用例的共享 mock。
    vi.mocked(customersApi.list).mockResolvedValue([
      { id: 1, customer_no: "CUS-0001", display_name: "张三", phone: "138****8888", status: "ACTIVE", extra_values: {} },
      { id: 2, customer_no: "CUS-0002", display_name: "李四", phone: "139****9999", status: "ACTIVE", extra_values: {} },
    ]);
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");

    // 打开「张三」的合并弹窗（第一个可用合并按钮），选「李四」为目标并填原因。
    const mergeButtons = screen.getAllByRole("button", { name: /合\s*并/ });
    await ui.click(mergeButtons[0]);
    const dialog = await screen.findByRole("dialog");
    await ui.click(within(dialog).getByLabelText("目标客户（需为有效客户）").closest(".ant-form-item")!.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("CUS-0002 李四", { selector: ".ant-select-item-option-content" }));
    await ui.type(within(dialog).getByLabelText("合并原因"), "重复建档，保留李四");

    // 取消（Esc / X / 遮罩均走 onCancel=cancelMerge）。jsdom motion-stub 下关闭动画不收尾、
    // DOM 节点不移除，故不在这一断言「弹窗消失」（那由 E2E 守护），只验证重开后表单已清空。
    await ui.click(dialog.querySelector(".ant-modal-close") as Element);

    // 再次打开「张三」合并弹窗：目标客户与原因必须为空（#13）。
    await ui.click(screen.getAllByRole("button", { name: /合\s*并/ })[0]);
    await waitFor(() => {
      const dialogs = document.querySelectorAll<HTMLElement>(".ant-modal-content");
      const reopened = Array.from(dialogs).find((el) => el.textContent?.includes("合并客户 · CUS-0001"));
      expect(reopened).toBeTruthy();
      // 原因被清空
      expect(within(reopened!).getByLabelText("合并原因")).toHaveValue("");
      // 目标客户下拉无已选项（selection-item 不存在）
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
  });

  it("客户列表支持关键词搜索并把条件传给后端", async () => {
    renderLight(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    // 输入框与 enterButton 图标按钮均可访问名同为「搜索客户」（F4 无障碍整改），
    // Input.Search 的 input 是 type=search → role 为 searchbox，用它精确命中输入框避免双命中。
    const searchbox = screen.getByRole("searchbox", { name: "搜索客户" });
    await ui.type(searchbox, "张三");
    await ui.click(screen.getByRole("button", { name: "搜索客户" }));
    // 用 toHaveBeenCalledWith 而非 toHaveBeenLastCalledWith：搜索后页面可能再触发一次刷新调用，
    // 断言「关键词确实传给了后端」才是本用例的意图，避免与刷新调用竞争导致偶发红。
    await waitFor(() => expect(vi.mocked(customersApi.page)).toHaveBeenCalledWith({ keyword: "张三", limit: 10, offset: 0 }));
  });

  it("客户 CSV 导出完成后给出成功反馈", async () => {
    const successSpy = vi.spyOn(message, "success");
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

