import * as catalog from "@/shared/api/catalog";
vi.mock("@/shared/api/catalog");
import * as client from "@/shared/api/client";
vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
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
import { renderLight } from "@fixtures/render";
import { screen } from "@testing-library/react";
import { SettingsPage } from "@/field-definitions/SettingsPage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const orderTypes = [
  { id: 1, code: "HS", name: "回收", capital_type: "OWNED", is_active: true },
] as unknown as import("@/shared/api/catalog").OrderType[];

const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
] as unknown as import("@/shared/api/catalog").Pool[];

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

it("业务字典按账号流转、资金动作和账务动作三层结构渲染", async () => {
  renderLight(<SettingsPage />, { user: "admin" });

  // 三层分组结构渲染（结构断言，不锁具体文案）
  expect(document.querySelectorAll(".business-dictionary__group").length).toBeGreaterThanOrEqual(3);
  // 动作行数量健康，防止整段误删
  expect(document.querySelectorAll(".business-dictionary__action-line").length).toBeGreaterThan(10);
});

it("业务字典在分润规则下方展示取消模型", async () => {
  renderLight(<SettingsPage />, { user: "admin" });

  const profitRule = await screen.findByText("分润规则");
  const cancellationModel = screen.getByText("取消模型");
  expect(profitRule.compareDocumentPosition(cancellationModel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("回收/提号未售出")).toBeInTheDocument();
  expect(screen.getByText("已售出")).toBeInTheDocument();
});

it("业务字典展示账号入库规则：未售出禁止重复，已售出允许回流复购", () => {
  renderLight(<SettingsPage />, { user: "admin" });

  expect(screen.getByText("入库规则")).toBeInTheDocument();
  expect(screen.getByText(/只要历史账号仍未售出，就禁止重复入库/)).toBeInTheDocument();
  expect(screen.getByText(/历史账号已售出后，重复建单视为账号回流/)).toBeInTheDocument();
  expect(
    screen.getByText("取消模型").compareDocumentPosition(screen.getByText("入库规则")) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
