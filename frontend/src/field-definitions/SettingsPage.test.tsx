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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(orderTypes);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools);
  vi.mocked(catalog.optionSetsApi.list).mockResolvedValue({ items: [] });
  vi.mocked(catalog.gameTypesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.policyApi.list).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(client.api).get.mockResolvedValue({ data: [] });
});

it("业务配置类页签已聚合进配置中心，左侧仅保留配置中心与非业务配置类页签", async () => {
  renderLight(<SettingsPage />, { user: "admin" });
  const tabs = await screen.findAllByRole("tab");
  const labels = tabs.map((t) => t.textContent);
  // 配置中心与各非业务配置类页签保留
  expect(labels).toContain("配置中心");
  expect(labels).toContain("业务字典");
  expect(labels).toContain("经营规则");
  // 原独立业务配置页签已移除（进配置中心）
  expect(screen.queryByRole("tab", { name: "业务类型" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "表单字段" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "列表字段" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "资金池" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "游戏与渠道" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "编号序列" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "中介业务配置" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "参与方来源" })).toBeNull();
  // 默认仍是业务字典
  expect(screen.getByText("业务分类口径")).toBeInTheDocument();
  // 进入配置中心后能看到业务类型页签并默认渲染其页面
  await ui.click(screen.getByRole("tab", { name: "配置中心" }));
  expect(await screen.findByTestId("center-nav-order-types")).toBeInTheDocument();
  expect(await screen.findByText("HS")).toBeInTheDocument();
});

it("业务字典按账号流转、资金动作和账务动作三层结构渲染", async () => {
  renderLight(<SettingsPage />, { user: "admin" });

  // 三层分组结构渲染（结构断言，不锁具体文案）
  expect(document.querySelectorAll(".business-dictionary__group").length).toBeGreaterThanOrEqual(3);
  // 动作行数量健康，防止整段误删
  expect(document.querySelectorAll(".business-dictionary__action-line").length).toBeGreaterThan(10);
  // 列头重构后旧表头不应再出现（组件结构回归，非业务文案）
  expect(screen.queryByText("二级分类")).toBeNull();
  expect(screen.queryByText("三级分类")).toBeNull();
  expect(screen.queryByText("动作说明")).toBeNull();
});
