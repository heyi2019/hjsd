import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gameTypesApi, sequencesApi } from "@/shared/api/misc.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { listColumnsApi, orderFormFieldsApi, orderTypesApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";
import { notifyReferenceDataChanged } from "@/shared/state/referenceDataEvents";
import type { OrderType } from "@/shared/api/types/orders";
import { optionSet, optionSetList } from "@fixtures/api-responses";
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
import * as client from "@/shared/api/client";
vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
}));
import { renderLight } from "@fixtures/render";
import { ConfigCenterPanel } from "@/settings/panels/ConfigCenterPanel";

const orderTypes = [
  { id: 1, code: "HS", name: "回收", is_active: true },
] as unknown as import("@/shared/api/types/orders").OrderType[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(orderTypesApi.list).mockResolvedValue(orderTypes);
  vi.mocked(poolsApi.list).mockResolvedValue([
    { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", status: "ACTIVE" },
  ] as never);
  vi.mocked(gameTypesApi.list).mockResolvedValue([] as never);
  vi.mocked(optionSetsApi.list).mockResolvedValue(optionSetList() as never);
  vi.mocked(optionSetsApi.get).mockResolvedValue(optionSet() as never);
  Object.assign(optionSetsApi, { listCustom: vi.fn().mockResolvedValue({ items: [], available_fields: [] }) });
  vi.mocked(listColumnsApi.all).mockResolvedValue([] as never);
  vi.mocked(sequencesApi.list).mockResolvedValue([] as never);
  vi.mocked(client.api).get.mockResolvedValue({ data: [] });
});

