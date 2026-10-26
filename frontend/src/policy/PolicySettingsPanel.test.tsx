import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { PolicySettingsPanel } from "./PolicySettingsPanel";

import * as catalog from "../shared/api/catalog";
import { seedOptionSets } from "../test/formFieldsSeed";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.clearAllMocks();
  seedOptionSets(catalog);
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

// 系统预置：版本一经「设置配置」即发布（ACTIVE），页面不再保留草稿态。
const activeVersions = [
  { id: 1, policy_definition_id: 1, version: 1, effective_from: "2026-01-01", effective_to: null, config: { rate: "0" }, status: "ACTIVE", approved_by: "system", approved_at: null, note: null },
] as unknown as import("../shared/api/catalog").PolicyVersion[];

beforeEach(() => {
  vi.mocked(catalog.policyApi.list).mockResolvedValue({ items: definitions, total: definitions.length });
  vi.mocked(catalog.policyApi.versions).mockResolvedValue({ items: activeVersions, total: activeVersions.length });
  vi.mocked(catalog.policyApi.approve).mockResolvedValue(activeVersions[0]);
  vi.mocked(catalog.policyApi.createVersion).mockResolvedValue(activeVersions[0]);
});

it("规则定义为系统预置闭集：页面不提供「新建规则」入口", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("REBATE_RATE");
  // 编码由后端 PolicyType 固定，定义只由预置脚本创建；页面只管版本与发布
  expect(screen.queryByRole("button", { name: /新建规则/ })).toBeNull();
  expect(vi.mocked(catalog.policyApi.create)).not.toHaveBeenCalled();
});

it("设置配置：填写生效期和规则参数后提交非空配置，生成新版本并发布", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("REBATE_RATE");
  await ui.click(screen.getByRole("button", { name: /设置配置/ }));
  const config = screen.getByLabelText("规则参数");
  fireEvent.change(config, { target: { value: '{"rate":"5"}' } });
  await ui.click(screen.getByRole("button", { name: /保存并发布/ }));

  await waitFor(() => expect(vi.mocked(catalog.policyApi.createVersion)).toHaveBeenCalledWith(1, {
    effective_from: expect.any(String),
    effective_to: undefined,
    config: { rate: "5" },
    note: undefined,
  }));
  // 保存即发布：不再停留草稿态，避免规则建了却因未发布而解析不到
  await waitFor(() => expect(vi.mocked(catalog.policyApi.approve)).toHaveBeenCalledWith(1, {}));
});

it("渲染经营规则标题、统计卡与规则定义表格，并默认加载首个规则的版本", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  expect(await screen.findByText("经营规则")).toBeInTheDocument();
  // StatRow：规则总数 / 已发布 / 草稿版本（kind=count 满足 ui_guard）
  expect(screen.getByText("规则总数")).toBeInTheDocument();
  // 统计卡与版本表格都会出现「已发布」：版本状态改由 POLICY_STATUS 词典承载后，
  // 表格 StatusTag 从全局映射的「进行中」变为词典文案「已发布」，与统计卡口径一致。
  expect(screen.getAllByText("已发布").length).toBeGreaterThan(0);
  // 规则定义表格
  expect((await screen.findAllByText("REBATE_RATE")).length).toBeGreaterThan(0);
  // 默认选中首个定义 → vi.mocked(catalog.policyApi.versions) 被调用
  await waitFor(() => expect(vi.mocked(catalog.policyApi.versions)).toHaveBeenCalledWith(1));
});

it("admin 可见「设置配置」", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  expect((await screen.findAllByText("REBATE_RATE")).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: /设置配置/ })).toBeInTheDocument();
});

it("viewer 无 policy.manage：看不到「设置配置」", async () => {
  renderLight(<PolicySettingsPanel />, { user: "viewer" });
  await screen.findAllByText("REBATE_RATE");
  expect(screen.queryByRole("button", { name: /设置配置/ })).toBeNull();
});

it("已发布版本不可再编辑/发布：页面不暴露「编辑」「发布」按钮", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("REBATE_RATE");
  expect(screen.queryByRole("button", { name: /编辑/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /发布/ })).toBeNull();
});

it("auditor 有 policy.manage：可见「设置配置」", async () => {
  renderLight(<PolicySettingsPanel />, { user: "auditor" });
  await screen.findAllByText("REBATE_RATE");
  expect(screen.getByRole("button", { name: /设置配置/ })).toBeInTheDocument();
});

it("生效期自查：选编码与日期后调用 resolve 并展示命中版本", async () => {
  vi.mocked(catalog.policyApi.resolve).mockResolvedValue({
    found: true,
    version: { id: 7, policy_definition_id: 1, version: 3, effective_from: "2026-01-01", effective_to: null, config: { rate: "5" }, status: "ACTIVE", approved_by: "admin", approved_at: null, note: null },
  } as unknown as { found: boolean; version: import("../shared/api/catalog").PolicyVersion | null });
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("REBATE_RATE");
  await ui.click(screen.getByRole("button", { name: /生效期自查/ }));
  fireEvent.mouseDown(screen.getByLabelText("规则编码"));
  await ui.click(await screen.findByText("REBATE 返点"));
  await ui.click(screen.getByRole("button", { name: /解析/ }));
  await waitFor(() => expect(vi.mocked(catalog.policyApi.resolve)).toHaveBeenCalledWith(
    "REBATE",
    expect.any(String),
    { scope_type: "GLOBAL", scope_id: undefined },
  ));
  expect(await screen.findByText(/命中版本/)).toBeInTheDocument();
  expect(screen.getByText("v3")).toBeInTheDocument();
  expect(screen.getByText(/rate=5/)).toBeInTheDocument();
});

it("生效期自查：未命中时提示该日该作用域无生效版本", async () => {
  vi.mocked(catalog.policyApi.resolve).mockResolvedValue({ found: false, version: null });
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("REBATE_RATE");
  await ui.click(screen.getByRole("button", { name: /生效期自查/ }));
  await ui.click(screen.getByRole("button", { name: /解析/ }));
  expect(await screen.findByText(/没有生效的规则版本/)).toBeInTheDocument();
});
