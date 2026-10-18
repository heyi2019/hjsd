import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { PolicySettingsPanel } from "./PolicySettingsPanel";

import * as catalog from "../shared/api/catalog";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.clearAllMocks();
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("../shared/api/catalog")

vi.mock("../shared/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { LightweightDataTable } = await import("../test/LightweightDataTable");
  return { ...actual, DataTable: LightweightDataTable };
});

const definitions = [
  { id: 1, policy_code: "REBATE_RATE", name: "返点比例", scope_type: "GLOBAL", scope_id: null, status: "ACTIVE" },
] as unknown as import("../shared/api/catalog").PolicyDefinition[];

const draftVersions = [
  { id: 1, policy_definition_id: 1, version: 1, effective_from: "2026-01-01", effective_to: null, config: {}, status: "DRAFT" },
] as unknown as import("../shared/api/catalog").PolicyVersion[];

beforeEach(() => {
  vi.mocked(catalog.policyApi.list).mockResolvedValue({ items: definitions, total: definitions.length });
  vi.mocked(catalog.policyApi.versions).mockResolvedValue({ items: draftVersions, total: draftVersions.length });
  vi.mocked(catalog.policyApi.approve).mockResolvedValue({});
  vi.mocked(catalog.policyApi.createVersion).mockResolvedValue({});
  vi.mocked(catalog.policyApi.create).mockResolvedValue({});
});

it("渲染经营规则标题、统计卡与规则定义表格，并默认加载首个规则的版本", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  expect(await screen.findByText("经营规则")).toBeInTheDocument();
  // StatRow：规则总数 / 已发布 / 草稿版本（kind=count 满足 ui_guard）
  expect(screen.getByText("规则总数")).toBeInTheDocument();
  expect(screen.getByText("草稿版本")).toBeInTheDocument();
  // 规则定义表格
  expect((await screen.findAllByText("REBATE_RATE")).length).toBeGreaterThan(0);
  // 默认选中首个定义 → vi.mocked(catalog.policyApi.versions) 被调用
  await waitFor(() => expect(vi.mocked(catalog.policyApi.versions)).toHaveBeenCalledWith(1));
});

it("admin 可见「新建版本」；viewer 无 policy.manage 看不到", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  expect((await screen.findAllByText("REBATE_RATE")).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: /新建版本/ })).toBeInTheDocument();
});

it("viewer 无 policy.vi.mocked(catalog.policyApi.approve)：看不到「发布」按钮", async () => {
  renderLight(<PolicySettingsPanel />, { user: "viewer" });
  await screen.findByText("v1", {}, { timeout: 10000 });
  expect(screen.queryByRole("button", { name: /发布/ })).toBeNull();
});

it("审批流程：admin 点「发布」（DRAFT 版本可点）→ 调用 vi.mocked(catalog.policyApi.approve)", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("REBATE_RATE");
  const publish = await screen.findByRole("button", { name: /发布/ }, { timeout: 10000 });
  expect(publish).not.toBeDisabled();
  await ui.click(publish);
  await waitFor(() => expect(vi.mocked(catalog.policyApi.approve)).toHaveBeenCalledTimes(1));
  expect(vi.mocked(catalog.policyApi.approve).mock.calls[0][0]).toBe(1); // version id
});

it("auditor 有 policy.vi.mocked(catalog.policyApi.approve) 但无 policy.manage：可见发布、不可见新建版本", async () => {
  renderLight(<PolicySettingsPanel />, { user: "auditor" });
  await screen.findAllByText("REBATE_RATE");
  // 版本表随 vi.mocked(catalog.policyApi.versions) 加载渲染，「发布」按钮需等待
  expect(await screen.findByRole("button", { name: /发布/ }, { timeout: 10000 })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /新建版本/ })).toBeNull();
});
