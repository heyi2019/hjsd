import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { PolicySettingsPanel } from "./PolicySettingsPanel";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.clearAllMocks();
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

const list = vi.fn();
const versions = vi.fn();
const approve = vi.fn();
const createVersion = vi.fn();
const create = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  policyApi: {
    list: (...a: unknown[]) => list(...a),
    versions: (...a: unknown[]) => versions(...a),
    approve: (...a: unknown[]) => approve(...a),
    createVersion: (...a: unknown[]) => createVersion(...a),
    create: (...a: unknown[]) => create(...a),
    updateDraft: vi.fn(),
    resolve: vi.fn(),
    allocations: vi.fn(),
  },
}));

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
  list.mockResolvedValue({ items: definitions, total: definitions.length });
  versions.mockResolvedValue({ items: draftVersions, total: draftVersions.length });
  approve.mockResolvedValue({});
  createVersion.mockResolvedValue({});
  create.mockResolvedValue({});
});

it("渲染经营规则标题、统计卡与规则定义表格，并默认加载首个规则的版本", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  expect(await screen.findByText("经营规则")).toBeInTheDocument();
  // StatRow：规则总数 / 已发布 / 草稿版本（kind=count 满足 ui_guard）
  expect(screen.getByText("规则总数")).toBeInTheDocument();
  expect(screen.getByText("草稿版本")).toBeInTheDocument();
  // 规则定义表格
  expect((await screen.findAllByText("REBATE_RATE")).length).toBeGreaterThan(0);
  // 默认选中首个定义 → versions 被调用
  await waitFor(() => expect(versions).toHaveBeenCalledWith(1));
});

it("admin 可见「新建版本」；viewer 无 policy.manage 看不到", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  expect((await screen.findAllByText("REBATE_RATE")).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: /新建版本/ })).toBeInTheDocument();
});

it("viewer 无 policy.approve：看不到「发布」按钮", async () => {
  renderLight(<PolicySettingsPanel />, { user: "viewer" });
  await screen.findByText("v1", {}, { timeout: 10000 });
  expect(screen.queryByRole("button", { name: /发布/ })).toBeNull();
});

it("审批流程：admin 点「发布」（DRAFT 版本可点）→ 调用 approve", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("REBATE_RATE");
  const publish = await screen.findByRole("button", { name: /发布/ }, { timeout: 10000 });
  expect(publish).not.toBeDisabled();
  await ui.click(publish);
  await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
  expect(approve.mock.calls[0][0]).toBe(1); // version id
});

it("auditor 有 policy.approve 但无 policy.manage：可见发布、不可见新建版本", async () => {
  renderLight(<PolicySettingsPanel />, { user: "auditor" });
  await screen.findAllByText("REBATE_RATE");
  // 版本表随 versions 加载渲染，「发布」按钮需等待
  expect(await screen.findByRole("button", { name: /发布/ }, { timeout: 10000 })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /新建版本/ })).toBeNull();
});
