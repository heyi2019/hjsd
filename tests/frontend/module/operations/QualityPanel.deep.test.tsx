import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { QualityPanel } from "@/quality/QualityPanel";
import { qualityApi } from "@/shared/api/quality.api";
import { seedOptionSets } from "@fixtures/formFieldsSeed";
import { appMessage as message } from "@/shared/ui/appFeedback";
import type { QualityIssue, QualitySummary } from "@/shared/api/types/ops";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/quality.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

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
  seedOptionSets();
  vi.mocked(qualityApi.summary).mockResolvedValue(summary);
  vi.mocked(qualityApi.list).mockResolvedValue({ items: rows });
  vi.mocked(qualityApi.create).mockResolvedValue({ id: 3 } as QualityIssue);
  vi.mocked(qualityApi.close).mockResolvedValue(rows[0]);
  vi.mocked(qualityApi.batchClose).mockResolvedValue([]);
  vi.mocked(qualityApi.update).mockResolvedValue(undefined as never);
  vi.mocked(qualityApi.scan).mockResolvedValue([]);
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
    vi.mocked(qualityApi.create).mockRejectedValue(new Error("create fail"));
    renderLight(<QualityPanel />, { user: "admin" });
    const content = await openCreateModal();
    await fillCreateForm(content);
    await ui.click(within(content).getByRole("button", { name: /创建工单/ }));
    expect((await screen.findAllByText(/create fail/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(qualityApi.create).toHaveBeenCalled());
    expect(message.success).not.toHaveBeenCalled();
    // 弹窗保持打开
    expect(screen.getByText("新建质量工单")).toBeInTheDocument();
  });

  it("关闭工单失败：close reject 后展示错误横幅", async () => {
    vi.mocked(qualityApi.close).mockRejectedValue(new Error("close fail"));
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /关闭$/ }));
    const modal = await screen.findByText("关闭质量工单");
    const content = modal.closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(content).getByLabelText("处理结果"), "已处理");
    await ui.click(within(content).getByRole("button", { name: /确认关闭/ }));
    expect((await screen.findAllByText(/close fail/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(qualityApi.close).toHaveBeenCalled());
    expect(message.success).not.toHaveBeenCalled();
  });

  it("批量关闭失败：batchClose reject 后 message.error + 错误横幅", async () => {
    vi.mocked(qualityApi.batchClose).mockRejectedValue(new Error("batch fail"));
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
    await waitFor(() => expect(qualityApi.update).toHaveBeenCalledWith(1, { status: "IN_PROGRESS" }));
    expect(message.success).toHaveBeenCalledWith("工单已进入处理中");
  });

  it("主动扫描无新异常：scan 返回空数组提示「未发现新异常」", async () => {
    vi.mocked(qualityApi.scan).mockResolvedValue([]);
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /主动扫描/ }));
    await waitFor(() => expect(qualityApi.scan).toHaveBeenCalled());
    expect(message.success).toHaveBeenCalledWith("扫描完成，未发现新异常");
  });

  it("主动扫描有新异常：scan 返回工单提示「扫描发现 N 个新异常」", async () => {
    vi.mocked(qualityApi.scan).mockResolvedValue([{ id: 9 } as QualityIssue]);
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /主动扫描/ }));
    await waitFor(() => expect(qualityApi.scan).toHaveBeenCalled());
    expect(message.success).toHaveBeenCalledWith("扫描发现 1 个新异常，已生成工单");
  });

  it("全 CLOSED 时批量关闭按钮禁用：点击不弹窗、不调 batchClose", async () => {
    vi.mocked(qualityApi.list).mockResolvedValue({ items: closedRows });
    renderLight(<QualityPanel />, { user: "admin" });
    const trigger = await screen.findByRole("button", { name: /批量关闭未关闭工单/ });
    await screen.findByText("QLT-1");
    await waitFor(() => expect(trigger).toBeDisabled());
    await ui.click(trigger);
    expect(screen.queryByText("批量关闭质量工单")).not.toBeInTheDocument();
    expect(qualityApi.batchClose).not.toHaveBeenCalled();
  });

  it("弹窗打开期间列表刷新为全部已关闭：提交走 message.info 且不调 batchClose", async () => {
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /批量关闭未关闭工单/ }));
    const modal = await screen.findByText("批量关闭质量工单");
    const content = modal.closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(content).getByLabelText("批量处理结果"), "批量已处理");
    // 弹窗开着时列表被刷新成全部 CLOSED（如主动扫描触发的 reload），提交即命中「无可关闭」分支
    vi.mocked(qualityApi.list).mockResolvedValue({ items: closedRows });
    await ui.click(screen.getByRole("button", { name: /主动扫描/ }));
    await waitFor(() => expect(qualityApi.list).toHaveBeenCalledTimes(2));
    await ui.click(within(content).getByRole("button", { name: /确认批量关闭/ }));
    await waitFor(() => expect(message.info).toHaveBeenCalledWith("暂无可批量关闭的工单"));
    expect(qualityApi.batchClose).not.toHaveBeenCalled();
  });

  it("错误横幅重试：加载失败后点「重新加载」再次请求", async () => {
    vi.mocked(qualityApi.list).mockRejectedValue(new Error("quality down"));
    vi.mocked(qualityApi.summary).mockRejectedValue(new Error("quality down"));
    renderLight(<QualityPanel />, { user: "admin" });
    expect(await screen.findByText(/quality down/)).toBeInTheDocument();
    // 恢复 list 成功以便重试通过
    vi.mocked(qualityApi.list).mockResolvedValue({ items: rows });
    vi.mocked(qualityApi.summary).mockResolvedValue(summary);
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() => expect(qualityApi.list).toHaveBeenCalledTimes(2));
  });
});
