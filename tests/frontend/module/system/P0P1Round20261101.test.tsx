import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { renderApp } from "@fixtures/render";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "@/app/AppShell";
import * as catalog from "@/shared/api/catalog";
import { CreateBusinessModal } from "@/orders/CreateBusinessModal";
import { OrdersPage } from "@/orders/OrdersPage";
import { InstallmentsPanel } from "@/installments/InstallmentsPanel";
import { UsersPanel } from "@/users/UsersPanel";

/** 选中主资金账户。附加费用区的中介费账户与主资金账户同名同占位（均为「资金账户」），
 *  故排除附加费用区定位；antd Select 在 jsdom 中用 mouseDown 展开，避免命中残留的隐藏下拉。 */
async function pickMainPool(user: ReturnType<typeof userEvent.setup>) {
  const selector = screen
    .getAllByText("请选择资金账户", { exact: true })
    .find((el) => !el.closest(".additional-fee-fields"))!
    .closest(".ant-select")!
    .querySelector(".ant-select-selector") as Element;
  await user.click(selector);
  await user.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
}
import { TeamsPanel } from "@/users/TeamsPanel";
import { UserCenterPage } from "@/auth/UserCenterPage";
import * as client from "@/shared/api/client";
import { ACCESS_TOKEN_KEY } from "@/shared/api/client";
import { ReportsPage } from "@/reporting/ReportsPage";
import { FundsPage } from "@/pools/FundsPage";
import { RebatesPanel } from "@/rebates/RebatesPanel";
import { CustomerPanel } from "@/customers/CustomerPanel";
import { CounterpartyPanel } from "@/customers/CounterpartyPanel";
import { InventoryPanel } from "@/stocks/InventoryPanel";
import { InventoryProfileModal } from "@/stocks/InventoryProfileModal";
import { InventoryConsignmentModal } from "@/stocks/InventoryConsignmentModal";
import { OrderTypesPanel } from "@/field-definitions/panels/OrderTypesPanel";
import { PoolsPanel } from "@/field-definitions/panels/PoolsPanel";
import { OrderTypeRoutesPanel } from "@/field-definitions/panels/OrderTypeRoutesPanel";
import { OrderDetail } from "@/stocks/OrderDetail";
import { OrderDetailDeliverySection } from "@/stocks/OrderDetailDeliverySection";
import { InventorySaleModal } from "@/stocks/InventorySaleModal";
import { buildInventoryCsv } from "@/stocks/inventory-export";
import { AuditPanel } from "@/audit/AuditPanel";
import { clearOptionSetsCache, loadOptionSets } from "@/shared/lib/optionSets";
import { seedOrderFormFields } from "@fixtures/formFieldsSeed";
import { appMessage } from "@/shared/ui/appFeedback";
import { buildActionAllocationCandidates, buildActionAllocationRows } from "@/orders/orderpage/helpers";
import { consignmentRecords } from "@/stocks/InventoryPlatformOffsaleModal";

vi.mock("@/shared/api/catalog");

const types = [{ id: 1, code: "TH", name: "提号", is_active: true }];
const settledInstallment = {
  id: 1,
  inst_no: "TH0002-FQ",
  contract_type: "STOCK_SALE",
  order_id: 10,
  down_payment: "100.00",
  principal: "300.00",
  service_fee: "0.00",
  per_period_service_fee: "0.00",
  per_period: "50.00",
  periods: 4,
  paid_amount: "300.00",
  total_receivable: "300.00",
  remaining_receivable: "0.00",
  status: "SETTLED",
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  clearOptionSetsCache();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(types);
  vi.mocked(catalog.customersApi.list).mockResolvedValue([]);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.stocksApi.inventoryStats).mockResolvedValue({ account_count: 1, occupied_cost: "100.00", over_7d_count: 0, over_30d_count: 0 });
  vi.mocked(catalog.rebatesApi.list).mockResolvedValue([] as never);
  vi.mocked(catalog.depositsApi.list).mockResolvedValue([] as never);
  vi.mocked(catalog.reconciliationsApi.list).mockResolvedValue([] as never);
  vi.mocked(catalog.cashflowsApi.list).mockResolvedValue({ items: [], total: 0 } as never);
  vi.mocked(catalog.reportsApi.exportCsv).mockResolvedValue(new Blob(["csv"]) as never);
  vi.mocked(catalog.gameTypesApi.list).mockResolvedValue([
    { id: 1, name: "王者荣耀", sort_order: 10, is_active: true, is_default: true },
  ]);
  vi.mocked(catalog.optionSetsApi.list).mockResolvedValue({
    items: [{
      code: "SUPPLIER_SOURCE",
      options: [
        { value: "自营", label: "自营" },
        { value: "其他", label: "其他" },
      ],
    }],
  } as never);
  vi.mocked(catalog.installmentsApi.list).mockResolvedValue([settledInstallment]);
  vi.mocked(catalog.installmentsApi.schedules).mockResolvedValue([
    { id: 1, installment_id: 1, period_no: 0, due_on: "2026-10-01", due_amount: "100.00", received_amount: "100.00", status: "PAID" },
  ]);
  vi.mocked(catalog.installmentsApi.dispositions).mockResolvedValue([]);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([
    { id: 10, order_no: "TH-2026-0002", order_type: "TH", trade_date: "2026-10-01", status: "ACTIVE" },
  ]);
  vi.mocked(catalog.reportsApi.inventoryHealth).mockResolvedValue({ generated_on: "2026-10-01", total_cost: "0.00", items: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  clearOptionSetsCache();
});

it("FE-123：提号供货方来源默认值必须来自当前主数据选项", async () => {
  await loadOptionSets();
  renderLight(
    <CreateBusinessModal
      open
      onClose={() => undefined}
      onCreated={() => undefined}
      initialOrderType="TH"
    />,
    { user: "admin" },
  );

  const field = await screen.findByLabelText("供货方来源");
  await waitFor(() => expect(catalog.optionSetsApi.list).toHaveBeenCalled());
  await waitFor(() => {
    expect(field.closest(".ant-select")?.querySelector(".ant-select-selection-item")).toHaveTextContent("自营");
  });
});

it("P0/FE-074：已结清合约禁止登记收款和终止退款", async () => {
  renderLight(<InstallmentsPanel />, { user: "admin" });
  await screen.findByText("TH0002-FQ");
  expect(screen.getByRole("button", { name: /登记收款/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /终止分期并退款/ })).toBeDisabled();
});

it("P1/FE-054：详情和库存 CSV 不得暴露账号密码", () => {
  const account = {
    id: 11,
    game_account: "safe-account",
    game_password: "secret-password",
    game_type: "原神",
    inventory_type: "RECOVERY",
    status: "WAITING",
  } as never;
  renderLight(<OrderDetail row={account} detail={{ orders: [] } as never} loading={false} />, { user: "admin" });

  expect(screen.queryByText("secret-password")).not.toBeInTheDocument();
  expect(screen.getByText("已隐藏")).toBeInTheDocument();
  const csv = buildInventoryCsv([account]);
  expect(csv).not.toContain("账号密码");
  expect(csv).not.toContain("secret-password");
});

it("P1/FE-090：开发态当前角色不在服务端人员列表时有明确说明", async () => {
  vi.mocked(catalog.usersApi.list).mockResolvedValueOnce([
    { id: 7, username: "operator01", display_name: "业务同事", role: "OPERATOR", owner_scope: "SELF", team_ids: [], pool_ids: [], is_active: true },
  ] as never);
  vi.mocked(catalog.teamsApi.list).mockResolvedValueOnce([] as never);
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([] as never);

  renderLight(<UsersPanel />, { user: "admin" });

  expect(await screen.findByText("operator01")).toBeInTheDocument();
  expect(screen.getByText(/开发态当前角色：admin/)).toBeInTheDocument();
  expect(screen.getByText(/开发态角色不纳入服务端人员列表/)).toBeInTheDocument();
});

