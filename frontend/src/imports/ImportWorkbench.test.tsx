import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { ImportWorkbench } from "./ImportWorkbench";

const batches = vi.fn();
const rows = vi.fn();
const preview = vi.fn();
const reconciliation = vi.fn();
const map = vi.fn();
const skip = vi.fn();
const markUnlinked = vi.fn();
const commit = vi.fn();
const rollback = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  importsApi: {
    batches: (...a: unknown[]) => batches(...a),
    rows: (...a: unknown[]) => rows(...a),
    preview: (...a: unknown[]) => preview(...a),
    reconciliation: (...a: unknown[]) => reconciliation(...a),
    map: (...a: unknown[]) => map(...a),
    skip: (...a: unknown[]) => skip(...a),
    markUnlinked: (...a: unknown[]) => markUnlinked(...a),
    commit: (...a: unknown[]) => commit(...a),
    rollback: (...a: unknown[]) => rollback(...a),
  },
}));

const batch = {
  id: 1,
  batch_no: "MIG-01-01",
  source_name: "7月对账单",
  source_kind: "xlsx",
  status: "DRAFT",
  row_count: 2,
  unmapped_count: 0,
} as unknown as import("../shared/api/catalog").ImportBatch;

const importRows = [
  { id: 10, batch_id: 1, row_no: 1, raw: { 金额: "100" }, status: "PENDING", unlinked_transfer: false },
  { id: 11, batch_id: 1, row_no: 2, raw: { 金额: "200" }, status: "PENDING", unlinked_transfer: false },
] as unknown as import("../shared/api/catalog").ImportRow[];

const mappingPreview = {
  batch_id: 1,
  batch_no: "MIG-01-01",
  source_name: "7月对账单",
  total_rows: 2,
  columns: [
    { source_column: "金额", target_field: "amount", suggested: true, present_count: 2, filled_count: 2, fill_rate: 1, samples: ["100", "200"] },
  ],
  abnormal: { empty_value: 0, unmapped: 0 },
  blockers: [],
} as unknown as import("../shared/api/catalog").MappingPreview;

const recon = {
  batch_id: 1,
  batch_no: "MIG-01-01",
  source_name: "7月对账单",
  status: "DRAFT",
  generated_at: "2026-10-12",
  rows: { source_total: 2, imported: 2, mapped_not_imported: 0, unmapped: 0, skipped: 0, unlinked_transfer: 0, unaccounted: 0 },
  amounts: { before: { 权益: "100.00" }, after: { 权益: "100.00" }, delta: { 权益: "0.00" } },
  funds: { cashflow_written: 0, linked_event_cashflow: 0, note: "不写现金流" },
  requires_adjudication: false,
} as unknown as import("../shared/api/catalog").ReconciliationReport;

beforeEach(() => {
  batches.mockResolvedValue({ items: [batch], total: 1 });
  rows.mockResolvedValue({ items: importRows, total: importRows.length });
  preview.mockResolvedValue(mappingPreview);
  reconciliation.mockResolvedValue(recon);
  map.mockResolvedValue({});
  skip.mockResolvedValue({});
  markUnlinked.mockResolvedValue({});
  commit.mockResolvedValue({ imported: 2, unmapped: 0 });
  rollback.mockResolvedValue({});
});

it("渲染标题 + 默认批次加载列表 + 三个工作 Tab", async () => {
  renderApp(<ImportWorkbench />, { user: "admin" });
  expect(await screen.findByText("导入工作台")).toBeInTheDocument();
  // 默认批次详情加载：原始行表格出现（raw 渲染 "金额=100"；操作列出现「指派」）
  expect(await screen.findByText("金额=100")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /指派/ }).length).toBeGreaterThan(0);
  // 顶部 StatRow
  expect(screen.getByText("源行数")).toBeInTheDocument();
  // 三个 Tab（标签文案以组件为准）
  expect(screen.getByRole("tab", { name: "原始行与指派" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "映射预览" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "导入对账" })).toBeInTheDocument();
});

it("viewer 角色无 import.manage：看不到指派/确认批次/回滚按钮", async () => {
  renderApp(<ImportWorkbench />, { user: "viewer" });
  await screen.findByText("导入工作台");
  expect(screen.queryByRole("button", { name: /指派/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /确认批次/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /回滚/ })).toBeNull();
});

it("人工指派：admin 点指派 → 填补录依据 → 确认指派 调用 map（basis 必填）", async () => {
  renderApp(<ImportWorkbench />, { user: "admin" });
  await screen.findByText("金额=100"); // 行已加载
  const assignBtns = screen.getAllByRole("button", { name: /指派/ });
  await userEvent.click(assignBtns[0]);
  await screen.findByText(/人工指派 · 第 1 行/); // 抽屉标题（避免与卡片说明段重复）
  await userEvent.type(
    screen.getByPlaceholderText("如：对账单 7 月第 9 行 / 客户确认记录"),
    "对账单 7 月第 9 行",
  );
  await userEvent.click(screen.getByRole("button", { name: /确认指派/ }));
  await waitFor(() => expect(map).toHaveBeenCalledTimes(1));
  expect(map.mock.calls[0][0]).toBe(10); // 行 id
  expect(map.mock.calls[0][1]).toMatchObject({ basis: "对账单 7 月第 9 行" });
});

it("提交批次：DRAFT 状态可提交，admin 点确认批次 调用 commit", async () => {
  renderApp(<ImportWorkbench />, { user: "admin" });
  await screen.findByText("导入工作台");
  const commitBtn = screen.getByRole("button", { name: /确认批次/ });
  expect(commitBtn).not.toBeDisabled();
  await userEvent.click(commitBtn);
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
  expect(commit.mock.calls[0][0]).toBe(1); // batch id
});

it("导入对账 Tab：切换后渲染对账 StatCard（源总行/已导入）", async () => {
  renderApp(<ImportWorkbench />, { user: "admin" });
  await screen.findByText("导入工作台");
  await userEvent.click(screen.getByRole("tab", { name: "导入对账" }));
  // 该 Tab 内的 StatCard 标签（区别于顶部 StatRow 的「源行数」）
  const panel = screen.getByRole("tabpanel", { name: "导入对账" });
  expect(within(panel).getByText("源总行")).toBeInTheDocument();
  expect(within(panel).getByText("已导入")).toBeInTheDocument();
});
