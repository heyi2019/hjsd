import { act, fireEvent, within, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appMessage as message } from "../shared/ui/appFeedback";
import { renderLight } from "../test/render";
import { ImportWorkbench } from "./ImportWorkbench";
import { resolveMock } from "../test/mock-api";

import * as catalog from "../shared/api/catalog";
import { seedOptionSets } from "../test/formFieldsSeed";
import type { ImportBatch, ImportRow, MappingPreview, ReconciliationReport } from "../shared/api/catalog";

let ui: ReturnType<typeof userEvent.setup>;

vi.mock("../shared/api/catalog");

const batch = {
  id: 1,
  batch_no: "MIG-01-01",
  source_name: "7月对账单",
  source_kind: "xlsx",
  status: "DRAFT",
  row_count: 2,
  unmapped_count: 0,
} as unknown as ImportBatch;

const makeRow = (over: Partial<ImportRow> = {}): ImportRow =>
  ({
    id: 10,
    batch_id: 1,
    row_no: 1,
    raw: { 金额: "100" },
    status: "PENDING",
    unlinked_transfer: false,
    ...over,
  }) as unknown as ImportRow;

const preview = (over: Partial<MappingPreview> = {}): MappingPreview =>
  ({
    batch_id: 1,
    batch_no: "MIG-01-01",
    source_name: "7月对账单",
    total_rows: 2,
    columns: [
      { source_column: "金额", target_field: "amount", suggested: true, present_count: 2, filled_count: 2, fill_rate: 1, samples: ["100"] },
      { source_column: "未知列", target_field: null, suggested: false, present_count: 2, filled_count: 0, fill_rate: 0, samples: [] },
    ],
    abnormal: { empty_value: 0, unmapped: 0 },
    blockers: [],
    ...over,
  }) as unknown as MappingPreview;

const recon = (over: Partial<ReconciliationReport> = {}): ReconciliationReport =>
  ({
    batch_id: 1,
    batch_no: "MIG-01-01",
    source_name: "7月对账单",
    status: "DRAFT",
    generated_at: "2026-10-12",
    rows: { source_total: 2, imported: 2, mapped_not_imported: 0, unmapped: 0, skipped: 0, unlinked_transfer: 0, unaccounted: 0 },
    amounts: { before: { 权益: "100.00" }, after: { 权益: "100.00" }, delta: { 权益: "0.00" } },
    funds: { cashflow_written: 0, linked_event_cashflow: 0, note: "不写现金流" },
    requires_adjudication: false,
    ...over,
  }) as unknown as ReconciliationReport;

function setDefaults() {
  resolveMock(vi.mocked(catalog.importsApi.batches), { items: [batch], total: 1 });
  resolveMock(vi.mocked(catalog.importsApi.rows), { items: [makeRow()], total: 1 });
  resolveMock(vi.mocked(catalog.importsApi.preview), preview());
  resolveMock(vi.mocked(catalog.importsApi.reconciliation), recon());
  resolveMock(vi.mocked(catalog.importsApi.map), {});
  resolveMock(vi.mocked(catalog.importsApi.skip), {});
  resolveMock(vi.mocked(catalog.importsApi.markUnlinked), {});
  resolveMock(vi.mocked(catalog.importsApi.commit), {});
  resolveMock(vi.mocked(catalog.importsApi.rollback), {});
  resolveMock(vi.mocked(catalog.importsApi.reject), {});
  resolveMock(vi.mocked(catalog.importsApi.createBatch), {
    id: 2,
    batch_no: "MIG-01-02",
    status: "DRAFT",
    row_count: 1,
    unmapped_count: 0,
    source_name: "新导入",
  });
}

beforeEach(() => {
  seedOptionSets(catalog);
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
  setDefaults();
});

async function openWorkbench(rows: ImportRow[] = [makeRow()]) {
  if (rows.length) {
    resolveMock(vi.mocked(catalog.importsApi.rows), { items: rows, total: rows.length });
  }
  renderLight(<ImportWorkbench />, { user: "admin" });
  await screen.findByText("导入工作台");
  await waitFor(() => expect(document.querySelector("tbody tr")).toBeTruthy());
}