it("P1/FE-046：错误旧密码停留在用户中心并恢复可重试状态", async () => {
  vi.spyOn(client, "changePassword").mockRejectedValueOnce(new Error("原密码错误"));
  renderLight(<UserCenterPage />, { user: "admin" });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.type(screen.getByLabelText("当前密码"), "wrong-old-pass");
  await user.type(screen.getByLabelText("新密码"), "new-pass-12345");
  await user.type(screen.getByLabelText("确认新密码"), "new-pass-12345");
  await user.click(screen.getByRole("button", { name: /修改密码/ }));

  expect(await screen.findByText(/原密码错误/)).toBeInTheDocument();
  expect(screen.getByLabelText("当前密码")).toHaveValue("wrong-old-pass");
  expect(screen.getByRole("button", { name: /修改密码/ })).toBeEnabled();
  expect(screen.queryByText("登录工作台")).not.toBeInTheDocument();
});

it("P1/FE-042：已拉黑客户不能参与库存售出", async () => {
  vi.mocked(catalog.customersApi.list).mockResolvedValueOnce([
    { id: 7, display_name: "买家A", status: "DISABLED" },
  ] as never);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue([
    { id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" },
  ] as never);
  vi.mocked(catalog.employeesApi.list).mockResolvedValueOnce([
    { id: 1, username: "admin", display_name: "管理员", is_active: true },
  ] as never);
  renderLight(
    <InventorySaleModal
      account={{ id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", game_account: "acc-1", status: "WAITING", inventory_type: "RECOVERY" } as never}
      onClose={() => undefined}
      onCreated={() => undefined}
    />,
    { user: "admin" },
  );
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await screen.findByText("买家信息");
  await user.type(screen.getByLabelText("客户昵称"), "买家A");
  await user.type(screen.getByLabelText("售出金额"), "350");
  await user.click(screen.getByLabelText("资金账户"));
  await user.click(await screen.findByText(/利润池（HJ_PROFIT）/));
  await user.click(screen.getByRole("button", { name: /确认售出/ }));

  await waitFor(() => expect(screen.getByText(/客户已拉黑，不能作为售出买家/)).toBeInTheDocument());
  expect(catalog.ordersApi.addCustomerRole).not.toHaveBeenCalled();
  expect(catalog.ordersApi.postEvent).not.toHaveBeenCalled();
});

it("P1/FE-047：重复团队编码前端拦截并保留表单", async () => {
  const errorSpy = vi.spyOn(appMessage, "error").mockImplementation(() => ({} as never));
  vi.mocked(catalog.teamsApi.list).mockResolvedValueOnce([
    { id: 1, code: "T01", name: "核心团队", description: "主营", is_active: true },
  ] as never);
  renderLight(<TeamsPanel />, { user: "admin" });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await screen.findByText("T01");
  await user.type(screen.getByPlaceholderText("团队编码"), " t01 ");
  await user.type(screen.getByPlaceholderText("团队名称"), "重复团队");
  await user.click(screen.getByRole("button", { name: /新增团队/ }));

  await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("团队编码已存在"));
  expect(screen.getByPlaceholderText("团队编码")).toHaveValue(" t01 ");
  expect(catalog.teamsApi.create).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

it("P1/FE-217：团队数据失败时显示错误空态且禁用新增", async () => {
  vi.mocked(catalog.teamsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "teams down" });
  renderLight(<TeamsPanel />, { user: "admin" });

  expect(await screen.findByText("团队数据不可用，请点击重新加载")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /新增团队/ })).toBeDisabled();
});

it("P1/FE-049：超出转出资金池可用余额时不发起划转", async () => {
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([
    { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
    { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", ownership: "SELF", status: "ACTIVE" },
  ] as never);
  vi.mocked(catalog.poolsApi.balances).mockResolvedValue({ items: [{ pool_id: 1, pool_code: "POOL-A", income: "1000.00", expense: "200.00", transfer_in: "0.00", transfer_out: "0.00", cash_balance: "800.00", deposit_held: "100.00", available: "700.00" }, { pool_id: 2, pool_code: "POOL-B", income: "1000.00", expense: "200.00", transfer_in: "0.00", transfer_out: "0.00", cash_balance: "800.00", deposit_held: "100.00", available: "700.00" }], totals: { cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00", owned_cash_balance: "1600.00" } } as never);
  vi.mocked(catalog.depositsApi.list).mockResolvedValueOnce([] as never);
  vi.mocked(catalog.cashflowsApi.list).mockResolvedValueOnce({ items: [], total: 0 } as never);
  vi.mocked(catalog.reconciliationsApi.list).mockResolvedValueOnce([] as never);
  vi.mocked(catalog.rebatesApi.list).mockResolvedValueOnce([] as never);
  renderLight(<FundsPage />, { user: "admin" });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await screen.findByText(/POOL-A/);
  await user.click(await screen.findByRole("button", { name: /资金池划转/ }));
  const modal = document.querySelector(".ant-modal-content") as HTMLElement;
  const selectors = modal.querySelectorAll(".ant-select-selector");
  const choosePool = async (index: number, title: RegExp) => {
    await user.click(selectors[index]);
    const dropdowns = document.querySelectorAll(".ant-select-dropdown");
    const currentDropdown = dropdowns[dropdowns.length - 1] as HTMLElement;
    await user.click(await within(currentDropdown).findByTitle(title));
  };
  await choosePool(0, /经营主池/);
  await choosePool(1, /押金池/);
  await user.type(modal.querySelector("#amount") ?? modal, "700.01");
  await user.click(screen.getByRole("button", { name: /确认划转/ }));

  await waitFor(() => expect(screen.getByText(/可用余额不足/)).toBeInTheDocument());
  expect(catalog.transfersApi.create).not.toHaveBeenCalled();
});

it("P1/FE-050：流水冲销成功后原流水不再显示重复冲销入口", async () => {
  const original = { id: 7, flow_no: "CF-A-07", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "300.00", source: "MANUAL", accounting_attribute: "SELF_DIRECT_COST", status: "APPROVED" };
  const reversal = { ...original, id: 8, flow_no: "CF-REV-08", category: "REVERSAL", direction: "IN", accounting_attribute: "REVERSAL", reversal_of_id: 7 };
  let mainListCalls = 0;
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([
    { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
  ] as never);
  vi.mocked(catalog.poolsApi.balances).mockResolvedValue({ items: [{ pool_id: 1, pool_code: "POOL-A", income: "1000.00", expense: "200.00", transfer_in: "0.00", transfer_out: "0.00", cash_balance: "800.00", deposit_held: "100.00", available: "700.00" }, { pool_id: 2, pool_code: "POOL-B", income: "1000.00", expense: "200.00", transfer_in: "0.00", transfer_out: "0.00", cash_balance: "800.00", deposit_held: "100.00", available: "700.00" }], totals: { cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00", owned_cash_balance: "1600.00" } } as never);
  vi.mocked(catalog.cashflowsApi.list).mockImplementation(async (params) => {
    if (params?.direction) return { items: [], total: 0 } as never;
    mainListCalls += 1;
    return (mainListCalls === 1 ? { items: [original], total: 1 } : { items: [original, reversal], total: 2 }) as never;
  });
  vi.mocked(catalog.cashflowsApi.reverse).mockResolvedValueOnce(reversal as never);
  vi.mocked(catalog.depositsApi.list).mockResolvedValue([] as never);
  vi.mocked(catalog.reconciliationsApi.list).mockResolvedValue([] as never);
  vi.mocked(catalog.rebatesApi.list).mockResolvedValue([] as never);
  renderLight(<FundsPage />, { user: "admin" });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await screen.findByText(/POOL-A/);
  await user.click(screen.getByRole("tab", { name: "流水" }));
  await screen.findByText("CF-A-07");
  await user.click(screen.getByRole("button", { name: /冲销/ }));
  const modal = document.querySelector(".ant-modal-content") as HTMLElement;
  await user.type(modal.querySelector("#reversed_on") ?? modal, "2026-10-18");
  await user.type(modal.querySelector("#reason") ?? modal, "重复入账");
  await user.click(screen.getByRole("button", { name: /确认冲销/ }));

  await waitFor(() => expect(catalog.cashflowsApi.reverse).toHaveBeenCalledWith(7, expect.objectContaining({ reason: "重复入账" })));
  await waitFor(() => expect(screen.queryByRole("button", { name: /^冲销$/ })).toBeNull());
  expect(screen.getByText("CF-REV-08")).toBeInTheDocument();
});

it("P1/FE-051：经营报表日期筛选传递到各报表查询", async () => {
  vi.mocked(catalog.reportsApi.monthlyPnl).mockResolvedValue({ items: [], total: {} } as never);
  vi.mocked(catalog.reportsApi.commission).mockResolvedValue({ items: [], total: { order_count: 0, payable: "0", paid: "0", difference: "0" } } as never);
  vi.mocked(catalog.reportsApi.dailyFunds).mockResolvedValue({ date: "2026-11-01", total: {}, items: [] } as never);
  vi.mocked(catalog.reportsApi.businessPnl).mockResolvedValue({ items: [], total: {} } as never);
  vi.mocked(catalog.reportsApi.orderProfit).mockResolvedValue({ items: [], total: { income: "0", direct_cost: "0", rebate: "0", net_profit: "0" } } as never);
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<ReportsPage />, { user: "admin" });

  const setRangeOnCurrentTab = async (tab: RegExp) => {
    await user.click(await screen.findByRole("tab", { name: tab }));
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const dateInputs = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    fireEvent.change(dateInputs[0], { target: { value: "2026-10-01" } });
  };

  await setRangeOnCurrentTab(/月度损益 R2/);
  await waitFor(() => expect(catalog.reportsApi.monthlyPnl).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
  await user.click(screen.getByRole("tab", { name: /提成对账 R3/ }));
  await waitFor(() => expect(catalog.reportsApi.commission).toHaveBeenLastCalledWith({ from: "2026-10-01", all_people: true }));
  await user.click(screen.getByRole("tab", { name: /业务损益 R5/ }));
  await waitFor(() => expect(catalog.reportsApi.businessPnl).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
  await user.click(screen.getByRole("tab", { name: /订单利润/ }));
  await waitFor(() => expect(catalog.reportsApi.orderProfit).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
  await user.click(screen.getByRole("tab", { name: /资金报表·日报/ }));
  const dailyDate = screen.getByLabelText("资金日报日期");
  fireEvent.change(dailyDate, { target: { value: "2026-10-01" } });
  await waitFor(() => expect(catalog.reportsApi.dailyFunds).toHaveBeenLastCalledWith({ on: "2026-10-01" }));
});

it("P1/FE-053：报表导出成功后显示可核对的结果反馈", async () => {
  vi.mocked(catalog.reportsApi.exportCsv).mockResolvedValue(new Blob(["csv"]) as never);
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report");
  const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<ReportsPage />, { user: "admin" });
  const selector = screen.getByText("选择导出报表").closest(".ant-select")!.querySelector(".ant-select-selector") as HTMLElement;
  await user.click(selector);
  await user.click(await screen.findByText("订单利润", { selector: ".ant-select-item-option-content" }));
  await user.click(screen.getByRole("button", { name: /导出/ }));

  await waitFor(() => expect(screen.getByText(/已导出 1 份报表/)).toBeInTheDocument());
  expect(anchorClick).toHaveBeenCalled();
  expect(createUrl).toHaveBeenCalled();
  expect(revokeUrl).toHaveBeenCalledWith("blob:report");
});

it("P1/FE-169：订单利润展示采购成本并给出可复算口径", async () => {
  vi.mocked(catalog.reportsApi.orderProfit).mockResolvedValueOnce({
    items: [{
      order_id: 11,
      order_no: "HS-2026-0011",
      order_type: "HS",
      trade_date: "2026-11-01",
      status: "COMPLETED",
      income: "600.00",
      buy_amount: "400.00",
      direct_cost: "50.00",
      rebate: "10.00",
      net_profit: "160.00",
    }],
    total: { income: "600.00", buy_amount: "400.00", direct_cost: "50.00", rebate: "10.00", net_profit: "160.00" },
  } as never);
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<ReportsPage />, { user: "admin" });
  await user.click(await screen.findByRole("tab", { name: /订单利润/ }));

  expect(await screen.findByText("HS-2026-0011")).toBeInTheDocument();
  expect(screen.getAllByText("账号采购成本").length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText(/订单利润 = 所有收入 − 所有支出/)).toBeInTheDocument();
  expect(screen.getAllByText("400.00").length).toBeGreaterThanOrEqual(1);
});

it("P1/FE-194：客户 CSV 导出完成后给出成功反馈", async () => {
  vi.mocked(catalog.customersApi.list).mockResolvedValueOnce([
    { id: 1, customer_no: "CUS-0001", display_name: "测试客户", status: "ACTIVE" },
  ] as never);
  vi.mocked(catalog.customersApi.exportCsv).mockResolvedValueOnce(new Blob(["csv"]) as never);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:customer");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  const successSpy = vi.spyOn(appMessage, "success").mockImplementation(() => ({} as never));
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<CustomerPanel />, { user: "admin" });

  await screen.findByText("CUS-0001");
  await user.click(screen.getByRole("button", { name: "导出客户CSV" }));
  await waitFor(() => expect(successSpy).toHaveBeenCalledWith("客户 CSV 已导出"));
});

it("P1/FE-196：库存 CSV 导出完成后给出成功反馈", async () => {
  vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([
    { id: 1, source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "安卓", status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00" },
  ] as never);
  vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValueOnce({ account: { id: 1 }, orders: [] } as never);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:inventory");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  const successSpy = vi.spyOn(appMessage, "success").mockImplementation(() => ({} as never));
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<InventoryPanel />, { user: "admin" });

  await screen.findByText("acc-1");
  await user.click(screen.getByRole("button", { name: /导出/ }));
  await waitFor(() => expect(successSpy).toHaveBeenCalledWith("库存 CSV 已导出"));
});

it("P1/FE-023：库存中的未售出重复账号直接阻止建单并保留表单", async () => {
  // 判重已后移到后端：前端不自带比对，只呈现后端返回的错误码。
  vi.mocked(catalog.ordersApi.create).mockRejectedValueOnce({
    isAxiosError: true,
    response: {
      data: {
        code: "INVENTORY_ACCOUNT_IN_STOCK",
        message: "已有未售出库存账号「duplicate-account」，请先售出后再建单",
      },
    },
    message: "Request failed",
  });
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([
    { id: 1, name: "主账户", code: "MAIN", status: "ACTIVE" },
  ] as never);
  vi.mocked(catalog.counterpartiesApi.create).mockResolvedValueOnce({
    id: 2,
    display_name: "同行甲",
    type: "PEER",
    status: "ACTIVE",
  } as never);
  renderLight(
    <CreateBusinessModal
      open
      onClose={() => undefined}
      onCreated={() => undefined}
      initialOrderType="TH"
    />,
    { user: "admin" },
  );

  await screen.findByLabelText("供货方昵称");
  await screen.findByLabelText("游戏账号");
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.type(screen.getByLabelText("供货方昵称"), "同行甲");
  await user.type(screen.getByLabelText("游戏类型"), "王者荣耀");
  await user.type(screen.getByLabelText("游戏账号"), "duplicate-account");
  await user.type(screen.getByLabelText("账号密码"), "secret");
  await user.type(screen.getByLabelText("渠道／区服"), "安卓一区");
  const amounts = screen.getAllByPlaceholderText("请输入金额");
  await user.type(amounts[0], "1000");
  await user.type(amounts[1], "1200");
  await pickMainPool(user);
  await user.click(screen.getByRole("button", { name: /创建订单/ }));

  await waitFor(() => expect(screen.getByText(/请先售出后再建单/)).toBeInTheDocument());
  expect(screen.getByLabelText("游戏账号")).toHaveValue("duplicate-account");
  // 未售出属硬阻止：只出页面级错误提示，不应弹复购确认框（ConfirmDialog）。
  expect(screen.queryByText("检测到重复游戏账号")).not.toBeInTheDocument();
  // 请求已发出，由后端拒绝；前端不再拉库存台账自行判重。
  expect(catalog.ordersApi.create).toHaveBeenCalledWith(
    expect.objectContaining({ confirm_repurchase: false }),
  );
});

it("P1/FE-023：已售出重复账号确认复购后允许回流建单", async () => {
  vi.mocked(catalog.ordersApi.create)
    .mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        data: {
          code: "REPURCHASE_CONFIRM_REQUIRED",
          message: "历史库存账号「duplicate-account」已售出，请确认是否为复购回流订单",
        },
      },
      message: "Request failed",
    })
    .mockResolvedValueOnce({ id: 1 } as never);
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([
    { id: 1, name: "主账户", code: "MAIN", status: "ACTIVE" },
  ] as never);
  // 两次提交各自都会走一遍 TH 的「供货方→合作方」补齐（合作方列表里还没有它），
  // 故 once 队列要备两份，否则第二次提交会在建单请求之前就因取不到 id 抛错。
  const peer = { id: 2, display_name: "同行甲", type: "PEER", status: "ACTIVE" } as never;
  vi.mocked(catalog.counterpartiesApi.create)
    .mockResolvedValueOnce(peer)
    .mockResolvedValueOnce(peer);
  renderLight(
    <CreateBusinessModal
      open
      onClose={() => undefined}
      onCreated={() => undefined}
      initialOrderType="TH"
    />,
    { user: "admin" },
  );

  await screen.findByLabelText("供货方昵称");
  await screen.findByLabelText("游戏账号");
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.type(screen.getByLabelText("供货方昵称"), "同行甲");
  await user.type(screen.getByLabelText("游戏类型"), "王者荣耀");
  await user.type(screen.getByLabelText("游戏账号"), "duplicate-account");
  await user.type(screen.getByLabelText("账号密码"), "secret");
  await user.type(screen.getByLabelText("渠道／区服"), "安卓一区");
  const amounts = screen.getAllByPlaceholderText("请输入金额");
  await user.type(amounts[0], "1000");
  await user.type(amounts[1], "1200");
  await pickMainPool(user);
  await user.click(screen.getByRole("button", { name: /创建订单/ }));

  // 复购确认现为受控 ConfirmDialog（Modal 级）：等确认框出现 → 未确认前不建单 → 点「是，继续建单」。
  expect(await screen.findByText("检测到重复游戏账号")).toBeInTheDocument();
  expect(catalog.ordersApi.create).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "是，继续建单" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "否，返回修改" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "是，继续建单" }));
  await waitFor(() => expect(catalog.ordersApi.create).toHaveBeenCalledTimes(2));
  expect(catalog.ordersApi.create).toHaveBeenLastCalledWith(
    expect.objectContaining({ confirm_repurchase: true }),
  );
});

it("P1/FE-035：分润按建单、卖出和运营信息负责人自动绑定", () => {
  const candidates = buildActionAllocationCandidates({
    form_extra: {
      business_responsible_ids: [11],
      delivery_responsible_ids: [22],
    },
    events: [
      { id: 1, event_no: "EV-1", order_id: 10, event_type: "BUY", amount: "100", occurred_on: "2026-10-01", is_posted: true, operator_user_ids: [], cancellable_amount: "100" },
      { id: 2, event_no: "EV-2", order_id: 10, event_type: "SELL", amount: "200", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [], cancellable_amount: "200" },
      { id: 3, event_no: "EV-3", order_id: 10, event_type: "COST", amount: "20", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [33], cancellable_amount: "20" },
    ],
  });
  const rows = buildActionAllocationRows([], candidates);

  expect(candidates).toMatchObject({ BUY: [11], SELL: [22], OPERATION: [33], COMPANY: [] });
  expect(rows.map((row) => row.employee)).toEqual([11, 22, 33, "COMPANY"]);
  expect(rows.map((row) => row.allocation_type)).toEqual(["BUY", "SELL", "OPERATION", "COMPANY"]);
});

it("P1/FE-224：库存健康接口失败时不把未知结果显示为 0，重试可恢复", async () => {
  vi.mocked(catalog.reportsApi.inventoryHealth).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
  renderLight(<ReportsPage />, { user: "admin" });
  await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  expect(screen.getAllByText("不可用")).toHaveLength(2);
  expect(screen.getByText("库存健康数据不可用，请点击重新加载")).toBeInTheDocument();
  expect(screen.queryByText("暂无在库账号")).not.toBeInTheDocument();
  vi.mocked(catalog.reportsApi.inventoryHealth).mockResolvedValueOnce({ generated_on: "2026-10-01", total_cost: "0.00", items: [] } as never);
  await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole("button", { name: /重新加载/ }));
  expect(await screen.findByText("暂无在库账号")).toBeInTheDocument();
});

it("P1/FE-238：业务类型主数据失败时锁定新建入口", async () => {
  vi.mocked(catalog.orderTypesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "types down" });
  renderLight(<OrderTypesPanel />, { user: "admin" });
  expect(await screen.findByText("业务类型数据不可用，请点击重新加载")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /新建类型/ })).toBeDisabled();
  expect(screen.getByText("业务类型数据不可用，请点击重新加载")).toBeInTheDocument();
});

