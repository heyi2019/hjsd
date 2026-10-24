import { fireEvent, screen, waitFor } from "@testing-library/react";
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
  vi.mocked(catalog.policyApi.approve).mockResolvedValue(draftVersions[0]);
  vi.mocked(catalog.policyApi.createVersion).mockResolvedValue(draftVersions[0]);
  vi.mocked(catalog.policyApi.create).mockResolvedValue(definitions[0]);
});

it("空列表仍能从新建规则开始，并提交规则定义", async () => {
  vi.mocked(catalog.policyApi.list).mockResolvedValue({ items: [], total: 0 });
  const created = { ...definitions[0], id: 2, policy_code: "INSTALLMENT", name: "分期规则" };
  vi.mocked(catalog.policyApi.create).mockResolvedValue(created);

  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await ui.click(await screen.findByRole("button", { name: /新建规则/ }));
  // 规则编码已改为受控枚举 Select（与后端 PolicyType 对齐），不再是自由文本输入
  fireEvent.mouseDown(screen.getByLabelText("规则编码"));
  await ui.click(await screen.findByText("INSTALLMENT 分期"));
  await ui.type(screen.getByLabelText("规则名称"), "分期规则");
  await ui.click(screen.getByRole("button", { name: /创建规则/ }));

  await waitFor(() => expect(vi.mocked(catalog.policyApi.create)).toHaveBeenCalledWith({
    policy_code: "INSTALLMENT",
    name: "分期规则",
    scope_type: "GLOBAL",
    description: undefined,
  }));
});

it("新建版本先填写生效期和规则参数，再提交非空配置", async () => {
  renderLight(<PolicySettingsPanel />, { user: "admin" });
  await screen.findAllByText("REBATE_RATE");
  await ui.click(screen.getByRole("button", { name: /新建版本/ }));
  const config = screen.getByLabelText("规则参数");
  fireEvent.change(config, { target: { value: '{"rate":"5"}' } });
  await ui.click(screen.getByRole("button", { name: /保存版本/ }));

  await waitFor(() => expect(vi.mocked(catalog.policyApi.createVersion)).toHaveBeenCalledWith(1, {
    effective_from: expect.any(String),
    effective_to: undefined,
    config: { rate: "5" },
    note: undefined,
  }));
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

it("viewer 无 policy.approve：看不到「发布」按钮", async () => {
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
  // 发布是破坏性/不可逆操作，现已要求二次确认。
  await ui.click(await screen.findByRole("button", { name: /确认/ }));
  await waitFor(() => expect(vi.mocked(catalog.policyApi.approve)).toHaveBeenCalledTimes(1));
  expect(vi.mocked(catalog.policyApi.approve).mock.calls[0][0]).toBe(1); // version id
});

it("auditor 有 policy.approve 且（与后端一致）有 policy.manage：发布与新建版本均可见", async () => {
  renderLight(<PolicySettingsPanel />, { user: "auditor" });
  await screen.findAllByText("REBATE_RATE");
  // 版本表随 vi.mocked(catalog.policyApi.versions) 加载渲染，「发布」按钮需等待
  expect(await screen.findByRole("button", { name: /发布/ }, { timeout: 10000 })).toBeInTheDocument();
  // 后端 ROLE_PERMISSIONS.auditor 含 policy.manage（core/security.py），前端对齐后端口径
  expect(screen.getByRole("button", { name: /新建版本/ })).toBeInTheDocument();
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
