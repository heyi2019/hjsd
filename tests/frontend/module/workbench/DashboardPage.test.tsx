import { fireEvent, screen, within } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DashboardPage } from "@/app/DashboardPage";

import { installmentsApi } from "@/shared/api/installments.api";
import { notificationsApi } from "@/shared/api/misc.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { ordersApi } from "@/shared/api/orders.api";
import { reportsApi } from "@/shared/api/reports.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { seedOrderFormFields } from "@fixtures/formFieldsSeed";
/** 2026-10-13：工作台数据总览（资金池/统计/入口卡）已迁至「经营中心 · 数据中心」
 *  （用例见 reporting/DataCenterPanel.test.tsx）。本文件只覆盖瘦身后的工作台：
 *  纯动作入口——新建业务卡 + 登记弹窗，以及「数据已迁走」的回归断言。 */

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields();
  vi.mocked(ordersApi.list).mockResolvedValue([]);
  vi.mocked(stocksApi.list).mockResolvedValue([]);
  vi.mocked(installmentsApi.list).mockResolvedValue([]);
  vi.mocked(notificationsApi.list).mockResolvedValue({ items: [], total: 0, unread_total: 0 });
  vi.mocked(reportsApi.commission).mockResolvedValue({
    items: [],
    total: { order_count: 0, profit_base: "0.00", payable: "0.00", paid: "0.00", difference: "0.00" },
  });
});

describe("DashboardPage：动作入口（数据已迁数据中心）", () => {
it("工作台展示业务总览指标和业务提醒", async () => {
    vi.mocked(ordersApi.list).mockResolvedValue([
      { id: 1, status: "ACTIVE" },
      { id: 2, status: "COMPLETED" },
    ] as never);
    // 库龄天数与档位由后端下发（AccountOut），工作台只比较/展示，不再做日期差。
    vi.mocked(stocksApi.list).mockResolvedValue([{
      id: 10,
      status: "WAITING",
      inventory_entry_at: "2026-09-01T00:00:00",
      inventory_age_days: 63,
      inventory_age_level: "OVERDUE",
      cost_amount: "100.00",
    } as never]);
    vi.mocked(installmentsApi.list).mockResolvedValue([{ id: 20, status: "OVERDUE" } as never]);
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [{ id: 30, title: "新的分润通知", message: "订单 HS0001 已生成分润", notification_type: "PROFIT_ALLOCATION_SET" } as never],
      total: 1,
      unread_total: 1,
    });

    renderLight(<DashboardPage />, { user: "admin" });

    const overview = await screen.findByRole("region", { name: "我的业务总览" });
    for (const [label, value] of [
      ["在库账号", "1"],
      ["订单总量", "2"],
      ["完成订单量", "1"],
      ["分期合约", "1"],
      ["逾期合约", "1"],
      ["在库超期账号", "1"],
    ]) {
      const card = within(overview).getByText(label).closest(".ui-stat") as HTMLElement | null;
      expect(card).not.toBeNull();
      expect(within(card!).getByText(value)).toBeInTheDocument();
    }
    const alerts = await screen.findByRole("region", { name: "我的消息" });
    expect(within(alerts).getByText("库存订单入库超过 7 天 1 个")).toBeInTheDocument();
    expect(within(alerts).getByText("新的分润通知 1 条")).toBeInTheDocument();
  });

it("工作台按业务提醒配置计算库存阈值并控制提醒开关", async () => {
    // 天数写死为 14：配置阈值为 14 天，「超 7 天」不触发（不再依赖跑测试那天的日期）。
    vi.mocked(stocksApi.list).mockResolvedValue([{
      id: 10,
      status: "WAITING",
      inventory_entry_at: "2026-10-20T00:00:00",
      inventory_age_days: 14,
      inventory_age_level: "WARNING",
      cost_amount: "100.00",
    } as never]);
    vi.mocked(installmentsApi.list).mockResolvedValue([{ id: 20, status: "OVERDUE" } as never]);
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: [{ id: 30, title: "新的分润通知", message: "订单 HS0001 已生成分润" } as never],
      total: 1,
      unread_total: 1,
    });
    vi.mocked(optionSetsApi.get).mockResolvedValue({
      options: [
        { value: "inventory_aging_days", label: "14" },
        { value: "profit_notifications_enabled", label: "0" },
        { value: "overdue_installments_enabled", label: "0" },
      ],
    } as never);

    renderLight(<DashboardPage />, { user: "admin" });

    const alerts = await screen.findByRole("region", { name: "我的消息" });
    expect(within(alerts).getByText("暂无异常事项")).toBeInTheDocument();
    expect(vi.mocked(optionSetsApi.get)).toHaveBeenCalledWith("BUSINESS_OVERVIEW_REMINDERS");
  });