it("P1/FE-211：配置主数据失败态独立回归", async () => {
  vi.mocked(catalog.orderTypesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "types down" });
  renderLight(<OrderTypesPanel />, { user: "admin" });
  expect(await screen.findByText("业务类型数据不可用，请点击重新加载")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /新建类型/ })).toBeDisabled();
});

it("P1/FE-239：资金池主数据失败时锁定新增入口", async () => {
  vi.mocked(catalog.poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "pools down" });
  renderLight(<PoolsPanel />, { user: "admin" });
  expect(await screen.findByText("资金池数据不可用，请点击重新加载")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /新增资金池/ })).toBeDisabled();
  expect(screen.getByText("资金池数据不可用，请点击重新加载")).toBeInTheDocument();
});

it("P1/FE-240：过账路由失败时显示不可用并锁定保存", async () => {
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValueOnce([
    { id: 1, code: "HS", name: "回收", is_active: true },
  ] as never);
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([
    { id: 1, code: "MAIN", name: "主账户", pool_type: "INVEST", ownership: "OWNED", status: "ACTIVE" },
  ] as never);
  vi.mocked(catalog.orderTypesApi.routes).mockRejectedValueOnce(new Error("routes down"));
  renderLight(<OrderTypeRoutesPanel />, { user: "admin" });
  expect((await screen.findAllByText("资金路由数据不可用，请点击重新加载")).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: /保存路由/ })).toBeDisabled();
  expect(screen.getByText(/业务类型覆盖不可用/)).toBeInTheDocument();
});

