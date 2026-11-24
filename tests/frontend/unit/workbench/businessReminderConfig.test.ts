import { describe, expect, it } from "vitest";
import { buildBusinessReminderOptions, DEFAULT_BUSINESS_REMINDER_CONFIG, parseBusinessReminderConfig } from "@/workbench/businessReminderConfig";

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

  it("只接受 1 至 365 的 ASCII 整数天数，非法值回退默认天数", () => {
    for (const label of ["1e2", "1.0", "3.5", "+1", " 1", "1 ", "1\n", "1\r", "1\r\n", "１", "0", "-1", "366", "9".repeat(400)]) {
      expect(parseBusinessReminderConfig([{ value: "inventory_aging_days", label }]).inventoryAgingDays, label).toBe(7);
    }
    expect(parseBusinessReminderConfig([{ value: "inventory_aging_days", label: "0008" }]).inventoryAgingDays).toBe(8);
    expect(parseBusinessReminderConfig([{ value: "inventory_aging_days", label: `${"0".repeat(5000)}1` }]).inventoryAgingDays).toBe(1);
    expect(parseBusinessReminderConfig([{ value: "inventory_aging_days", label: "1" }]).inventoryAgingDays).toBe(1);
    expect(parseBusinessReminderConfig([{ value: "inventory_aging_days", label: "365" }]).inventoryAgingDays).toBe(365);
  });

  it("保存并读取时保留提醒天数和两项开关状态", () => {
    for (const config of [
      { inventoryAgingDays: 14, profitNotificationsEnabled: false, overdueInstallmentsEnabled: true },
      { inventoryAgingDays: 30, profitNotificationsEnabled: true, overdueInstallmentsEnabled: false },
    ]) {
      const options = buildBusinessReminderOptions(config);
      expect(options).toEqual([
        { value: "inventory_aging_days", label: String(config.inventoryAgingDays) },
        { value: "profit_notifications_enabled", label: config.profitNotificationsEnabled ? "1" : "0" },
        { value: "overdue_installments_enabled", label: config.overdueInstallmentsEnabled ? "1" : "0" },
      ]);
      expect(parseBusinessReminderConfig(options)).toEqual(config);
    }
  });
});
