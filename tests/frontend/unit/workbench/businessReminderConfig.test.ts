import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_REMINDER_CONFIG, parseBusinessReminderConfig } from "@/app/businessReminderConfig";
import { buildDashboardAlertMessages } from "@/app/dashboardSummary";

describe("业务提醒配置", () => {
  it("未配置时使用默认规则", () => {
    expect(parseBusinessReminderConfig()).toEqual(DEFAULT_BUSINESS_REMINDER_CONFIG);
  });

  it("读取已保存的提醒天数和开关", () => {
    expect(parseBusinessReminderConfig([
      { value: "inventory_aging_days", label: "14" },
      { value: "profit_notifications_enabled", label: "0" },
      { value: "overdue_installments_enabled", label: "1" },
    ])).toEqual({
      inventoryAgingDays: 14,
      profitNotificationsEnabled: false,
      overdueInstallmentsEnabled: true,
    });
  });

  it("按提醒配置生成工作台消息", () => {
    expect(buildDashboardAlertMessages({
      inventoryAgingCount: 2,
      inventoryAgingDays: 14,
      pendingProfitCount: 0,
      allocatedProfitCount: 1,
      profitNotificationsEnabled: true,
      overdueInstallmentCount: 3,
      overdueInstallmentsEnabled: false,
    })).toEqual([
      { type: "inventory_aging", message: "库存订单入库超过 14 天 2 个" },
      { type: "allocated_profit", message: "获得分润通知 1 条" },
    ]);
  });
});