it("P1/FE-261：完整资金划转不进入单边异常修复列表", async () => {
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([
    { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
    { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", ownership: "SELF", status: "ACTIVE" },
  ] as never);
  vi.mocked(catalog.poolsApi.balances).mockResolvedValue({ items: [{ pool_id: 1, pool_code: "POOL-A", income: "1000.00", expense: "200.00", transfer_in: "0.00", transfer_out: "0.00", cash_balance: "800.00", deposit_held: "100.00", available: "700.00" }, { pool_id: 2, pool_code: "POOL-B", income: "1000.00", expense: "200.00", transfer_in: "0.00", transfer_out: "0.00", cash_balance: "800.00", deposit_held: "100.00", available: "700.00" }], totals: { cash_balance: "1600.00", available: "1400.00", deposit_held: "200.00", owned_cash_balance: "1600.00" } } as never);
  vi.mocked(catalog.cashflowsApi.list).mockResolvedValueOnce({
    items: [
      { id: 31, flow_no: "TRF-PAIRED-01-OUT", pool_id: 1, transfer_id: "TRF-PAIRED-01", direction: "OUT", amount: "100.00", occurred_on: "2026-11-01", category: "TRANSFER" },
      { id: 32, flow_no: "TRF-PAIRED-01-IN", pool_id: 2, transfer_id: "TRF-PAIRED-01", direction: "IN", amount: "100.00", occurred_on: "2026-11-01", category: "TRANSFER" },
    ],
    total: 2,
  } as never);
  renderLight(<FundsPage />, { user: "admin" });
  await screen.findByText(/POOL-A/);
  await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole("tab", { name: "异常" }));

  expect(await screen.findByText("暂无单边划转异常")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /修复划转/ })).not.toBeInTheDocument();
});

