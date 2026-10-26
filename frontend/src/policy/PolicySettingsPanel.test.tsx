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

vi.mock("../shared/api/catalog");

vi.mock("../shared/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { LightweightDataTable } = await import("../test/LightweightDataTable");
  return { ...actual, DataTable: LightweightDataTable };
});

// 系统预置：规则定义是闭集，由 seed 脚本创建；页面只管版本与发布。
// policy_code 用真实值 REBATE，使结构化表单（返点比例字段）能正确套用。
const definitions = [
  { id: 1, policy_code: "REBATE", name: "返点比例", scope_type: "GLOBAL", scope_id: null, status: "ACTIVE" },
] as unknown as import("../shared/api/catalog").PolicyDefinition[];

// 版本一经「设置配置」即发布（ACTIVE），页面不再保留草稿态（2026-10-26 起无独立审核）。
const activeVersions = [
  { id: 1, policy_definition_id: 1, version: 1, effective_from: "2026-01-01", effective_to: null, config: { rate: "0" }, status: "ACTIVE", approved_by: "admin", approved_at: null, note: null },
] as unknown as import("../shared/api/catalog").PolicyVersion[];

beforeEach(() => {
  vi.mocked(catalog.policyApi.list).mockResolvedValue({ items: definitions, total: definitions.length });
  vi.mocked(catalog.policyApi.versions).mockResolvedValue({ items: activeVersions, total: activeVersions.length });
  vi.mocked(catalog.policyApi.approve).mockResolvedValue(activeVersions[0]);
  vi.mocked(catalog.policyApi.createVersion).mockResolvedValue(activeVersions[0]);
});

it("规则定义为系统预置闭集：页面不提供「新建规则」入口", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("返点比例");
  // 编码由后端 PolicyType 固定，定义只由预置脚本创建；页面只管版本与发布
  expect(screen.queryByRole("button", { name: /新建规则/ })).toBeNull();
  expect(vi.mocked(catalog.policyApi.create)).not.toHaveBeenCalled();
});

it("配置项标注生效状态：返点费率标「参与计算」，计算基数标「仅留痕」", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("返点比例");
  await ui.click(screen.getByRole("button", { name: /设置配置/ }));

  // 分方向费率 + 统一费率：后端 rebates.py:167 真读，标 calc
  expect(await screen.findAllByText("参与计算")).toHaveLength(2);
  // 计算基数后端由调用方传参，不读规则，标 snapshot
  expect(screen.getAllByText("仅留痕")).toHaveLength(1);
});

it("设置配置：填写生效期和结构化字段后提交，生成新版本并立即发布", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("返点比例");
  await ui.click(screen.getByRole("button", { name: /设置配置/ }));
  // 结构化字段由 schema 驱动：REBATE → 统一返点比例（percent 控件）
  const rate = screen.getByLabelText("统一返点比例");
  fireEvent.change(rate, { target: { value: "5" } });
  await ui.click(screen.getByRole("button", { name: /保存/ }));

  await waitFor(() => expect(vi.mocked(catalog.policyApi.createVersion)).toHaveBeenCalledWith(1, {
    effective_from: expect.any(String),
    effective_to: undefined,
    config: { rate: "5" },
    note: undefined,
  }));
  // 保存即发布：不再有独立审核环节，创建版本后立即发布（发布人取当前登录用户）
  await waitFor(() => expect(vi.mocked(catalog.policyApi.approve)).toHaveBeenCalledWith(1, {}));
});

it("设置配置：按返点方向分别填写时提交 rates 子对象（引擎真实支持的形状）", async () => {
  // 无历史版本 → 表单不回填，断言只反映本次填写。
  vi.mocked(catalog.policyApi.versions).mockResolvedValue({ items: [], total: 0 });
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("返点比例");
  await ui.click(screen.getByRole("button", { name: /设置配置/ }));

  fireEvent.change(screen.getByLabelText("买入返点"), { target: { value: "5" } });
  fireEvent.change(screen.getByLabelText("卖出返点"), { target: { value: "3" } });
  await ui.click(screen.getByRole("button", { name: /保存/ }));

  await waitFor(() => expect(vi.mocked(catalog.policyApi.createVersion)).toHaveBeenCalledWith(1, {
    effective_from: expect.any(String),
    effective_to: undefined,
    config: { rates: { BUY: "5", SELL: "3" } },
    note: undefined,
  }));
});

