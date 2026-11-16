export interface DashboardAlertInputs {
  inventoryAgingCount: number | null;
  inventoryAgingDays: number;
  newProfitNotificationCount: number | null;
  profitNotificationsEnabled: boolean;
  overdueInstallmentCount: number | null;
  overdueInstallmentsEnabled: boolean;
}

export function buildDashboardAlertMessages({
  inventoryAgingCount,
  inventoryAgingDays,
  newProfitNotificationCount,
  profitNotificationsEnabled,
  overdueInstallmentCount,
  overdueInstallmentsEnabled,
}: DashboardAlertInputs): string[] {
  return [
    inventoryAgingCount && inventoryAgingCount > 0
      ? `库存订单入库超过 ${inventoryAgingDays} 天 ${inventoryAgingCount} 个`
      : null,
    profitNotificationsEnabled && newProfitNotificationCount && newProfitNotificationCount > 0
      ? `新的分润通知 ${newProfitNotificationCount} 条`
      : null,
    overdueInstallmentsEnabled && overdueInstallmentCount && overdueInstallmentCount > 0
      ? `逾期合约 ${overdueInstallmentCount} 个`
      : null,
  ].filter((item): item is string => Boolean(item));
}
