import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { SettingsPage } from "./SettingsPage";

// vi.hoisted：保证 const 在 vi.mock 工厂执行前完成初始化，避免 TDZ（直接返回对象引用会触发）。
const { orderTypesApi, poolsApi, fieldsApi, policyApi } = vi.hoisted(() => ({
  orderTypesApi: { list: vi.fn(), create: vi.fn() },
  poolsApi: { list: vi.fn(), create: vi.fn() },
  fieldsApi: { list: vi.fn(), create: vi.fn(), setActive: vi.fn() },
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

it("经营规则 Tab：挂载后渲染 PolicySettingsPanel（StatRow「规则总数」唯一标识）", async () => {
  renderApp(<SettingsPage />, { user: "admin" });
  await screen.findByText("HS");
  await userEvent.click(screen.getByRole("tab", { name: "经营规则" }));
  // 「规则总数」只存在于 PolicySettingsPanel 的 StatRow，可唯一定位面板已挂载
  expect(await screen.findByText("规则总数")).toBeInTheDocument();
  await waitFor(() => expect(policyApi.list).toHaveBeenCalled());
});
