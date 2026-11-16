export interface DashboardAlertInputs {
  inventoryAgingCount: number | null;
  inventoryAgingDays: number;
  pendingProfitCount: number | null;
  allocatedProfitCount: number | null;
  profitNotificationsEnabled: boolean;
  overdueInstallmentCount: number | null;
  overdueInstallmentsEnabled: boolean;
}

export function buildDashboardAlertMessages({
  inventoryAgingCount,
  inventoryAgingDays,
  pendingProfitCount,
  allocatedProfitCount,
  profitNotificationsEnabled,
  overdueInstallmentCount,
  overdueInstallmentsEnabled,
}: DashboardAlertInputs): string[] {
  return [
    inventoryAgingCount && inventoryAgingCount > 0
      ? `库存订单入库超过 ${inventoryAgingDays} 天 ${inventoryAgingCount} 个`
      : null,
    profitNotificationsEnabled && pendingProfitCount && pendingProfitCount > 0
      ? `分润待配置 ${pendingProfitCount} 条`
      : null,
    profitNotificationsEnabled && allocatedProfitCount && allocatedProfitCount > 0
      ? `获得分润通知 ${allocatedProfitCount} 条`
      : null,
    overdueInstallmentsEnabled && overdueInstallmentCount && overdueInstallmentCount > 0
      ? `逾期合约 ${overdueInstallmentCount} 个`
      : null,
  ].filter((item): item is string => Boolean(item));
}