it("P1/FE-262：过账路由覆盖列表包含代挂 DG", async () => {
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValueOnce([
    { id: 1, code: "HS", name: "回收", is_active: true },
    { id: 2, code: "DG", name: "代挂", is_active: true },
  ] as never);
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([
    { id: 1, code: "MAIN", name: "主账户", pool_type: "INVEST", ownership: "OWNED", status: "ACTIVE" },
  ] as never);
  vi.mocked(catalog.orderTypesApi.routes).mockImplementation((id: number) => Promise.resolve([
    { id: id * 10, order_type_code: id === 2 ? "DG" : "HS", portion: "GROSS", pool_code: "MAIN", pool_name: "主账户", priority: 0, is_active: true },
  ] as never));
  renderLight(<OrderTypeRoutesPanel />, { user: "admin" });

  await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole("combobox", { name: "业务类型" }));
  expect(await screen.findByText("代挂（DG）", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
});

it("P1/FE-242：客户中心请求失败时不显示零统计且禁用依赖入口", async () => {
  vi.mocked(catalog.customersApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "customers down" });
  renderLight(<CustomerPanel />, { user: "admin" });

  expect(await screen.findByText("客户数据不可用，请点击重新加载")).toBeInTheDocument();
  expect(screen.getByText("客户总数").closest(".ui-stat")).toHaveTextContent("不可用");
  expect(screen.getByText("本月新增客户数").closest(".ui-stat")).toHaveTextContent("不可用");
  expect(screen.getByText("今日新增客户数").closest(".ui-stat")).toHaveTextContent("不可用");
  expect(screen.getByRole("button", { name: /新建客户/ })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "客户状态" })).toBeDisabled();
});

it("P1/FE-150/151：审计对象与动作下拉在字典失败时仍可用", async () => {
  vi.mocked(catalog.auditApi.list).mockResolvedValueOnce({ items: [], total: 0 });
  vi.mocked(catalog.auditApi.actions).mockRejectedValueOnce({ isAxiosError: true, message: "audit actions down" });
  renderLight(<AuditPanel />, { user: "admin" });
  await screen.findByText("暂无审计记录");
  const selects = document.querySelectorAll(".ui-filter-bar .ant-select");
  expect(selects.length).toBe(2);
  await userEvent.setup({ pointerEventsCheck: 0 }).click(selects[0].querySelector(".ant-select-selector") as Element);
  expect(await screen.findByText("订单", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  await userEvent.setup({ pointerEventsCheck: 0 }).click(selects[1].querySelector(".ant-select-selector") as Element);
  expect(await screen.findByText("新建资金池", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
});

it("P1/FE-244：资金总览数据失败时不显示零统计且禁用划转", async () => {
  vi.mocked(catalog.poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "pools down" });
  renderLight(<FundsPage />, { user: "admin" });

  expect(await screen.findByText("资金池卡片")).toBeInTheDocument();
  expect(screen.getByText("现金头寸合计").closest(".ui-stat")).toHaveTextContent("不可用");
  expect(screen.getByText("可用余额合计").closest(".ui-stat")).toHaveTextContent("不可用");
  expect(screen.getByRole("button", { name: /资金池划转/ })).toBeDisabled();
});

it("P1/FE-228：资金总览失败态划转保护独立回归", async () => {
  vi.mocked(catalog.poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "pools down" });
  renderLight(<FundsPage />, { user: "admin" });

  expect(await screen.findByText("资金池卡片")).toBeInTheDocument();
  expect(screen.getByText("现金头寸合计").closest(".ui-stat")).toHaveTextContent("不可用");
  expect(screen.getByRole("button", { name: /资金池划转/ })).toBeDisabled();
});

it("P1/FE-231：返点数据失败时不显示零统计且禁用新增", async () => {
  vi.mocked(catalog.rebatesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "rebates down" });
  renderLight(<RebatesPanel />, { user: "admin" });

  expect(await screen.findByText("返点明细")).toBeInTheDocument();
  expect(screen.getByText("返点记录数").closest(".ui-stat")).toHaveTextContent("不可用");
  expect(screen.getByRole("button", { name: /新增返点记录/ })).toBeDisabled();
});

it("P1/FE-229：资金流水数据失败时不显示零统计且禁用新增", async () => {
  vi.mocked(catalog.cashflowsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "cashflows down" });
  renderLight(<FundsPage />, { user: "admin" });

  fireEvent.click(screen.getByRole("tab", { name: "流水" }));
  expect(await screen.findByText("全局资金流水")).toBeInTheDocument();
  expect(screen.getByText("总收入").closest(".ui-stat")).toHaveTextContent("不可用");
  expect(screen.getByRole("button", { name: /新增流水/ })).toBeDisabled();
});

it("P1/FE-230：对账数据失败时显示明确空态且禁用新增", async () => {
  vi.mocked(catalog.reconciliationsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "reconciliations down" });
  renderLight(<FundsPage />, { user: "admin" });

  fireEvent.click(screen.getByRole("tab", { name: "对账" }));
  expect(await screen.findByText("资金对账")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /新增对账/ })).toBeDisabled();
  expect(screen.getByText("资金对账数据不可用，请点击重新加载")).toBeInTheDocument();
});

