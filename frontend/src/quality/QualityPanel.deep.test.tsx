import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { QualityPanel } from "./QualityPanel";
import * as catalog from "../shared/api/catalog";
import { seedOptionSets } from "../test/formFieldsSeed";
import { message } from "antd";
import type { QualityIssue, QualitySummary } from "../shared/api/catalog";

vi.mock("../shared/api/catalog");

const summary: QualitySummary = { total: 2, by_severity: { LOW: 0, MEDIUM: 1, HIGH: 1, CRITICAL: 0 } } as QualitySummary;
const rows: QualityIssue[] = [
  { id: 1, issue_no: "QLT-1", severity: "HIGH", title: "卡单", entity_type: "order", entity_id: "10", status: "OPEN", message: "x" },
  { id: 2, issue_no: "QLT-2", severity: "LOW", title: "小问题", entity_type: "account", entity_id: "3", status: "CLOSED", message: "y" },
];
const closedRows: QualityIssue[] = [
  { id: 1, issue_no: "QLT-1", severity: "HIGH", title: "卡单", entity_type: "order", entity_id: "10", status: "CLOSED", message: "x" },
];

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  seedOptionSets(catalog);
  vi.mocked(catalog.qualityApi.summary).mockResolvedValue(summary);
  vi.mocked(catalog.qualityApi.list).mockResolvedValue({ items: rows });
  vi.mocked(catalog.qualityApi.create).mockResolvedValue({ id: 3 } as QualityIssue);
  vi.mocked(catalog.qualityApi.close).mockResolvedValue(rows[0]);
  vi.mocked(catalog.qualityApi.batchClose).mockResolvedValue([]);
  vi.mocked(catalog.qualityApi.update).mockResolvedValue(undefined as never);
  vi.mocked(catalog.qualityApi.scan).mockResolvedValue([]);
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "info").mockImplementation((() => undefined) as never);
});

async function openCreateModal(): Promise<HTMLElement> {
  await ui.click(screen.getByRole("button", { name: /新建工单/ }));
  const modal = await screen.findByText("新建质量工单");
  const content = modal.closest(".ant-modal-content") as HTMLElement;
  return content;
}

async function fillCreateForm(content: HTMLElement) {
  await ui.type(within(content).getByLabelText("异常编码"), "QLT-NEW");
  await ui.type(within(content).getByLabelText("标题"), "新异常");
  await ui.type(within(content).getByLabelText("对象类型"), "order");
  await ui.type(within(content).getByLabelText("对象编号"), "99");
  await ui.type(within(content).getByLabelText("问题描述"), "描述");
  const selector = content.querySelector(".ant-select-selector") as HTMLElement;
  await ui.click(selector);
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  await ui.click(within(dropdowns[dropdowns.length - 1] as HTMLElement).getByText("高"));
}

describe("QualityPanel.deep：写路径与失败分支", () => {
  it("新建工单失败：create reject 后展示错误横幅、弹窗保持、不提示成功", async () => {
    vi.mocked(catalog.qualityApi.create).mockRejectedValue(new Error("create fail"));
    renderLight(<QualityPanel />, { user: "admin" });
    const content = await openCreateModal();
    await fillCreateForm(content);
    await ui.click(within(content).getByRole("button", { name: /创建工单/ }));
    expect((await screen.findAllByText(/create fail/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(catalog.qualityApi.create).toHaveBeenCalled());
    expect(message.success).not.toHaveBeenCalled();
    // 弹窗保持打开
    expect(screen.getByText("新建质量工单")).toBeInTheDocument();
  });

  it("关闭工单失败：close reject 后展示错误横幅", async () => {
    vi.mocked(catalog.qualityApi.close).mockRejectedValue(new Error("close fail"));
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /关闭$/ }));
    const modal = await screen.findByText("关闭质量工单");
    const content = modal.closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(content).getByLabelText("处理结果"), "已处理");
    await ui.click(within(content).getByRole("button", { name: /确认关闭/ }));
    expect((await screen.findAllByText(/close fail/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(catalog.qualityApi.close).toHaveBeenCalled());
    expect(message.success).not.toHaveBeenCalled();
  });

  it("批量关闭失败：batchClose reject 后 message.error + 错误横幅", async () => {
    vi.mocked(catalog.qualityApi.batchClose).mockRejectedValue(new Error("batch fail"));
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /批量关闭未关闭工单/ }));
    const modal = await screen.findByText("批量关闭质量工单");
    const content = modal.closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(content).getByLabelText("批量处理结果"), "批量已处理");
    await ui.click(within(content).getByRole("button", { name: /确认批量关闭/ }));
    await waitFor(() => expect(message.error).toHaveBeenCalledWith(expect.stringMatching(/批量关闭失败/)));
    expect((await screen.findAllByText(/batch fail/)).length).toBeGreaterThan(0);
  });

  it("开始处理：点 OPEN 行「开始处理」调 update 并提示", async () => {
    renderLight(<QualityPanel />, { user: "admin" });
    const row = (await screen.findByText("QLT-1")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /开始处理/ }));
    await waitFor(() => expect(catalog.qualityApi.update).toHaveBeenCalledWith(1, { status: "IN_PROGRESS" }));
    expect(message.success).toHaveBeenCalledWith("工单已进入处理中");
  });

  it("主动扫描无新异常：scan 返回空数组提示「未发现新异常」", async () => {
    vi.mocked(catalog.qualityApi.scan).mockResolvedValue([]);
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /主动扫描/ }));
    await waitFor(() => expect(catalog.qualityApi.scan).toHaveBeenCalled());
    expect(message.success).toHaveBeenCalledWith("扫描完成，未发现新异常");
  });

  it("主动扫描有新异常：scan 返回工单提示「扫描发现 N 个新异常」", async () => {
    vi.mocked(catalog.qualityApi.scan).mockResolvedValue([{ id: 9 } as QualityIssue]);
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /主动扫描/ }));
    await waitFor(() => expect(catalog.qualityApi.scan).toHaveBeenCalled());
    expect(message.success).toHaveBeenCalledWith("扫描发现 1 个新异常，已生成工单");
  });

  it("批量关闭无可关闭工单：全 CLOSED 时仅 message.info 不调 batchClose", async () => {
    vi.mocked(catalog.qualityApi.list).mockResolvedValue({ items: closedRows });
    vi.mocked(catalog.qualityApi.summary).mockResolvedValue(summary);
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /批量关闭未关闭工单/ }));
    const modal = await screen.findByText("批量关闭质量工单");
    const content = modal.closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(content).getByLabelText("批量处理结果"), "批量已处理");
    await ui.click(within(content).getByRole("button", { name: /确认批量关闭/ }));
    await waitFor(() => expect(message.info).toHaveBeenCalledWith("暂无可批量关闭的工单"));
    expect(catalog.qualityApi.batchClose).not.toHaveBeenCalled();
  });

  it("错误横幅重试：加载失败后点「重新加载」再次请求", async () => {
    vi.mocked(catalog.qualityApi.list).mockRejectedValue(new Error("quality down"));
    vi.mocked(catalog.qualityApi.summary).mockRejectedValue(new Error("quality down"));
    renderLight(<QualityPanel />, { user: "admin" });
    expect(await screen.findByText(/quality down/)).toBeInTheDocument();
    // 恢复 list 成功以便重试通过
    vi.mocked(catalog.qualityApi.list).mockResolvedValue({ items: rows });
    vi.mocked(catalog.qualityApi.summary).mockResolvedValue(summary);
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() => expect(catalog.qualityApi.list).toHaveBeenCalledTimes(2));
  });
});