/** 异步取表格行：等首数据行渲染完成，避免 tabpanel/渲染时序导致的 undefined。
 *  antd 在 tbody 首行渲染隐藏的 ant-table-measure-row（列宽测量用，aria-hidden），
 *  必须用真实数据行选择器 .ant-table-row 跳过它，否则 [0] 命中空测量行，
 *  其内无任何按钮/状态文本，导致 within(row).getBy… 全数失败（2026-10-27 实测）。 */
async function rowAt(index: number): Promise<HTMLElement> {
  let el: HTMLElement | undefined;
  await waitFor(() => {
    const rows = Array.from(
      document.querySelectorAll("tbody tr.ant-table-row"),
    ) as HTMLElement[];
    el = rows[index];
    expect(el).toBeTruthy();
  });
  return el!;
}

async function switchTab(name: string) {
  await ui.click(screen.getByRole("tab", { name }));
  await waitFor(() => expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true"));
}

/** Modal 渲染到 document.body 的 portal，不在 RTL container 内。 */
async function openImportModal() {
  await ui.click(screen.getByRole("button", { name: /新建导入/ }));
  await screen.findByText("导入导入数据");
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

/** 受控 fileList 的 antd Upload：直接给 input 赋 files 再派发 change，
 *  比 userEvent.upload 稳定（后者会受 accept 过滤影响且不易触发受控变更）。 */
/** jsdom 内 File(Blob).prototype.text 可能未实现，实例级覆盖保证 await file.text() 确定可用，
 *  否则组件里的 await originFileObj.text() 会抛 TypeError 被 catch 成错误横幅，createBatch 不会被调用。 */
function makeFile(parts: BlobPart[], name: string, opts: FilePropertyBag) {
  const content = String(parts[0] ?? "");
  const file = new File([content], name, opts) as File & { text: () => Promise<string> };
  file.text = () => Promise.resolve(content);
  return file;
}

async function attachFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true, writable: true });
  // rc-upload 的 processFile 是 Promise 链（beforeUpload 之后才回调 antd 的 onChange），
  // 必须 await act 冲刷微任务，否则受控 fileList 还没写入就去点「开始导入」。
  await act(async () => {
    fireEvent.change(input);
  });
}

async function fillImportBase(name: string) {
  await ui.type(screen.getByLabelText("数据名称"), name);
}