it("P1/FE-253：订单台账加载未完成时不显示零统计", async () => {
  vi.mocked(catalog.ordersApi.list).mockImplementation(() => new Promise(() => undefined));
  renderLight(<OrdersPage initialTab="ledger" />, { user: "admin" });
  const ledger = await screen.findByRole("tabpanel", { name: "订单台账" });
  const card = screen.getByText("订单总量").closest(".ui-stat") as HTMLElement;
  expect(card).toHaveTextContent("—");
  expect(card).not.toHaveTextContent("0");
  expect(ledger).toBeInTheDocument();
});

it("P1/FE-252：取消依赖的资金账户加载完成后才允许确认", async () => {
  const order = {
    id: 21,
    order_no: "HS-CANCEL-ASYNC-01",
    order_type: "HS",
    capital_type: "SELF",
    trade_date: "2026-11-01",
    status: "ACTIVE",
    account_status: "WAITING",
  };
  let resolvePools!: (value: unknown[]) => void;
  const poolsPending = new Promise<unknown[]>((resolve) => { resolvePools = resolve; });
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([order] as never);
  vi.mocked(catalog.ordersApi.get).mockResolvedValue({
    ...order,
    events: [{ id: 2101, event_type: "BUY", event_no: "EV-CANCEL-ASYNC-01", amount: "100.00", pool_id: 7, is_posted: true, cancellable_amount: "100.00" }],
  } as never);
  vi.mocked(catalog.poolsApi.list).mockImplementation(() => poolsPending as never);
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.ordersApi.postEvent).mockResolvedValue({
    event: { id: 2102, event_type: "CANCEL", amount: "100.00", cancellable_amount: "0.00" },
  } as never);

  renderLight(<OrdersPage initialTab="ledger" />, { user: "admin" });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const row = (await screen.findAllByText("HS-CANCEL-ASYNC-01"))[0].closest("tr") as HTMLElement;
  // 台账操作列已由「更多」折叠菜单改为行内独立按钮：编辑 / 分润 / 资金收支 / 取消
  fireEvent.click(within(row).getByRole("button", { name: "取消" }));

  expect(screen.queryByText(/取消 · HS-CANCEL-ASYNC-01/)).not.toBeInTheDocument();

  resolvePools([{ id: 7, code: "HJ_INVEST", name: "投资款荷包", status: "ACTIVE" }]);
  const modal = await screen.findByText(/取消 · HS-CANCEL-ASYNC-01/);
  const modalContent = modal.closest(".ant-modal-content") as HTMLElement;
  await user.type(within(modalContent).getByLabelText("取消原因"), "异步加载回归");
  await user.click(within(modalContent).getByRole("button", { name: /确认取消/ }));
  await waitFor(() => expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(
    21,
    expect.objectContaining({ event_type: "CANCEL", offset_event_id: 2101, pool_id: 7 }),
  ));
});

it("P1/FE-255：人员主数据失败时锁定新增用户入口", async () => {
  vi.mocked(catalog.usersApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "users unavailable" });
  vi.mocked(catalog.teamsApi.list).mockResolvedValueOnce([] as never);
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([] as never);
  renderLight(<UsersPanel />, { user: "admin" });

  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByText("用户数据不可用，请点击重新加载")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /新增用户/ })).toBeDisabled();
});

it("P1/FE-254：库存健康报表纳入在库提号账号", async () => {
  vi.mocked(catalog.reportsApi.inventoryHealth).mockResolvedValueOnce({
    generated_on: "2026-10-01",
    total_cost: "500.00",
    items: [{
      account_id: 8,
      game_account: "pickup-in-stock-regression",
      platform: "盼之",
      status: "IN_STOCK",
      buy_amount: "500.00",
      extra_cost: "0.00",
      total_cost: "500.00",
      holding_days: 2,
    }],
  } as never);
  renderLight(<ReportsPage />, { user: "admin" });

  expect(await screen.findByText("pickup-in-stock-regression")).toBeInTheDocument();
  expect(screen.getByText("在库账号").parentElement).toHaveTextContent("1");
  expect(screen.getAllByText("500.00").length).toBeGreaterThanOrEqual(1);
});

it("P1/FE-256：系统下架审计轨迹在账号详情中可见", () => {
  renderLight(
    <OrderDetail
      row={{ id: 88, game_account: "dg-audit-account", status: "VOID", inventory_type: "CONSIGNMENT", cost_amount: "0.00" } as never}
      detail={{
        orders: [],
        audit: [{
          id: 901,
          action: "ORDER_CANCEL",
          entity_type: "order",
          entity_id: "DG-88",
          actor: "admin",
          reason: "系统下架同步取消寄售平台上架",
          occurred_at: "2026-11-02T10:20:00",
        }],
      } as never}
      loading={false}
    />,
    { user: "admin" },
  );

  expect(screen.getByText("操作追溯")).toBeInTheDocument();
  expect(screen.getByText("系统下架同步取消寄售平台上架")).toBeInTheDocument();
});

it("P1/FE-257：台账库存状态列只展示库存状态，订单状态独立成列不重复展示", async () => {
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([{
    id: 31,
    order_no: "HS-INSTALLMENT-SETTLED-REGRESSION",
    order_type: "HS",
    capital_type: "SELF",
    trade_date: "2026-10-01",
    status: "INSTALLMENT",
    installment_status: "SETTLED",
    account_status: "WAITING",
  }] as never);
  renderLight(<OrdersPage initialTab="ledger" />, { user: "admin" });

  const row = (await screen.findAllByText("HS-INSTALLMENT-SETTLED-REGRESSION"))[0].closest("tr") as HTMLElement;
  // 库存状态列只反映账号/库存状态，不被订单状态覆盖
  expect(within(row).getByText("在库")).toBeInTheDocument();
  // 订单状态独立成列（INSTALLMENT → 分期中）：允许出现，但全行只出现一次，不与库存状态列重复
  expect(within(row).getAllByText("分期中")).toHaveLength(1);
  // 合约状态不再重复出现在台账行内
  expect(within(row).queryByText("合约：已结清")).toBeNull();
});

it("P1/FE-263：寄售上架只创建寄售动作，不重复创建库存", async () => {
  vi.mocked(catalog.optionSetsApi.list).mockResolvedValueOnce({
    items: [{ code: "INTERMEDIARY_PLATFORM", options: [{ value: "盼之", label: "盼之" }] }],
  } as never);
  vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValueOnce({ account: { id: 88, game_account: "consignment-regression", status: "WAITING" }, orders: [] } as never);
  vi.mocked(catalog.ordersApi.create).mockResolvedValueOnce({ id: 901 } as never);
  renderLight(
    <InventoryConsignmentModal
      account={{ id: 88, game_account: "consignment-regression", status: "WAITING", inventory_type: "CONSIGNMENT" } as never}
      onClose={() => undefined}
      onCreated={() => undefined}
    />,
    { user: "admin" },
  );
  await screen.findByText("登记寄售");
  await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getAllByRole("combobox", { name: "寄售平台" })[0]);
  await userEvent.setup({ pointerEventsCheck: 0 }).click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
  await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole("button", { name: "确认上架" }));

  await waitFor(() => expect(catalog.ordersApi.create).toHaveBeenCalledWith(expect.objectContaining({ account_id: 88, order_type: "DG", form_extra_scope: "CONSIGN" })));
});