it("未定义字段的规则：保存按钮禁用并说明不可配置（避免提交空 config 被后端拒绝）", async () => {
  const custom = [
    { id: 9, policy_code: "CUSTOM_X", name: "自定义规则", scope_type: "GLOBAL", scope_id: null, status: "ACTIVE" },
  ] as unknown as import("../shared/api/catalog").PolicyDefinition[];
  vi.mocked(catalog.policyApi.list).mockResolvedValue({ items: custom, total: 1 });
  vi.mocked(catalog.policyApi.versions).mockResolvedValue({ items: [], total: 0 });

  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("自定义规则");
  await ui.click(screen.getByRole("button", { name: /设置配置/ }));

  expect(await screen.findByText(/暂无可配置参数/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /保存/ })).toBeDisabled();
});

it("渲染经营规则标题、统计卡与左侧规则清单，并默认加载首个规则的版本", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  expect(await screen.findByText("经营规则")).toBeInTheDocument();
  // StatRow：规则总数 / 已发布 / 草稿版本（kind=count 满足 ui_guard）
  expect(screen.getByText("规则总数")).toBeInTheDocument();
  // 统计卡与版本表格都会出现「已发布」：版本状态改由 POLICY_STATUS 词典承载。
  expect(screen.getAllByText("已发布").length).toBeGreaterThan(0);
  // 左侧规则清单展示该规则
  expect((await screen.findAllByText("返点比例")).length).toBeGreaterThan(0);
  // 默认选中首个定义 → vi.mocked(catalog.policyApi.versions) 被调用
  await waitFor(() => expect(vi.mocked(catalog.policyApi.versions)).toHaveBeenCalledWith(1));
});

it("admin 可见「设置配置」", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  expect((await screen.findAllByText("返点比例")).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: /设置配置/ })).toBeInTheDocument();
});

it("viewer 无 policy.manage：看不到「设置配置」", async () => {
  renderLight(<PolicySettingsPanel />, { user: "viewer" });
  await screen.findAllByText("返点比例");
  expect(screen.queryByRole("button", { name: /设置配置/ })).toBeNull();
});

it("已发布版本不可再编辑/发布：页面不暴露「编辑」「发布」按钮", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("返点比例");
  expect(screen.queryByRole("button", { name: /编辑/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /发布/ })).toBeNull();
});

it("auditor 有 policy.manage：可见「设置配置」", async () => {
  renderLight(<PolicySettingsPanel />, { user: "auditor" });
  await screen.findAllByText("返点比例");
  expect(screen.getByRole("button", { name: /设置配置/ })).toBeInTheDocument();
});

it("生效期自查：选编码与日期后调用 resolve 并展示命中版本", async () => {
  vi.mocked(catalog.policyApi.resolve).mockResolvedValue({
    found: true,
    version: { id: 7, policy_definition_id: 1, version: 3, effective_from: "2026-01-01", effective_to: null, config: { rate: "5" }, status: "ACTIVE", approved_by: "admin", approved_at: null, note: null },
  } as unknown as { found: boolean; version: import("../shared/api/catalog").PolicyVersion | null });
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("返点比例");
  await ui.click(screen.getByRole("button", { name: /生效期自查/ }));
  // 规则编码默认取当前选中规则（REBATE），无需重选；直接解析。
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
  await screen.findAllByText("返点比例");
  await ui.click(screen.getByRole("button", { name: /生效期自查/ }));
  await ui.click(screen.getByRole("button", { name: /解析/ }));
  expect(await screen.findByText(/没有生效的规则版本/)).toBeInTheDocument();
});
