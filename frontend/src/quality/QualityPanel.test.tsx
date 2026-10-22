import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { QualityPanel } from "./QualityPanel";
import * as catalog from "../shared/api/catalog";
import type { QualityIssue, QualitySummary } from "../shared/api/catalog";

vi.mock("../shared/api/catalog");

const summary: QualitySummary = { total: 2, by_severity: { LOW: 0, MEDIUM: 1, HIGH: 1, CRITICAL: 0 } } as QualitySummary;
const rows: QualityIssue[] = [
  { id: 1, issue_no: "QLT-1", severity: "HIGH", title: "卡单", entity_type: "order", entity_id: "10", status: "OPEN", message: "x" },
  { id: 2, issue_no: "QLT-2", severity: "LOW", title: "小问题", entity_type: "account", entity_id: "3", status: "CLOSED", message: "y" },
];

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.qualityApi.summary).mockResolvedValue(summary);
  vi.mocked(catalog.qualityApi.list).mockResolvedValue({ items: rows });
  vi.mocked(catalog.qualityApi.create).mockResolvedValue({ id: 3 } as QualityIssue);
  vi.mocked(catalog.qualityApi.close).mockResolvedValue(rows[0]);
  vi.mocked(catalog.qualityApi.batchClose).mockResolvedValue([]);
});

describe("QualityPanel：质量中心", () => {
  it("加载并展示摘要与工单列表", async () => {
    renderLight(<QualityPanel />, { user: "admin" });
    expect(await screen.findByText("QLT-1")).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  });

  it("加载失败展示错误横幅", async () => {
    vi.mocked(catalog.qualityApi.list).mockRejectedValue(new Error("quality down"));
    vi.mocked(catalog.qualityApi.summary).mockRejectedValue(new Error("quality down"));
    renderLight(<QualityPanel />, { user: "admin" });
    expect(await screen.findByText(/quality down/)).toBeInTheDocument();
  });

  it("新建工单：打开弹窗并填写提交", async () => {
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /新建工单/ }));
    const modal = await screen.findByText("新建质量工单");
    const content = modal.closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(content).getByLabelText("异常编码"), "QLT-NEW");
    await ui.type(within(content).getByLabelText("标题"), "新异常");
    await ui.type(within(content).getByLabelText("对象类型"), "order");
    await ui.type(within(content).getByLabelText("对象编号"), "99");
    await ui.type(within(content).getByLabelText("问题描述"), "描述");
    const selector = content.querySelector(".ant-select-selector") as HTMLElement;
    await ui.click(selector);
    const dropdowns = document.querySelectorAll(".ant-select-dropdown");
    await ui.click(within(dropdowns[dropdowns.length - 1] as HTMLElement).getByText("高"));
    await ui.click(within(content).getByRole("button", { name: /创建工单/ }));
    await waitFor(() => expect(catalog.qualityApi.create).toHaveBeenCalled());
  });

  it("关闭工单：打开关闭弹窗并提交", async () => {
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /关闭$/ }));
    const modal = await screen.findByText("关闭质量工单");
    const content = modal.closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(content).getByLabelText("处理结果"), "已处理");
    await ui.click(within(content).getByRole("button", { name: /确认关闭/ }));
    await waitFor(() => expect(catalog.qualityApi.close).toHaveBeenCalledWith(1, expect.objectContaining({ resolution: "已处理" })));
  });

  it("批量关闭：打开弹窗并提交", async () => {
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /批量关闭未关闭工单/ }));
    const modal = await screen.findByText("批量关闭质量工单");
    const content = modal.closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(content).getByLabelText("批量处理结果"), "批量已处理");
    await ui.click(within(content).getByRole("button", { name: /确认批量关闭/ }));
    await waitFor(() => expect(catalog.qualityApi.batchClose).toHaveBeenCalled());
  });
});