it("P1/FE-264：系统下架提交产生可确认的成功反馈", async () => {
  vi.spyOn(appMessage, "success").mockImplementation(() => ({} as never));
  vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([{ id: 91, game_account: "system-offsale-regression", status: "WAITING", inventory_type: "RECOVERY", cost_amount: "100.00" }] as never);
  vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValueOnce({
    account: { id: 91, game_account: "system-offsale-regression", status: "WAITING", inventory_type: "RECOVERY" },
    // 可冲销余额由后端下发（cancellable_amount），前端不再自己 amount − Σcancel。
    orders: [{ order_id: 921, order_type: "HS", status: "ACTIVE", events: [{ id: 922, event_type: "BUY", amount: "100.00", portion: "PRINCIPAL", is_posted: true, cancellable_amount: "100.00" }] }],
  } as never);
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([{ id: 3, code: "MAIN", name: "主池", status: "ACTIVE" }] as never);
  vi.mocked(catalog.ordersApi.postEvent).mockResolvedValueOnce({} as never);
  renderLight(<InventoryPanel />, { user: "admin" });
  const row = (await screen.findByText("system-offsale-regression")).closest("tr") as HTMLElement;
  await userEvent.setup({ pointerEventsCheck: 0 }).click(within(row).getByRole("button", { name: /更多/ }));
  const menu = await screen.findByRole("menu");
  await userEvent.setup({ pointerEventsCheck: 0 }).click(within(menu).getByText("取消"));
  const modal = await screen.findByRole("dialog");
  await userEvent.setup({ pointerEventsCheck: 0 }).clear(within(modal).getByLabelText("退回金额"));
  await userEvent.setup({ pointerEventsCheck: 0 }).type(within(modal).getByLabelText("退回金额"), "80");
  await userEvent.setup({ pointerEventsCheck: 0 }).click(within(modal).getByLabelText("收款账户").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
  await userEvent.setup({ pointerEventsCheck: 0 }).click(await screen.findByText("主池（MAIN）", { selector: ".ant-select-item-option-content" }));
  await userEvent.setup({ pointerEventsCheck: 0 }).type(within(modal).getByLabelText("取消原因"), "系统下架回归");
  await userEvent.setup({ pointerEventsCheck: 0 }).click(within(modal).getByRole("button", { name: /确认下架/ }));

  await waitFor(() => expect(catalog.ordersApi.postEvent).toHaveBeenCalledWith(921, expect.objectContaining({ event_type: "CANCEL", amount: "80", pool_id: 3 })));
  await waitFor(() => expect(appMessage.success).toHaveBeenCalledWith("账号已下架"));
});

it("P1/FE-265：订单详情回显交易平台、中介类型和包赔类型", async () => {
  renderLight(
    <OrderDetailDeliverySection
      meta={{ sourceOrderNo: "HS-FE265" } as never}
      detail={{
        orders: [{
          order_id: 265,
          order_no: "HS-FE265",
          order_type: "HS",
          created_at: "2026-11-02T10:00:00",
          extra_values: { intermediary_platform: "盼之", intermediary_type: "包赔", compensation_type: "续保" },
          events: [],
        }],
      } as never}
    />,
    { user: "admin" },
  );

  expect(await screen.findByText("盼之")).toBeInTheDocument();
  expect(screen.getByText("包赔")).toBeInTheDocument();
  expect(screen.getByText("续保")).toBeInTheDocument();
});

it("P1/FE-266：订单详情负责人显示员工姓名且不展示原始 ID", async () => {
  renderLight(
    <OrderDetailDeliverySection
      meta={{ sourceOrderNo: "HS-FE266" } as never}
      detail={{
        orders: [{
          order_id: 266,
          order_no: "HS-FE266",
          order_type: "HS",
          created_at: "2026-11-02T10:00:00",
          extra_values: { delivery_responsible_ids: [7] },
          events: [],
        }],
      } as never}
      employees={[{ id: 7, username: "lisi", display_name: "李三（三三）", is_active: true }]}
    />,
    { user: "admin" },
  );

  expect(await screen.findByText("李三（三三）")).toBeInTheDocument();
  expect(screen.queryByText("7")).not.toBeInTheDocument();
});

it("P1/FE-267：订单详情分别回显买号和卖号手机号绑定人", async () => {
  renderLight(
    <OrderDetailDeliverySection
      meta={{ sourceOrderNo: "HS-FE267" } as never}
      detail={{
        orders: [
          {
            order_id: 267,
            order_no: "HS-FE267",
            order_type: "HS",
            created_at: "2026-11-02T10:00:00",
            extra_values: { bound_phone: "13800000001", bound_phone_owner: "买家负责人" },
            events: [],
          },
          {
            order_id: 268,
            order_no: "DG-FE267",
            order_type: "DG",
            created_at: "2026-11-02T11:00:00",
            extra_values: { bound_phone: "13800000002", bound_phone_owner: "卖出负责人" },
            events: [{ event_type: "SELL", id: 1, amount: "1", occurred_on: "2026-11-02", cancellable_amount: "1" }],
          },
        ],
      } as never}
    />,
    { user: "admin" },
  );

  expect(await screen.findByText("买家负责人")).toBeInTheDocument();
  expect(screen.getByText("卖出负责人")).toBeInTheDocument();
  expect(screen.getByText("13800000001")).toBeInTheDocument();
  expect(screen.getByText("13800000002")).toBeInTheDocument();
});

it("P1/FE-268：库存 CSV 补齐详情订单号并汇总返点收入", () => {
  const csv = buildInventoryCsv([{
    id: 268,
    source_order_no: "",
    game_account: "csv-rebate-regression",
    inventory_type: "RECOVERY",
    status: "WAITING",
    cost_amount: "100.00",
  } as never], {
    268: {
      orders: [{
        order_id: 2681,
        order_no: "HS-FE268",
        order_type: "HS",
        status: "DONE",
        created_at: "2026-11-02T10:00:00",
        events: [],
        rebates: [{
          id: 1,
          rebate_no: "HS-FE268-RB01",
          rebate_type: "BUY",
          channel: "买号返点",
          rate: "10",
          base_amount: "100.00",
          status: "OPEN",
          collected_on: "2026-11-02",
        }],
      }],
      // 合计取后端 finance_summary（口径见 backend tests/v1/test_execution_finance_summary.py）。
      finance_summary: {
        cashflow_income: "0.00",
        rebate_income: "100.00",
        total_income: "100.00",
        total_expense: "0.00",
        net_amount: "100.00",
      },
    } as never,
  });

  expect(csv).toContain("HS-FE268");
  expect(csv).toContain(",0,1,0.00,100.00");
});

it("P1/FE-269：订单详情财务摘要纳入返点收入", () => {
  renderLight(<OrderDetail row={{ id: 269, game_account: "rebate-summary-regression", status: "WAITING" } as never} detail={{
    orders: [{
      order_id: 2691,
      order_no: "HS-FE269",
      order_type: "HS",
      status: "DONE",
      created_at: "2026-11-02T10:00:00",
      events: [],
      rebates: [{
        id: 1,
        rebate_no: "HS-FE269-RB01",
        rebate_type: "BUY",
        channel: "买号返点",
        rate: "10",
        base_amount: "100.00",
        status: "OPEN",
        collected_on: "2026-11-02",
      }],
    }],
    finance_summary: {
      cashflow_income: "0.00",
      rebate_income: "100.00",
      total_income: "100.00",
      total_expense: "0.00",
      net_amount: "100.00",
    },
  } as never} loading={false} />, { user: "admin" });

  const finance = document.querySelector(".inventory-detail__section--finance") as HTMLElement;
  expect(within(finance).getAllByText("1 笔").length).toBeGreaterThanOrEqual(1);
  // 总收入直接显示后端下发的 finance_summary.total_income。
  const summary = finance.querySelector(".inventory-finance-summary") as HTMLElement;
  expect(within(summary).getByText("总收入").parentElement).toHaveTextContent("100.00");
});

it("P1/FE-270/271/272/273：R2/R3/R4/R5 历史空区间分别传递筛选条件", async () => {
  vi.mocked(catalog.reportsApi.monthlyPnl).mockResolvedValue({ items: [], total: {} } as never);
  vi.mocked(catalog.reportsApi.commission).mockResolvedValue({ items: [], total: { order_count: 0, payable: "0", paid: "0", difference: "0" } } as never);
  vi.mocked(catalog.reportsApi.businessPnl).mockResolvedValue({ items: [], total: {} } as never);
  vi.mocked(catalog.reportsApi.orderProfit).mockResolvedValue({ items: [], total: {} } as never);
  vi.mocked(catalog.reportsApi.dailyFunds).mockResolvedValue({ date: "2026-10-01", total: {}, items: [] } as never);
  renderLight(<ReportsPage />, { user: "admin" });
  const setRange = async (tab: string) => {
    await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole("tab", { name: tab }));
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const dates = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    fireEvent.change(dates[0], { target: { value: "2026-10-01" } });
    fireEvent.change(dates[1], { target: { value: "2026-10-31" } });
  };

  await setRange("月度损益 R2");
  await waitFor(() => expect(catalog.reportsApi.monthlyPnl).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31" }));
  await setRange("提成对账 R3");
  await waitFor(() => expect(catalog.reportsApi.commission).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31", all_people: true }));
  await setRange("业务损益 R5");
  await waitFor(() => expect(catalog.reportsApi.businessPnl).toHaveBeenLastCalledWith({ from: "2026-10-01", to: "2026-10-31" }));
  await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole("tab", { name: "资金报表·日报" }));
  const dailyInput = await screen.findByLabelText("资金日报日期");
  fireEvent.change(dailyInput, { target: { value: "2026-10-01" } });
  await waitFor(() => expect(catalog.reportsApi.dailyFunds).toHaveBeenLastCalledWith({ on: "2026-10-01" }));
  expect(dailyInput).toHaveValue("2026-10-01");
});

it("P1/FE-258：库存图片保存失败时保留上下文并显示错误态", async () => {
  vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([{
    id: 1,
    source_order_no: "HS-IMAGE-ERROR-01",
    game_account: "image-error-account",
    status: "WAITING",
    inventory_type: "RECOVERY",
    cost_amount: "100.00",
  }] as never);
  vi.mocked(catalog.stocksApi.updateProfile).mockRejectedValueOnce(new Error("image save timeout"));
  renderLight(<InventoryPanel />, { user: "admin" });

  const row = (await screen.findByText("image-error-account")).closest("tr") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /更多/ }));
  fireEvent.click(within(await screen.findByRole("menu")).getByText("作图"));
  await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole("button", { name: /保存/ }));

  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getAllByText("作图").length).toBeGreaterThanOrEqual(1);
});

