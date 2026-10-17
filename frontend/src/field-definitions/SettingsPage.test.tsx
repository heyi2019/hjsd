import { screen } from "@testing-library/react";
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
