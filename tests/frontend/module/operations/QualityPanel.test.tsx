import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { QualityPanel } from "@/quality/QualityPanel";
import { qualityApi } from "@/shared/api/quality.api";
import type { QualityMetrics } from "@/shared/api/types/ops";
import { seedOptionSets } from "@fixtures/formFieldsSeed";
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

const metricsPayload: QualityMetrics = {
  from: "2026-05-01",
  to: "2026-10-31",
  definitions: {
    reconciliation_completion_rate: { label: "对账完成率", formula: "已核销对账数 / 对账总数", unit: "percent" },
    overdue_rate: { label: "分期逾期率", formula: "期末已逾期计划数 / 当月到期计划数", unit: "percent" },
    missing_attachment_rate: { label: "缺附件率", formula: "无附件的金额事件 / 应有凭证记录总数", unit: "percent" },
  },
  items: [
    {
      month: "2026-09",
      reconciliation_completion_rate: { rate: 33.33, numerator: 1, denominator: 3, amount: null },
      overdue_rate: { rate: null, numerator: 0, denominator: 0, amount: null },
      missing_attachment_rate: { rate: 100, numerator: 361, denominator: 361, amount: null },
    },
    {
      month: "2026-10",
      reconciliation_completion_rate: { rate: 78.95, numerator: 15, denominator: 19, amount: null },
      overdue_rate: { rate: 28.12, numerator: 27, denominator: 96, amount: null },
      missing_attachment_rate: { rate: 100, numerator: 588, denominator: 588, amount: null },
    },
  ],
};

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  seedOptionSets();
  vi.mocked(qualityApi.summary).mockResolvedValue(summary);
  vi.mocked(qualityApi.list).mockResolvedValue({ items: rows });
  vi.mocked(qualityApi.metrics).mockResolvedValue(metricsPayload);
  vi.mocked(qualityApi.create).mockResolvedValue({ id: 3 } as QualityIssue);
  vi.mocked(qualityApi.close).mockResolvedValue(rows[0]);
  vi.mocked(qualityApi.batchClose).mockResolvedValue([]);
});

describe("QualityPanel：质量中心", () => {
  it("加载并展示摘要与工单列表", async () => {
    renderLight(<QualityPanel />, { user: "admin" });
    expect(await screen.findByText("QLT-1")).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  });

  it("月度质量指标：列名取后端口径、比率两位小数、分母为 0 显示占位而非 0%", async () => {
    renderLight(<QualityPanel />, { user: "admin" });
    // 列名不在前端硬编码，来自 definitions（antd 滚动测量层会复制列头，故按列头角色取）
    expect((await screen.findAllByRole("columnheader", { name: "对账完成率" })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("columnheader", { name: "分期逾期率" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("columnheader", { name: "缺附件率" }).length).toBeGreaterThan(0);
    // 2026-09 对账完成率 33.33%
    expect(await screen.findByText("33.33%")).toBeInTheDocument();
    // 2026-10 逾期率 28.12%
    expect(screen.getByText("28.12%")).toBeInTheDocument();
    // 2026-09 逾期率分母为 0 → 占位符，不能渲染成 0.00%
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0.00%")).not.toBeInTheDocument();
  });

  it("月度质量指标：切换区间后按新区间重新取数（不只改前端展示）", async () => {
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findAllByRole("columnheader", { name: "对账完成率" });
    const firstCall = vi.mocked(qualityApi.metrics).mock.calls[0][0] as { from: string; to: string };

    const selector = document.querySelector('[aria-label="指标统计区间"] .ant-select-selector') as HTMLElement;
    await ui.click(selector);
    const dropdowns = document.querySelectorAll(".ant-select-dropdown");
    await ui.click(within(dropdowns[dropdowns.length - 1] as HTMLElement).getByText("近 3 个月"));

    await waitFor(() => expect(qualityApi.metrics).toHaveBeenCalledTimes(2));
    const secondCall = vi.mocked(qualityApi.metrics).mock.calls[1][0] as { from: string; to: string };
    // 区间起点相差 3 个月，且仍落在月初
    const [fy, fm] = firstCall.from.split("-").map(Number);
    const [sy, sm] = secondCall.from.split("-").map(Number);
    expect((sy * 12 + sm) - (fy * 12 + fm)).toBe(3);
    expect(secondCall.from.endsWith("-01")).toBe(true);
    expect(secondCall.to).toBe(firstCall.to);
  });

  it("加载失败展示错误横幅", async () => {
    vi.mocked(qualityApi.list).mockRejectedValue(new Error("quality down"));
    vi.mocked(qualityApi.summary).mockRejectedValue(new Error("quality down"));
    renderLight(<QualityPanel />, { user: "admin" });
    expect(await screen.findByText(/quality down/)).toBeInTheDocument();
  });

  it("FE-104：质量摘要失败时不伪装成零统计", async () => {
    vi.mocked(qualityApi.summary).mockRejectedValueOnce(new Error("summary down"));
    renderLight(<QualityPanel />, { user: "admin" });
    expect(await screen.findByText(/summary down/)).toBeInTheDocument();
    expect(screen.getByText("异常总数").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByText("高严重度").closest(".ui-stat")).toHaveTextContent("不可用");
  });

  it("FE-160：没有未关闭工单时禁用批量关闭", async () => {
    vi.mocked(qualityApi.list).mockResolvedValueOnce({
      items: rows.map((row) => ({ ...row, status: "CLOSED" })),
    });
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    expect(screen.getByRole("button", { name: /批量关闭未关闭工单/ })).toBeDisabled();
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
    await waitFor(() => expect(qualityApi.create).toHaveBeenCalled());
  });

  it("FE-110：关闭工单后刷新统计与列表", async () => {
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    const listCallsBeforeClose = vi.mocked(qualityApi.list).mock.calls.length;
    await ui.click(screen.getByRole("button", { name: /关闭$/ }));
    const modal = await screen.findByText("关闭质量工单");
    const content = modal.closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(content).getByLabelText("处理结果"), "已处理");
    await ui.click(within(content).getByRole("button", { name: /确认关闭/ }));
    await waitFor(() => expect(qualityApi.close).toHaveBeenCalledWith(1, expect.objectContaining({ resolution: "已处理" })));
    await waitFor(() => expect(vi.mocked(qualityApi.list).mock.calls.length).toBeGreaterThan(listCallsBeforeClose));
    expect(vi.mocked(qualityApi.summary).mock.calls.length).toBeGreaterThan(1);
  });

  it("批量关闭：打开弹窗并提交", async () => {
    renderLight(<QualityPanel />, { user: "admin" });
    await screen.findByText("QLT-1");
    await ui.click(screen.getByRole("button", { name: /批量关闭未关闭工单/ }));
    const modal = await screen.findByText("批量关闭质量工单");
    const content = modal.closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(content).getByLabelText("批量处理结果"), "批量已处理");
    await ui.click(within(content).getByRole("button", { name: /确认批量关闭/ }));
    await waitFor(() => expect(qualityApi.batchClose).toHaveBeenCalled());
  });
});