it("admin 渲染业务入口卡", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    expect(await screen.findByRole("button", { name: /自营·回收/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /售出库存账号/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提号" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代挂" })).toBeInTheDocument();
  });

it("工作台只保留标题和入口，不显示辅助描述文字", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /自营·回收/ });
    expect(screen.queryByText("先处理最重要的动作；业务数据与经营指标分别在对应中心查看。")).toBeNull();
    expect(screen.queryByText("回收 / 提号 / 代挂 库存账号的统一出售入口")).toBeNull();
    expect(screen.queryByText("从库存中心选择任意渠道（回收 / 提号 / 代挂）的账号售出")).toBeNull();
    expect(screen.queryByText("录入游戏账号、来源与回收费用，创建回收单")).toBeNull();
    expect(screen.queryByText("需要快速开始时，从一个明确动作开始。")).toBeNull();
  });

it("业务入口按场景使用独立的卡片视觉层级", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /自营·回收/ });
    expect(document.querySelector(".dashboard-entry-group--sell")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-entry-group--self-owned")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-entry-group--distribution")).toBeInTheDocument();
  });

it("所有业务分组都不显示顶部装饰条", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: "提号" });
    const groups = document.querySelectorAll(".dashboard-entry-group");
    expect(groups).toHaveLength(3);
    groups.forEach((group) => {
      expect(group).toHaveClass("dashboard-entry-group--no-accent");
    });
  });

it("分销入口使用中性白色视觉", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: "提号" });
    expect(document.querySelector(".dashboard-entry-group--distribution.dashboard-entry-group--neutral")).toBeInTheDocument();
  });

it("主入口展示短标签，强化业务转化层级", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /售出库存账号/ });
    expect(screen.getByText("主推入口")).toBeInTheDocument();
    expect(screen.getByText("高频业务")).toBeInTheDocument();
  });

it("分销入口只显示业务名称，不重复显示分销前缀", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    expect(await screen.findByRole("button", { name: "提号" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代挂" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分销·提号" })).toBeNull();
    expect(screen.queryByRole("button", { name: "分销·代挂" })).toBeNull();
  });

it("所有业务入口使用同一套标准化分组结构", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: "提号" });
    const groups = document.querySelectorAll(".dashboard-entry-group");
    expect(groups).toHaveLength(3);
    groups.forEach((group) => {
      expect(group.querySelector(":scope > .dashboard-entry-group__items")).toBeInTheDocument();
    });
  });


// —— 以下 6 条原在 DashboardPage.interactions.test.tsx ——
// 同一页面、同一份 mock 契约，拆两个文件等于让同样的 jsdom+antd 启动付两遍。
it("viewer 无 order.create → 看不到新建业务卡", async () => {
    await act(async () => {
      renderLight(<DashboardPage />, { user: "viewer" });
      await Promise.resolve();
    });
    // 无卡可点：给一帧让权限门控渲染完再断言（sync 渲染，无需 waitFor 数据）。
    expect(screen.queryByRole("button", { name: /自营·回收/ })).toBeNull();
  });

it("点击回收账号卡直接打开回收登记弹窗（不跳转页面）", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: /自营·回收/ }));
    const modal = await screen.findByText("新建回收订单");
    expect(modal.closest(".ant-modal-content")).toBeTruthy();
  });

it("点击共同出售口进入业务中心库存页", async () => {
    const onNavigate = vi.fn();
    renderLight(<DashboardPage onNavigate={onNavigate} />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: /售出库存账号/ }));
    expect(onNavigate).toHaveBeenCalledWith("business", "inventory");
  });

it("点击提号卡直接打开提号登记弹窗（不跳转页面）", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: "提号" }));
    const modal = await screen.findByText("新建提号订单");
    expect(modal.closest(".ant-modal-content")).toBeTruthy();
  });

it("数据总览已迁走：不再渲染资金池表格/统计/订单入口卡", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /自营·回收/ });
    expect(screen.queryByText("资金池概览")).toBeNull();
    expect(screen.queryByText("可用余额合计")).toBeNull();
    expect(screen.queryByText("资金池数量")).toBeNull();
    expect(screen.queryByText("订单总数")).toBeNull();
    expect(screen.queryByText(/POOL-A/)).toBeNull();
  });

it("订单请求完成时不产生未包裹 act 的异步更新警告", async () => {
    let resolveOrders!: (value: never[]) => void;
    vi.mocked(ordersApi.list).mockReturnValueOnce(new Promise<never[]>((resolve) => {
      resolveOrders = resolve;
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderLight(<DashboardPage />, { user: "admin" });

    view.unmount();
    resolveOrders([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      consoleError.mock.calls.some((args) => args.join(" ").includes("not wrapped in act")),
    ).toBe(false);
    consoleError.mockRestore();
  });

});