it("P1/FE-259：合作方拉黑状态使用正确的 active 语义", async () => {
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValueOnce([
    { id: 11, counterparty_no: "CP-REG-11", display_name: "同行回归", type: "PEER", status: "ACTIVE" },
  ] as never);
  renderLight(<CounterpartyPanel />, { user: "admin" });
  const row = (await screen.findByText("CP-REG-11")).closest("tr") as HTMLElement;
  await userEvent.setup({ pointerEventsCheck: 0 }).click(within(row).getByRole("button", { name: /拉黑/ }));
  await userEvent.setup({ pointerEventsCheck: 0 }).click(await screen.findByRole("button", { name: /确定|确认/ }));

  await waitFor(() => expect(catalog.counterpartiesApi.setStatus).toHaveBeenCalledWith(11, false));
});

it("P1/FE-260：提成对账人员筛选传递 user_id", async () => {
  vi.mocked(catalog.employeesApi.list).mockResolvedValueOnce([
    { id: 7, username: "operator", display_name: "业务同事", is_active: true },
  ] as never);
  vi.mocked(catalog.reportsApi.commission).mockResolvedValue({ items: [], total: { order_count: 0, payable: "0", paid: "0", difference: "0" } } as never);
  renderLight(<ReportsPage initialReportTab="commission" />, { user: "admin" });
  await screen.findByRole("tab", { name: "提成对账 R3" });
  await waitFor(() => expect(catalog.reportsApi.commission).toHaveBeenLastCalledWith({ all_people: true }));
  const comboboxes = await screen.findAllByRole("combobox");
  const filter = comboboxes[comboboxes.length - 1] as HTMLElement;
  await userEvent.setup({ pointerEventsCheck: 0 }).click(filter);
  await userEvent.setup({ pointerEventsCheck: 0 }).click(await screen.findByText(/业务同事（operator）/, { selector: ".ant-select-item-option-content" }));
  await waitFor(() => expect(catalog.reportsApi.commission).toHaveBeenLastCalledWith({ all_people: true, user_id: 7 }));
});

it("P1/FE-129：无平台初始代挂动作不生成平台上架记录", () => {
  expect(consignmentRecords([{
    order_id: 129,
    order_no: "DG-FE129-BASE",
    order_type: "DG",
    status: "ACTIVE",
    created_at: "2026-11-02T10:00:00",
    trade_date: "2026-11-02",
    extra_values: {},
    events: [],
  }] as never)).toEqual([]);
});

it("P1/FE-207：真实用户中心在改密请求悬挂时仍可关闭", async () => {
  vi.spyOn(client, "changePassword").mockReturnValue(new Promise(() => undefined));
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([] as never);
  vi.mocked(catalog.reportsApi.commission).mockResolvedValue({ items: [], total: { profit_base: "0" } } as never);
  vi.mocked(catalog.stocksApi.list).mockResolvedValue([] as never);
  vi.mocked(catalog.installmentsApi.list).mockResolvedValue([] as never);
  vi.mocked(catalog.notificationsApi.list).mockResolvedValue({ items: [] } as never);
  renderApp(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <AppShell />
    </MemoryRouter>,
    { user: "admin" },
  );

  fireEvent.click(await screen.findByRole("button", { name: "用户中心" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("当前密码"), { target: { value: "wrong-old-pass" } });
  fireEvent.change(within(dialog).getByLabelText("新密码"), { target: { value: "new-pass-12345" } });
  fireEvent.change(within(dialog).getByLabelText("确认新密码"), { target: { value: "new-pass-12345" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /修改密码/ }));
  await waitFor(() => expect(client.changePassword).toHaveBeenCalledWith("wrong-old-pass", "new-pass-12345"));
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "用户中心" })).toHaveAttribute("data-user-center-open", "false"));
});

it("P2/FE-274：库存作图空图片集不允许伪装保存成功", async () => {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const onError = vi.fn();
  renderLight(
    <InventoryProfileModal
      target={{ account: { id: 901, account_images: [] } as never, mode: "images" }}
      onClose={onClose}
      onSaved={onSaved}
      onError={onError}
    />,
    { user: "admin" },
  );
  await screen.findByText("作图");
  await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole("button", { name: /保存/ }));
  expect(catalog.stocksApi.updateProfile).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(await screen.findByRole("alert")).toHaveTextContent("请至少添加一张图片");
});