describe("ConfigCenterPanel", () => {
  it("可在业务主数据中维护供货方来源和工作室费用科目", async () => {
    vi.mocked(optionSetsApi.get).mockResolvedValue({ options: [] } as never);
    vi.mocked(optionSetsApi.addItem).mockResolvedValue(undefined as never);
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
    vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigCenterPanel />, { user: "admin" });

    await ui.click(screen.getByTestId("center-nav-party-sources"));
    const supplierInput = await screen.findByPlaceholderText("请输入供货方来源主数据");
    await ui.type(supplierInput, "供货渠道甲");
    await ui.click(screen.getByRole("button", { name: "新增供货方来源主数据" }));
    await waitFor(() => expect(optionSetsApi.addItem).toHaveBeenCalledWith("SUPPLIER_SOURCE", "供货渠道甲"));

    await ui.click(screen.getByTestId("center-nav-studio-expense-items"));
    const expenseInput = await screen.findByPlaceholderText("请输入工作室支出费用科目");
    await ui.type(expenseInput, "办公室用品");
    await ui.click(screen.getByRole("button", { name: "新增工作室支出费用科目" }));
    await waitFor(() => expect(optionSetsApi.addItem).toHaveBeenCalledWith("STUDIO_EXPENSE_ITEM", "办公室用品"));
  });

  it("新增自定义字典后可在业务主数据中继续新增字典项", async () => {
    const field = { field_id: 88, order_type_code: "CUSTOMER", field_key: "preference", field_label: "客户偏好",
      scope_label: "客户建档", field_type: "SELECT", is_active: true };
    const created = { ...field, label: "偏好字典" };
    const createCustom = vi.fn().mockResolvedValue(created);
    Object.assign(optionSetsApi, { createCustom, listCustom: vi.fn().mockResolvedValue({ items: [], available_fields: [field] }) });
    const formField = { id: 88, order_type_code: "CUSTOMER", field_key: "preference", label: "客户偏好", field_type: "SELECT",
      is_custom: true, is_active: true, options: [{ value: "preference_01", label: "原选项" }] };
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => scope === "CUSTOMER" ? [formField as never] : []);
    vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
    vi.mocked(orderFormFieldsApi.update).mockResolvedValue(formField as never);
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigCenterPanel />, { user: "admin" });

    await ui.click(await screen.findByRole("button", { name: "新增字典" }));
    const dialog = screen.getByRole("dialog", { name: "新增字典" });
    await ui.type(within(dialog).getByLabelText("字典名称"), "偏好字典");
    await ui.click(within(dialog).getByRole("combobox", { name: "关联扩展字段" }));
    await ui.click(await screen.findByText("客户建档 · 客户偏好"));
    await ui.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(createCustom).toHaveBeenCalledWith("偏好字典", 88));
    expect(await screen.findByTestId("center-nav-custom-88")).toBeInTheDocument();
    const input = await screen.findByPlaceholderText("请输入偏好字典");
    await ui.type(input, "偏好甲");
    await ui.click(screen.getByRole("button", { name: "新增偏好字典" }));
    await waitFor(() => expect(orderFormFieldsApi.update).toHaveBeenCalledWith(88, {
      options: [{ value: "preference_01", label: "原选项" }, { value: "", label: "偏好甲" }],
      expected_options: [{ value: "preference_01", label: "原选项" }],
    }));
  });

  it("无维护权限时可查看自定义字典但不能新增", async () => {
    Object.assign(optionSetsApi, { listCustom: vi.fn().mockResolvedValue({ items: [{
      field_id: 88, label: "客户偏好", order_type_code: "CUSTOMER", field_key: "preference",
      field_label: "客户偏好", scope_label: "客户建档", field_type: "SELECT", is_active: true,
    }], available_fields: [] }) });
    renderLight(<ConfigCenterPanel />, { user: "viewer" });
    expect(await screen.findByTestId("center-nav-custom-88")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新增字典" })).toBeNull();
  });

  it("没有可关联字段时禁止新建，新增字段后无需刷新页面", async () => {
    const field = { field_id: 88, order_type_code: "CUSTOMER", field_key: "preference", field_label: "客户偏好",
      scope_label: "客户建档", field_type: "SELECT", is_active: true };
    Object.assign(optionSetsApi, { listCustom: vi.fn()
      .mockResolvedValueOnce({ items: [], available_fields: [] })
      .mockResolvedValue({ items: [], available_fields: [field] }) });
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    expect(await screen.findByText("请先添加自定义单选或多选字段")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增字典" })).toBeDisabled();
    await act(async () => notifyReferenceDataChanged("formFields"));
    await waitFor(() => expect(screen.getByRole("button", { name: "新增字典" })).toBeEnabled());
  });

  it("顶部渲染字段配置、业务主数据与编号管理，默认显示业务类型页面", async () => {
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    // 仅展示配置中心纳入的四组标题
    expect(await screen.findByText("字段配置")).toBeInTheDocument();
    expect(screen.getByText("业务主数据")).toBeInTheDocument();
    expect(screen.getByText("业务规则")).toBeInTheDocument();
    expect(screen.queryByText("数据治理")).toBeNull();
    expect(screen.queryByText("组织与权限")).toBeNull();
    expect(screen.queryByText("作业与外观")).toBeNull();
    expect(screen.getByText("编号管理")).toBeInTheDocument();
    // 默认选中业务类型（无权限门槛），渲染其现有页面（mock 数据 HS）
    expect(await screen.findByText("HS")).toBeInTheDocument();
    // 三组导航项均存在
    expect(screen.getByTestId("center-nav-form-fields")).toBeInTheDocument();
    expect(screen.getByTestId("center-nav-order-types")).toBeInTheDocument();
    expect(screen.getByTestId("center-nav-business-reminders")).toBeInTheDocument();
    expect(screen.getByTestId("center-nav-intermediary-platforms")).toBeInTheDocument();
    expect(screen.getByTestId("center-nav-party-sources")).toBeInTheDocument();
    expect(screen.getByTestId("center-nav-sequences")).toBeInTheDocument();
  });

  it("点击编号序列后显示只读编号页面", async () => {
    vi.mocked(sequencesApi.list).mockResolvedValue([
      { sequence_key: "STOCK_NO", prefix: "KU_", padding: 5, current_value: 20, next_number: "KU_00021" },
    ]);
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    await ui.click(screen.getByTestId("center-nav-sequences"));

    const content = screen.getByTestId("center-content");
    expect(await within(content).findByText("KU_00021")).toBeInTheDocument();
    expect(content.querySelectorAll(".ant-card")).toHaveLength(1);
    expect(within(content).getAllByText("编号序列")).toHaveLength(1);
  });

  it("点击业务提醒后展示库存阈值和提醒开关", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    await ui.click(screen.getByTestId("center-nav-business-reminders"));

    expect(await screen.findByText("库存订单超过多少天提醒")).toBeInTheDocument();
    expect(screen.getByText("新的分润通知")).toBeInTheDocument();
    expect(screen.getByText("逾期合约提醒")).toBeInTheDocument();
  });

  it("业务提醒面板复用配置中心容器，不嵌套重复卡片标题", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    await ui.click(screen.getByTestId("center-nav-business-reminders"));

    const content = screen.getByTestId("center-content");
    expect(content.querySelectorAll(".ant-card")).toHaveLength(1);
    expect(within(content).getAllByText("业务提醒")).toHaveLength(1);
  });

  it("点击顶部页签切换到对应现有页面（业务类型 → 列表字段）", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigCenterPanel />, { user: "admin" });
    await screen.findByText("HS");
    await ui.click(screen.getByTestId("center-nav-list-columns"));
    // 业务类型页面已卸载
    expect(screen.queryByText("HS")).toBeNull();
    // 选中态高亮切到列表字段
    expect(screen.getByTestId("center-nav-list-columns").className).toContain("config-center__item--active");
    expect(screen.getByTestId("center-nav-order-types").className).not.toContain("config-center__item--active");

    for (const [key, title] of [["intermediary-platforms", "中介业务配置"], ["party-sources", "参与方来源"]]) {
      await ui.click(screen.getByTestId(`center-nav-${key}`));
      expect(screen.getByTestId(`center-nav-${key}`)).toHaveClass("config-center__item--active");
      expect(within(screen.getByTestId("center-content")).getAllByText(title).length).toBeGreaterThan(0);
    }
  });

  it("viewer 隐藏有权限的字段配置项（表单字段），保留无权限项", async () => {
    renderLight(<ConfigCenterPanel />, { user: "viewer" });
    // 无权限项可见
    expect(await screen.findByTestId("center-nav-order-types")).toBeInTheDocument();
    // 有权限项被隐藏
    expect(screen.queryByTestId("center-nav-form-fields")).toBeNull();
    expect(screen.getByText("字段配置")).toBeInTheDocument();
  });
});
