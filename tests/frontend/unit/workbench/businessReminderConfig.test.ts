import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_REMINDER_CONFIG, parseBusinessReminderConfig } from "@/app/workbench/businessReminderConfig";

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
    expect(() => parseBusinessReminderConfig([{ value: "profit_notifications_enabled", label: "invalid" }])).toThrow("业务提醒开关配置无效");
  });

});
