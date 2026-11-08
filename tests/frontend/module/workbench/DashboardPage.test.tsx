import { fireEvent, screen, within } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { DashboardPage } from "@/app/DashboardPage";

import * as catalog from "@/shared/api/catalog";
import { seedOrderFormFields } from "@fixtures/formFieldsSeed";
/** 工作台只保留当前用户的动作入口与个人业务摘要：
 *  纯动作入口——新建业务卡 + 登记弹窗，以及工作台个人摘要的回归断言。 */

vi.mock("@/shared/api/catalog")

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([]);
  vi.mocked(catalog.stocksApi.list).mockResolvedValue([]);
  vi.mocked(catalog.installmentsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.notificationsApi.list).mockResolvedValue({ items: [], total: 0, unread_total: 0 });
  vi.mocked(catalog.reportsApi.commission).mockResolvedValue({
    items: [],
    total: { order_count: 0, profit_base: "0.00", payable: "0.00", paid: "0.00", difference: "0.00" },
  });
});

describe("DashboardPage：动作入口（数据已迁数据中心）", () => {
it("工作台展示业务总览指标和业务提醒", async () => {
    vi.mocked(catalog.ordersApi.list).mockResolvedValue([
      { id: 1, status: "ACTIVE" },
      { id: 2, status: "COMPLETED" },
    ] as never);
    // 库龄天数与档位由后端下发（AccountOut），工作台只比较/展示，不再做日期差。
    vi.mocked(catalog.stocksApi.list).mockResolvedValue([{
      id: 10,
      status: "WAITING",
      inventory_entry_at: "2026-09-01T00:00:00",
      inventory_age_days: 63,
      inventory_age_level: "OVERDUE",
      cost_amount: "100.00",
    } as never]);
    vi.mocked(catalog.installmentsApi.list).mockResolvedValue([{ id: 20, status: "OVERDUE" } as never]);
    vi.mocked(catalog.notificationsApi.list).mockResolvedValue({
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
    vi.mocked(catalog.stocksApi.list).mockResolvedValue([{
      id: 10,
      status: "WAITING",
      inventory_entry_at: "2026-10-20T00:00:00",
      inventory_age_days: 14,
      inventory_age_level: "WARNING",
      cost_amount: "100.00",
    } as never]);
    vi.mocked(catalog.installmentsApi.list).mockResolvedValue([{ id: 20, status: "OVERDUE" } as never]);
    vi.mocked(catalog.notificationsApi.list).mockResolvedValue({
      items: [{ id: 30, title: "新的分润通知", message: "订单 HS0001 已生成分润" } as never],
      total: 1,
      unread_total: 1,
    });
    vi.mocked(catalog.optionSetsApi.get).mockResolvedValue({
      options: [
        { value: "inventory_aging_days", label: "14" },
        { value: "profit_notifications_enabled", label: "0" },
        { value: "overdue_installments_enabled", label: "0" },
      ],
    } as never);

    renderLight(<DashboardPage />, { user: "admin" });

    const alerts = await screen.findByRole("region", { name: "我的消息" });
    expect(within(alerts).getByText("暂无异常事项")).toBeInTheDocument();
    expect(vi.mocked(catalog.optionSetsApi.get)).toHaveBeenCalledWith("BUSINESS_OVERVIEW_REMINDERS");
  });

it("admin 渲染业务入口卡", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    expect(await screen.findByRole("button", { name: /自营·回收/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /售出库存账号/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提号" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代挂" })).toBeInTheDocument();
  });

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

});
