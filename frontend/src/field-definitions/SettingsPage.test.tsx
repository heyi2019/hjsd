import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { SettingsPage } from "./SettingsPage";

// vi.hoisted：保证 const 在 vi.mock 工厂执行前完成初始化，避免 TDZ（直接返回对象引用会触发）。
const { orderTypesApi, poolsApi, fieldsApi, policyApi } = vi.hoisted(() => ({
  orderTypesApi: { list: vi.fn(), create: vi.fn() },
  poolsApi: { list: vi.fn(), create: vi.fn() },
  fieldsApi: { list: vi.fn(), create: vi.fn(), setActive: vi.fn(), remove: vi.fn() },
  policyApi: {
    list: vi.fn(),
    versions: vi.fn(),
    approve: vi.fn(),
    create: vi.fn(),
    createVersion: vi.fn(),
    updateDraft: vi.fn(),
    resolve: vi.fn(),
    allocations: vi.fn(),
  },
}));

vi.mock("../shared/api/catalog", () => ({
  orderTypesApi,
  poolsApi,
  fieldsApi,
  policyApi,
}));

const orderTypes = [
  { id: 1, code: "HS", name: "回收", capital_type: "OWNED", is_active: true },
] as unknown as import("../shared/api/catalog").OrderType[];

const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
] as unknown as import("../shared/api/catalog").Pool[];

const fields = [
  { id: 1, entity_type: "ORDER", field_key: "region", label: "区域", field_type: "TEXT", is_active: true },
] as unknown as import("../shared/api/catalog").FieldDefinition[];

beforeEach(() => {
  orderTypesApi.list.mockResolvedValue(orderTypes);
  poolsApi.list.mockResolvedValue(pools);
  fieldsApi.list.mockResolvedValue(fields);
  policyApi.list.mockResolvedValue({ items: [], total: 0 });
});

it("渲染四个主数据 Tab，默认业务类型列表可见", async () => {
  renderApp(<SettingsPage />, { user: "admin" });
  expect(await screen.findByRole("tab", { name: "业务类型" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "资金池" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "活字段" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "经营规则" })).toBeInTheDocument();
  // 默认激活业务类型 Tab → 列表渲染
  expect(await screen.findByText("HS")).toBeInTheDocument();
});

it("业务分类明确分期归自营、代分期归分销", async () => {
  renderApp(<SettingsPage />, { user: "admin" });
  expect(await screen.findByText(/分期：本方账号售出，买家分期支付售卖款/)).toBeInTheDocument();
  expect(screen.getByText(/代分期：他人账号售出，本方提供代付或分期服务/)).toBeInTheDocument();
  expect(screen.getAllByText(/生成 DFQ 业务订单号/)).toHaveLength(2);
});

it("资金池 Tab：admin 可见「新增资金池」，viewer 走 fallback 且无按钮", async () => {
  renderApp(<SettingsPage />, { user: "admin" });
  await screen.findByText("HS");
  await userEvent.click(screen.getByRole("tab", { name: "资金池" }));
  expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /新增资金池/ })).toBeInTheDocument();
});

it("资金池 Tab：viewer 无 pool.manage → 显示无权限回退文案且无新增按钮", async () => {
  renderApp(<SettingsPage />, { user: "viewer" });
  await screen.findByText("HS");
  await userEvent.click(screen.getByRole("tab", { name: "资金池" }));
  await screen.findByText("HJ_CUSTODY");
  expect(screen.getByText("当前角色无主数据维护权限。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /新增资金池/ })).toBeNull();
});

it("活字段 Tab：viewer 无 field-definition.manage → 看不到启用/停用按钮", async () => {
  renderApp(<SettingsPage />, { user: "viewer" });
  await screen.findByText("HS");
  await userEvent.click(screen.getByRole("tab", { name: "活字段" }));
  await screen.findByText("区域");
  const labels = screen.queryAllByRole("button").map((b) => b.textContent ?? "");
  expect(labels.some((t) => t.includes("启用") || t.includes("停用"))).toBe(false);
});

it("活字段 Tab：admin 可删除无历史值字段（确认后调 remove 并刷新）", async () => {
  renderApp(<SettingsPage />, { user: "admin" });
  await screen.findByText("HS");
  await userEvent.click(screen.getByRole("tab", { name: "活字段" }));
  await screen.findByText("区域");
  await userEvent.click(screen.getByRole("button", { name: /删\s*除/ }));
  // 弹层确认按钮：测试环境下 antd locale 经 portal 后回退英文（OK），生产环境为「确定」，
  // 选择器同时覆盖两种文案以保证测试稳定。
  await userEvent.click(await screen.findByRole("button", { name: /确\s*定|OK/ }));
  await waitFor(() => expect(fieldsApi.remove).toHaveBeenCalledWith(1));
  await waitFor(() => expect(fieldsApi.list).toHaveBeenCalledTimes(2));
});

it("活字段 Tab：viewer 无 field-definition.manage → 无删除按钮", async () => {
  renderApp(<SettingsPage />, { user: "viewer" });
  await screen.findByText("HS");
  await userEvent.click(screen.getByRole("tab", { name: "活字段" }));
  await screen.findByText("区域");
  expect(screen.queryByRole("button", { name: /删\s*除/ })).toBeNull();
});

it("活字段 Tab：默认 TEXT 不展开选项输入，提交按定义回传类型/必填/排序", async () => {
  renderApp(<SettingsPage />, { user: "admin" });
  await screen.findByText("HS");
  await userEvent.click(screen.getByRole("tab", { name: "活字段" }));
  await screen.findByText("区域");
  expect(screen.queryByPlaceholderText(/逗号分隔/)).toBeNull();
  await userEvent.type(screen.getByPlaceholderText("小写下划线，如 credit_level"), "credit_level");
  await userEvent.type(screen.getByPlaceholderText("页面显示名"), "信用评级");
  await userEvent.click(screen.getByRole("button", { name: /新增字段/ }));
  await waitFor(() => expect(fieldsApi.create).toHaveBeenCalled());
  expect(fieldsApi.create.mock.calls[0][0]).toMatchObject({
    entity_type: "customer",
    field_key: "credit_level",
    label: "信用评级",
    field_type: "TEXT",
    required: false,
    sort_order: 0,
  });
});

it("经营规则 Tab：挂载后渲染 PolicySettingsPanel（StatRow「规则总数」唯一标识）", async () => {
  renderApp(<SettingsPage />, { user: "admin" });
  await screen.findByText("HS");
  await userEvent.click(screen.getByRole("tab", { name: "经营规则" }));
  // 「规则总数」只存在于 PolicySettingsPanel 的 StatRow，可唯一定位面板已挂载
  expect(await screen.findByText("规则总数")).toBeInTheDocument();
  await waitFor(() => expect(policyApi.list).toHaveBeenCalled());
});
