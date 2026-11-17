import { gameTypesApi } from "@/shared/api/misc.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { orderFormFieldsApi, orderTypesApi } from "@/shared/api/orders.api";
import { policyApi } from "@/shared/api/policy.api";
import { poolsApi } from "@/shared/api/pools.api";
import type { Pool } from "@/shared/api/types/finance";
import type { OrderType } from "@/shared/api/types/orders";
vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;
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
import { listResponse, optionSetList } from "@fixtures/api-responses";

const orderTypes = [
  { id: 1, code: "HS", name: "回收", is_active: true },
] as unknown as import("@/shared/api/types/orders").OrderType[];

const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
] as unknown as import("@/shared/api/types/finance").Pool[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(orderTypesApi.list).mockResolvedValue(orderTypes);
  vi.mocked(poolsApi.list).mockResolvedValue(pools);
  vi.mocked(optionSetsApi.list).mockResolvedValue(optionSetList());
  vi.mocked(gameTypesApi.list).mockResolvedValue([]);
  vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
  vi.mocked(policyApi.list).mockResolvedValue(listResponse([]));
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
