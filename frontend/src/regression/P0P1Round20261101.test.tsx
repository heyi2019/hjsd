import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import * as catalog from "../shared/api/catalog";
import { CreateBusinessModal } from "../orders/CreateBusinessModal";
import { OrdersPage } from "../orders/OrdersPage";
import { InstallmentsPanel } from "../installments/InstallmentsPanel";
import { UsersPanel } from "../users/UsersPanel";
import { ReportsPage } from "../reporting/ReportsPage";
import { DataCenterPanel } from "../reporting/DataCenterPanel";
import { countOngoingOrders } from "../reporting/DataCenterPanel";
import { OrderTypesPanel } from "../field-definitions/panels/OrderTypesPanel";
import { PoolsPanel } from "../field-definitions/panels/PoolsPanel";
import { OrderTypeRoutesPanel } from "../field-definitions/panels/OrderTypeRoutesPanel";
import { isSupportedImportFile } from "../imports/ImportWorkbench.fragments";
import { OrderDetail } from "../stocks/OrderDetail";
import { buildInventoryCsv } from "../stocks/inventory-export";
import { clearOptionSetsCache, loadOptionSets } from "../shared/lib/optionSets";
import { seedOrderFormFields } from "../test/formFieldsSeed";
import { appModal } from "../shared/ui/appFeedback";
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
  clearOptionSetsCache();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(types);
  vi.mocked(catalog.customersApi.list).mockResolvedValue([]);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([]);
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
  expect(await screen.findByText(/types down/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /新建类型/ })).toBeDisabled();
  expect(screen.getByText("业务类型数据不可用，请点击重新加载")).toBeInTheDocument();
});

it("P1/FE-239：资金池主数据失败时锁定新增入口", async () => {
  vi.mocked(catalog.poolsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "pools down" });
  renderLight(<PoolsPanel />, { user: "admin" });
  expect(await screen.findByText(/pools down/)).toBeInTheDocument();
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

it("P1/FE-208：订单台账加载未完成时不显示零统计", async () => {
  vi.mocked(catalog.ordersApi.list).mockImplementation(() => new Promise(() => undefined));
  renderLight(<OrdersPage initialTab="ledger" />, { user: "admin" });
  const ledger = await screen.findByRole("tabpanel", { name: "订单台账" });
  const card = screen.getByText("订单总量").closest(".ui-stat") as HTMLElement;
  expect(card).toHaveTextContent("—");
  expect(card).not.toHaveTextContent("0");
  expect(ledger).toBeInTheDocument();
});
