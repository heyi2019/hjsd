import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../shared/api/catalog";
vi.mock("../shared/api/catalog");
import * as client from "../shared/api/client";
import { renderLight } from "../test/render";
import { SettingsPage } from "./SettingsPage";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

// vi.hoisted：保证 const 在 vi.mock 工厂执行前完成初始化，避免 TDZ（直接返回对象引用会触发）。


vi.mock("../shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/api/client")>()),
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
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
  vi.clearAllMocks();
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(orderTypes);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools);
  vi.mocked(catalog.fieldsApi.list).mockResolvedValue(fields);
  vi.mocked(catalog.optionSetsApi.list).mockResolvedValue({ items: [] });
  vi.mocked(catalog.gameTypesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.policyApi.list).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(client.api).get.mockResolvedValue({ data: [] });
});

it("业务字典仅说明业务口径，不展示配置跳转按钮", async () => {
  renderLight(<SettingsPage />, { user: "admin" });
  const tabs = await screen.findAllByRole("tab");
  expect(tabs.slice(0, 4).map((tab) => tab.textContent)).toEqual([
    "业务字典",
    "表单字段",
    "选项词典",
    "扩展字段",
  ]);
  expect(screen.getByText("业务分类口径")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /配置字段与表单/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /管理扩展字段/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /维护选项词典/ })).toBeNull();
  expect(screen.queryByRole("tab", { name: "配置总览" })).toBeNull();

  await ui.click(screen.getByRole("tab", { name: "扩展字段" }));
  expect(screen.getByRole("tab", { name: "扩展字段", selected: true })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /配置表单字段/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /维护选项词典/ })).toBeInTheDocument();
  await ui.click(screen.getByRole("button", { name: /配置表单字段/ }));
  expect(screen.getByRole("tab", { name: "表单字段", selected: true })).toBeInTheDocument();

  expect(screen.getByRole("tab", { name: "业务类型" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "资金池" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "扩展字段" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "经营规则" })).toBeInTheDocument();
  // 业务字典作为入口时，业务类型面板尚未挂载。
  expect(screen.queryByText("HS")).toBeNull();
  await ui.click(screen.getByRole("tab", { name: "业务类型" }));
  expect(await screen.findByText("HS")).toBeInTheDocument();
});

it("业务分类明确分期归自营、代分期归分销", async () => {
  renderLight(<SettingsPage />, { user: "admin" });
  // 默认 Tab 是业务字典。
  expect(await screen.findByText(/分期：本方账号售出，买家分期支付售卖款/)).toBeInTheDocument();
  expect(screen.getByText(/代分期：客户向本方借款，按合约分期还款/)).toBeInTheDocument();
  expect(screen.getAllByText(/生成 DFQ 业务订单号/)).toHaveLength(2);
});