describe("ImportWorkbench：操作分支补充", () => {
  it("标记单边划转：填说明后调用 importsApi.markUnlinked", async () => {
    await openWorkbench();
    const row = await rowAt(0);
    await ui.click(within(row).getByRole("button", { name: /标单边划转/ }));
    await screen.findByText("标记单边划转 · 第 1 行");
    await ui.type(screen.getByLabelText("说明"), "对手方未明确");
    await ui.click(screen.getByRole("button", { name: /确认标记/ }));
    await waitFor(() => expect(catalog.importsApi.markUnlinked).toHaveBeenCalledWith(10, "对手方未明确"));
  });

  it("跳过：填理由后调用 importsApi.skip", async () => {
    await openWorkbench();
    const row = await rowAt(0);
    await ui.click(within(row).getByRole("button", { name: /跳过/ }));
    await screen.findByText("跳过 · 第 1 行");
    await ui.type(screen.getByLabelText("跳过理由"), "重复数据");
    await ui.click(screen.getByRole("button", { name: /确认跳过/ }));
    await waitFor(() => expect(catalog.importsApi.skip).toHaveBeenCalledWith(10, "重复数据"));
  });

  it("回滚批次：填理由后调用 importsApi.rollback", async () => {
    await openWorkbench();
    await ui.click(screen.getByRole("button", { name: /回滚/ }));
    await screen.findByText("回滚批次 · MIG-01-01");
    await ui.type(screen.getByLabelText("回滚理由"), "误导入");
    await ui.click(screen.getByRole("button", { name: /确认回滚/ }));
    await waitFor(() => expect(catalog.importsApi.rollback).toHaveBeenCalledWith(1, "误导入"));
  });

  it("驳回批次：填理由后调用 importsApi.reject（终态，不再提交）", async () => {
    await openWorkbench();
    await ui.click(screen.getByRole("button", { name: /驳\s*回/ }));
    await screen.findByText("驳回批次 · MIG-01-01");
    await ui.type(screen.getByLabelText("驳回理由"), "源文件口径错误");
    await ui.click(screen.getByRole("button", { name: /确认驳回/ }));
    await waitFor(() =>
      expect(catalog.importsApi.reject).toHaveBeenCalledWith(1, "源文件口径错误"),
    );
  });

  it("已回滚行的操作按钮全部禁用", async () => {    await openWorkbench([makeRow({ status: "ROLLED_BACK" })]);
    const row = await rowAt(0);
    expect(within(row).getByRole("button", { name: /指派/ })).toBeDisabled();
    expect(within(row).getByRole("button", { name: /标单边划转/ })).toBeDisabled();
    expect(within(row).getByRole("button", { name: /跳过/ })).toBeDisabled();
  });

  it("单边划转行渲染未裁决且标记按钮禁用", async () => {
    await openWorkbench([makeRow({ unlinked_transfer: true })]);
    const row = await rowAt(0);
    expect(within(row).getByText("未裁决")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /标单边划转/ })).toBeDisabled();
  });

  it("批次无行时显示空态文案", async () => {
    resolveMock(vi.mocked(catalog.importsApi.rows), { items: [], total: 0 });
    renderLight(<ImportWorkbench />, { user: "admin" });
    expect(await screen.findByText("该批次暂无行")).toBeInTheDocument();
  });

  it("映射预览 Tab 渲染源列/建议目标字段/填充率", async () => {
    await openWorkbench();
    await switchTab("映射预览");
    const panel = screen.getByRole("tabpanel", { name: "映射预览" });
    expect(within(panel).getByText("金额")).toBeInTheDocument();
    expect(within(panel).getByText("未识别")).toBeInTheDocument();
    // 填充率渲染为 `${fill_rate}%`
    expect(within(panel).getByText("1%")).toBeInTheDocument();
  });

  it("映射预览存在阻断列时显示阻断横幅", async () => {
    resolveMock(vi.mocked(catalog.importsApi.preview), preview({ blockers: ["未知列"] }));
    await openWorkbench();
    await switchTab("映射预览");
    expect(await screen.findByText(/阻断确认：未知列/)).toBeInTheDocument();
  });

  it("对账 Tab 渲染金额项/导入前/导入后/差异", async () => {
    await openWorkbench();
    await switchTab("导入对账");
    const panel = screen.getByRole("tabpanel", { name: "导入对账" });
    expect(within(panel).getByText("权益")).toBeInTheDocument();
    // MoneyText 不带货币符号，仅渲染 money() 千分位结果
    expect(within(panel).getAllByText("100.00").length).toBeGreaterThan(0);
    expect(within(panel).getByText("不写现金流")).toBeInTheDocument();
  });

  it("对账需要裁决时显示未裁决横幅", async () => {
    resolveMock(vi.mocked(catalog.importsApi.reconciliation), recon({ requires_adjudication: true }));
    await openWorkbench();
    await switchTab("导入对账");
    expect(await screen.findByText(/差异须裁决后方可上线/)).toBeInTheDocument();
  });

  it("新建导入：未选择文件时提示", async () => {
    await openWorkbench();
    await openImportModal();
    await fillImportBase("2026年10月订单");
    await ui.click(screen.getByRole("button", { name: /开始导入/ }));
    await waitFor(() => expect(message.error).toHaveBeenCalledWith("请选择 JSON 或 CSV 文件"));
  });

  it("FE-063：PNG 在上传阶段被拒绝，不进入导入批次", async () => {
    await openWorkbench();
    const fileInput = await openImportModal();
    await attachFile(fileInput, makeFile(["not-a-table"], "account-image.png", { type: "image/png" }));
    expect(message.error).toHaveBeenCalledWith("只支持 JSON 或 CSV 文件");
    expect(catalog.importsApi.createBatch).not.toHaveBeenCalled();
  });

  it("新建导入：上传 CSV 后解析为原始行并创建批次", async () => {
    await openWorkbench();
    const fileInput = await openImportModal();
    await fillImportBase("2026年10月订单");
    await attachFile(fileInput, makeFile(["订单日期,金额\n2026-01-31,100\n"], "orders.csv", { type: "text/csv" }));
    await ui.click(screen.getByRole("button", { name: /开始导入/ }));
    await waitFor(() => expect(catalog.importsApi.createBatch).toHaveBeenCalled());
    const payload = vi.mocked(catalog.importsApi.createBatch).mock.calls[0][0];
    expect(payload.source_name).toBe("2026年10月订单");
    expect(payload.rows).toEqual([{ 订单日期: "2026-01-31", 金额: "100" }]);
    expect(message.success).toHaveBeenCalledWith("已导入 1 行数据");
  });

  it("新建导入：数据类型可选「需求」（STANDARD_LEAD）并随批次提交", async () => {
    await openWorkbench();
    const fileInput = await openImportModal();
    await fillImportBase("2026年10月需求");
    fireEvent.mouseDown(screen.getByLabelText("数据类型"));
    await ui.click(await screen.findByText("需求"));
    await attachFile(fileInput, makeFile(["客户ID,需求内容\n1,求购账号\n"], "leads.csv", { type: "text/csv" }));
    await ui.click(screen.getByRole("button", { name: /开始导入/ }));
    await waitFor(() => expect(catalog.importsApi.createBatch).toHaveBeenCalled());
    expect(vi.mocked(catalog.importsApi.createBatch).mock.calls[0][0].source_kind).toBe("STANDARD_LEAD");
  });

  it("新建导入：上传 JSON 数组走 JSON 解析分支", async () => {
    await openWorkbench();
    const fileInput = await openImportModal();
    await fillImportBase("JSON 批次");
    await attachFile(fileInput, makeFile(['[{"金额":"100"}]'], "rows.json", { type: "application/json" }));
    await ui.click(screen.getByRole("button", { name: /开始导入/ }));
    await waitFor(() => expect(catalog.importsApi.createBatch).toHaveBeenCalled());
    expect(vi.mocked(catalog.importsApi.createBatch).mock.calls[0][0].rows).toEqual([{ 金额: "100" }]);
  });

  it("新建导入：非对象数组的 JSON 给出解析错误", async () => {
    await openWorkbench();
    const fileInput = await openImportModal();
    await fillImportBase("坏 JSON");
    await attachFile(fileInput, makeFile(['{"金额":"100"}'], "rows.json", { type: "application/json" }));
    await ui.click(screen.getByRole("button", { name: /开始导入/ }));
    // 同一错误同时出现在 Modal 内 InlineError 与页面 ErrorBanner
    expect((await screen.findAllByText(/JSON 文件必须是对象数组/)).length).toBeGreaterThan(0);
  });

  it("下载当前类型导入模板：创建 Blob 链接、触发下载并给出成功反馈（L286）", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await openWorkbench();
    await openImportModal();
    await ui.click(screen.getByRole("button", { name: /下载当前类型导入模板/ }));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(message.success).toHaveBeenCalledWith(expect.stringContaining("已开始下载"));
    clickSpy.mockRestore();
  });

  it("批次列表加载失败显示错误横幅", async () => {
    vi.mocked(catalog.importsApi.batches).mockRejectedValue(new Error("batches down"));
    renderLight(<ImportWorkbench />, { user: "admin" });
    expect(await screen.findByText(/batches down/)).toBeInTheDocument();
  });

  it("嵌入模式：不重复输出页面大标题但保留操作条", async () => {
    renderLight(<ImportWorkbench embedded />, { user: "admin" });
    await waitFor(() => expect(screen.getByRole("button", { name: /新建导入/ })).toBeInTheDocument());
    expect(screen.queryByText("导入工作台")).toBeNull();
    expect(screen.getByText(/导入数据只保留原文与人工映射/)).toBeInTheDocument();
  });
});
