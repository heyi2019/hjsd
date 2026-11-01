import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import * as catalog from "../shared/api/catalog";
import { CreateBusinessModal } from "../orders/CreateBusinessModal";
import { OrdersPage } from "../orders/OrdersPage";
import { InstallmentsPanel } from "../installments/InstallmentsPanel";
import { UsersPanel } from "../users/UsersPanel";
import { TeamsPanel } from "../users/TeamsPanel";
import { UserCenterPage } from "../auth/UserCenterPage";
import * as client from "../shared/api/client";
import { ACCESS_TOKEN_KEY } from "../shared/api/client";
import { ReportsPage } from "../reporting/ReportsPage";
import { FundsPage } from "../pools/FundsPage";
import { DataCenterPanel } from "../reporting/DataCenterPanel";
import { CustomerPanel } from "../customers/CustomerPanel";
import { countOngoingOrders } from "../reporting/DataCenterPanel";
import { OrderTypesPanel } from "../field-definitions/panels/OrderTypesPanel";
import { PoolsPanel } from "../field-definitions/panels/PoolsPanel";
import { OrderTypeRoutesPanel } from "../field-definitions/panels/OrderTypeRoutesPanel";
import { isSupportedImportFile } from "../imports/ImportWorkbench.fragments";
import { OrderDetail } from "../stocks/OrderDetail";
import { InventorySaleModal } from "../stocks/InventorySaleModal";
import { buildInventoryCsv } from "../stocks/inventory-export";
import { clearOptionSetsCache, loadOptionSets } from "../shared/lib/optionSets";
import { seedOrderFormFields } from "../test/formFieldsSeed";
import { appMessage, appModal } from "../shared/ui/appFeedback";
import { buildActionAllocationCandidates, buildActionAllocationRows } from "../orders/orderpage/helpers";

vi.mock("../shared/api/catalog");

const types = [{ id: 1, code: "TH", name: "提号", capital_type: "DISTRIBUTION", is_active: true }];
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
  vi.mocked(catalog.rebatesApi.list).mockResolvedValue([] as never);
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
    { id: 10, order_no: "TH-2026-0002", order_type: "TH", capital_type: "DISTRIBUTION", trade_date: "2026-10-01", status: "ACTIVE" },
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

