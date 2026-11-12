import type { OptionItem } from "../shared/api/types/common";

export const BUSINESS_REMINDER_CONFIG_CODE = "BUSINESS_OVERVIEW_REMINDERS";

export interface BusinessReminderConfig {
  inventoryAgingDays: number;
  profitNotificationsEnabled: boolean;
  overdueInstallmentsEnabled: boolean;
}

export const DEFAULT_BUSINESS_REMINDER_CONFIG: BusinessReminderConfig = {
  inventoryAgingDays: 7,
  profitNotificationsEnabled: true,
  overdueInstallmentsEnabled: true,
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "off", "disabled"].includes(value.toLowerCase());
}

export function parseBusinessReminderConfig(options?: OptionItem[] | null): BusinessReminderConfig {
  const values = new Map((options ?? []).map((item) => [item.value, item.label]));
  return {
    inventoryAgingDays: positiveInteger(values.get("inventory_aging_days"), DEFAULT_BUSINESS_REMINDER_CONFIG.inventoryAgingDays),
    profitNotificationsEnabled: enabled(values.get("profit_notifications_enabled"), DEFAULT_BUSINESS_REMINDER_CONFIG.profitNotificationsEnabled),
    overdueInstallmentsEnabled: enabled(values.get("overdue_installments_enabled"), DEFAULT_BUSINESS_REMINDER_CONFIG.overdueInstallmentsEnabled),
  };
}

export function buildBusinessReminderOptions(config: BusinessReminderConfig): OptionItem[] {
  return [
    { value: "inventory_aging_days", label: String(config.inventoryAgingDays) },
    { value: "profit_notifications_enabled", label: config.profitNotificationsEnabled ? "1" : "0" },
    { value: "overdue_installments_enabled", label: config.overdueInstallmentsEnabled ? "1" : "0" },
  ];
}
