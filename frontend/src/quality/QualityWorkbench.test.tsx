import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { QualityWorkbench } from "./QualityWorkbench";

const overview = vi.fn();
const listIssues = vi.fn();
const detect = vi.fn();
const resolve = vi.fn();
const ignore = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  qualityApi: {
    overview: (...a: unknown[]) => overview(...a),
    listIssues: (...a: unknown[]) => listIssues(...a),
    detect: (...a: unknown[]) => detect(...a),
    resolve: (...a: unknown[]) => resolve(...a),
    ignore: (...a: unknown[]) => ignore(...a),
  },
}));

const ov = {
  total: 9,
  blockers: 1,
  items: [
    { issue_type: "UNROUTED_EVENT", severity: "BLOCKER", open: 2, assigned: 1, total: 3, entry: "E1" },
  ],
} as unknown as import("../shared/api/catalog").QualityOverview;

const issues = [
  {
    id: 1,
    issue_no: "QLT-0001",
    issue_type: "UNROUTED_EVENT",
    severity: "BLOCKER",
    status: "OPEN",
    entity_label: "POOL-A",
    amount: "1000.00",
    detected_on: "2026-10-12",
  },
  {
    id: 2,
    issue_no: "QLT-0002",
    issue_type: "ORPHAN_CASHFLOW",
    severity: "LOW",
    status: "RESOLVED",
    entity_label: "ACC-1",
    amount: "0.00",
    detected_on: "2026-10-12",
  },
] as unknown as import("../shared/api/catalog").QualityIssue[];

beforeEach(() => {
  overview.mockResolvedValue(ov);
  listIssues.mockResolvedValue({ items: issues, total: issues.length });
  detect.mockResolvedValue({ detected_on: "2026-10-12", created_total: 0 });
  resolve.mockResolvedValue({});
  ignore.mockResolvedValue({});
});

it("渲染工作台标题、统计卡与异常列表，异常类型映射为中文", async () => {
  renderApp(<QualityWorkbench />, { user: "admin" });
  expect(await screen.findByText("异常工作台")).toBeInTheDocument();
  // 统计卡（kind=count 已满足 ui_guard）
  expect(screen.getByText("未闭环异常")).toBeInTheDocument();
  expect(screen.getByText("阻断级异常")).toBeInTheDocument();
  // ISSUE_TYPE_LABEL 逐字映射：漏一个就会在页面露英文枚举
  expect(await screen.findByText("未路由事件")).toBeInTheDocument();
  expect(await screen.findByText("孤儿流水")).toBeInTheDocument();
});

it("立即检测：admin 角色可见按钮，点击调用 detect 并重载列表", async () => {
  renderApp(<QualityWorkbench />, { user: "admin" });
  const btn = await screen.findByRole("button", { name: /立即检测/ });
  await userEvent.click(btn);
  await waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
  // 检测后 load 重跑 → listIssues 累计 2 次（挂载 1 + 检测后 1）
  await waitFor(() => expect(listIssues).toHaveBeenCalledTimes(2));
});

it("viewer 角色无 quality.resolve：看不到立即检测/处置/忽略", async () => {
  renderApp(<QualityWorkbench />, { user: "viewer" });
  await screen.findByText("异常工作台");
  expect(screen.queryByRole("button", { name: /立即检测/ })).toBeNull();
  const labels = screen.queryAllByRole("button").map((b) => b.textContent ?? "");
  expect(labels.some((t) => t.includes("处置"))).toBe(false);
  expect(labels.some((t) => t.includes("忽略"))).toBe(false);
});

it("处置流程：点击处置 → 填解决方式 → 确认处置 调用 resolve", async () => {
  renderApp(<QualityWorkbench />, { user: "admin" });
  await screen.findByText("未路由事件");
  const resolveBtns = screen.getAllByRole("button", { name: /处置/ });
  await userEvent.click(resolveBtns[0]);
  await screen.findByText(/处置异常/); // 抽屉标题
  await userEvent.type(
    screen.getByPlaceholderText("如：已补录流水 / 已释放押金"),
    "已补录流水",
  );
  await userEvent.click(screen.getByRole("button", { name: /确认处置/ }));
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
  expect(resolve.mock.calls[0][0]).toBe(1); // 工单 id
  expect(resolve.mock.calls[0][1]).toMatchObject({ resolution: "已补录流水" });
});

it("忽略流程：点击忽略 → 填理由 → 确认忽略 调用 ignore", async () => {
  renderApp(<QualityWorkbench />, { user: "admin" });
  await screen.findByText("未路由事件");
  const ignoreBtns = screen.getAllByRole("button", { name: /忽略/ });
  await userEvent.click(ignoreBtns[0]);
  await screen.findByText(/忽略异常/); // 抽屉标题
  await userEvent.type(screen.getByLabelText("忽略理由"), "重复工单");
  await userEvent.click(screen.getByRole("button", { name: /确认忽略/ }));
  await waitFor(() => expect(ignore).toHaveBeenCalledTimes(1));
  expect(ignore.mock.calls[0][0]).toBe(1);
  expect(ignore.mock.calls[0][1]).toBe("重复工单");
});