it("P1/FE-049：超出转出资金池可用余额时不发起划转", async () => {
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([
    { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
    { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", ownership: "SELF", status: "ACTIVE" },
  ] as never);
  vi.mocked(catalog.poolsApi.balance).mockResolvedValue({ income: "1000.00", expense: "200.00", cash_balance: "800.00", deposit_held: "100.00", available: "700.00" } as never);
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
  const original = { id: 7, flow_no: "CF-A-07", pool_id: 1, occurred_on: "2026-10-17", nature: "BUSINESS_OUT", category: "BUY", direction: "OUT", amount: "300.00", source: "MANUAL", fund_nature: "BUSINESS", accounting_attribute: "SELF_DIRECT_COST", status: "APPROVED" };
  const reversal = { ...original, id: 8, flow_no: "CF-REV-08", category: "REVERSAL", direction: "IN", accounting_attribute: "REVERSAL", reversal_of_id: 7 };
  let mainListCalls = 0;
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([
    { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
  ] as never);
  vi.mocked(catalog.poolsApi.balance).mockResolvedValue({ income: "1000.00", expense: "200.00", cash_balance: "800.00", deposit_held: "100.00", available: "700.00" } as never);
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
  vi.mocked(catalog.reportsApi.financeDimensions).mockResolvedValue({ items: [], total_amount: "0", total_signed_amount: "0" } as never);
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
  await user.click(screen.getByRole("tab", { name: /资金属性分析/ }));
  await waitFor(() => expect(catalog.reportsApi.financeDimensions).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
  await user.click(screen.getByRole("tab", { name: /订单利润/ }));
  await waitFor(() => expect(catalog.reportsApi.orderProfit).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined }));
  await user.click(screen.getByRole("tab", { name: /资金日报 R4/ }));
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

it("P1/FE-023：库存中的未售出重复账号直接阻止建单并保留表单", async () => {
  const confirmSpy = vi.spyOn(appModal, "confirm");
  vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([
    { id: 99, game_account: "duplicate-account", game_type: "王者荣耀", status: "WAITING" },
  ] as never);
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
  await user.click(screen.getByText("请选择支出账户", { exact: true }).closest(".ant-select")!.querySelector(".ant-select-selector") as Element);
  await user.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
  await user.click(screen.getByRole("button", { name: /创建订单/ }));

  await waitFor(() => expect(screen.getByText(/请先售出后再建单/)).toBeInTheDocument());
  expect(screen.getByLabelText("游戏账号")).toHaveValue("duplicate-account");
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(catalog.ordersApi.create).not.toHaveBeenCalled();
});

it("P1/FE-023：已售出重复账号确认复购后允许回流建单", async () => {
  let confirmConfig: { onOk?: () => void | Promise<void> } | undefined;
  const confirmSpy = vi.spyOn(appModal, "confirm").mockImplementation((config) => {
    confirmConfig = config as typeof confirmConfig;
    return { destroy: () => undefined } as unknown as ReturnType<typeof appModal.confirm>;
  });
  vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([
    { id: 99, game_account: "duplicate-account", game_type: "王者荣耀", status: "SOLD" },
  ] as never);
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
  await user.click(screen.getByText("请选择支出账户", { exact: true }).closest(".ant-select")!.querySelector(".ant-select-selector") as Element);
  await user.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
  await user.click(screen.getByRole("button", { name: /创建订单/ }));

  await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
  expect(catalog.ordersApi.create).not.toHaveBeenCalled();
  expect(confirmConfig).toMatchObject({ title: "检测到重复游戏账号", okText: "是，继续建单", cancelText: "否，返回修改" });
  await act(async () => { await confirmConfig?.onOk?.(); });
  await waitFor(() => expect(catalog.ordersApi.create).toHaveBeenCalled());
});

it("P1/FE-035：分润按建单、卖出和运营信息负责人自动绑定", () => {
  const candidates = buildActionAllocationCandidates({
    form_extra: {
      business_responsible_ids: [11],
      delivery_responsible_ids: [22],
    },
    events: [
      { id: 1, event_no: "EV-1", order_id: 10, event_type: "BUY", amount: "100", occurred_on: "2026-10-01", is_posted: true, operator_user_ids: [] },
      { id: 2, event_no: "EV-2", order_id: 10, event_type: "SELL", amount: "200", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [] },
      { id: 3, event_no: "EV-3", order_id: 10, event_type: "COST", amount: "20", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [33] },
    ],
  });
  const rows = buildActionAllocationRows([], candidates);

  expect(candidates).toMatchObject({ BUY: [11], SELL: [22], OPERATION: [33], COMPANY: [] });
  expect(rows.map((row) => row.employee)).toEqual([11, 22, 33, "COMPANY"]);
  expect(rows.map((row) => row.allocation_type)).toEqual(["BUY", "SELL", "OPERATION", "COMPANY"]);
});

it("P1/FE-224：库存健康接口失败时不把未知结果显示为 0", async () => {
  vi.mocked(catalog.reportsApi.inventoryHealth).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
  renderLight(<ReportsPage />, { user: "admin" });
  await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  expect(screen.getAllByText("不可用")).toHaveLength(2);
  expect(screen.getByText("库存健康数据不可用，请点击重新加载")).toBeInTheDocument();
  expect(screen.queryByText("暂无在库账号")).not.toBeInTheDocument();
});

it("P1/FE-238：业务类型主数据失败时锁定新建入口", async () => {
  vi.mocked(catalog.orderTypesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "types down" });
  renderLight(<OrderTypesPanel />, { user: "admin" });
  expect(await screen.findByText("业务类型数据不可用，请点击重新加载")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /新建类型/ })).toBeDisabled();
  expect(screen.getByText("业务类型数据不可用，请点击重新加载")).toBeInTheDocument();
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
    { id: 1, code: "HS", name: "回收", capital_type: "STOCK", is_active: true },
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

it("P1/FE-063：导入文件类型校验拒绝 PNG", () => {
  expect(isSupportedImportFile({ name: "account-image.png", type: "image/png" })).toBe(false);
  expect(isSupportedImportFile({ name: "orders.csv", type: "text/csv" })).toBe(true);
  expect(isSupportedImportFile({ name: "rows.json", type: "application/json" })).toBe(true);
});

it("P1/FE-149：数据中心进行中包含分期订单并跳转订单台账", async () => {
  expect(countOngoingOrders([{ status: "ACTIVE" }, { status: "INSTALLMENT" }, { status: "COMPLETED" }])).toBe(2);
  vi.mocked(catalog.poolsApi.list).mockResolvedValueOnce([]);
  vi.mocked(catalog.ordersApi.list).mockResolvedValueOnce([
    { id: 10, order_no: "HS-2026-0001", order_type: "HS", capital_type: "STOCK", trade_date: "2026-10-01", status: "ACTIVE" },
    { id: 11, order_no: "TH-2026-0002", order_type: "TH", capital_type: "STOCK", trade_date: "2026-10-02", status: "INSTALLMENT" },
    { id: 12, order_no: "DG-2026-0003", order_type: "DG", capital_type: "ZERO", trade_date: "2026-10-03", status: "COMPLETED" },
  ]);
  const onNavigate = vi.fn();
  renderLight(<DataCenterPanel onNavigate={onNavigate} />, { user: "admin" });
  const card = await screen.findByRole("button", { name: /进行中/ });
  expect(card).toHaveTextContent("2");
  await userEvent.setup({ pointerEventsCheck: 0 }).click(card);
  expect(onNavigate).toHaveBeenCalledWith("business", "ledger");
});

it("P1/FE-241：数据中心主数据失败时不显示零统计且禁用快捷入口", async () => {
  vi.mocked(catalog.poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "pools down" });
  const onNavigate = vi.fn();
  renderLight(<DataCenterPanel onNavigate={onNavigate} />, { user: "admin" });

  const totalCard = await screen.findByRole("button", { name: /订单总数/ });
  const activeCard = screen.getByRole("button", { name: /进行中/ });
  expect(totalCard).toHaveTextContent("不可用");
  expect(activeCard).toHaveTextContent("不可用");
  expect(totalCard).toHaveAttribute("aria-disabled", "true");
  expect(activeCard).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(totalCard);
  expect(onNavigate).not.toHaveBeenCalled();
  expect(screen.getByText("资金池数量").closest(".ui-stat")).toHaveTextContent("不可用");
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

it("P1/FE-244：资金总览数据失败时不显示零统计且禁用划转", async () => {
  vi.mocked(catalog.poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "pools down" });
  renderLight(<FundsPage />, { user: "admin" });

  expect(await screen.findByText("资金池卡片")).toBeInTheDocument();
  expect(screen.getByText("现金头寸合计").closest(".ui-stat")).toHaveTextContent("不可用");
  expect(screen.getByText("可用余额合计").closest(".ui-stat")).toHaveTextContent("不可用");
  expect(screen.getByRole("button", { name: /资金池划转/ })).toBeDisabled();
});

it("P1/FE-208：订单台账加载未完成时不显示零统计", async () => {
  vi.mocked(catalog.ordersApi.list).mockImplementation(() => new Promise(() => undefined));
  renderLight(<OrdersPage initialTab="ledger" />, { user: "admin" });
  const ledger = await screen.findByRole("tabpanel", { name: "订单台账" });
  const card = screen.getByText("订单总量").closest(".ui-stat") as HTMLElement;
  expect(card).toHaveTextContent("—");
  expect(card).not.toHaveTextContent("0");
  expect(ledger).toBeInTheDocument();
});
