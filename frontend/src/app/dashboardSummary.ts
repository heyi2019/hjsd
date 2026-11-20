export interface DashboardAlertInputs {
  inventoryAgingCount: number | null;
  inventoryAgingDays: number;
  pendingProfitCount: number | null;
  allocatedProfitCount: number | null;
  profitNotificationsEnabled: boolean;
  overdueInstallmentCount: number | null;
  overdueInstallmentsEnabled: boolean;
}

export interface DashboardAlert {
  type: "inventory_aging" | "pending_profit" | "allocated_profit" | "overdue_installment";
  message: string;
}

export function buildDashboardAlertMessages({
  inventoryAgingCount,
  inventoryAgingDays,
  pendingProfitCount,
  allocatedProfitCount,
  profitNotificationsEnabled,
  overdueInstallmentCount,
  overdueInstallmentsEnabled,
}: DashboardAlertInputs): DashboardAlert[] {
  return [
    inventoryAgingCount && inventoryAgingCount > 0
      ? { type: "inventory_aging" as const, message: `库存订单入库超过 ${inventoryAgingDays} 天 ${inventoryAgingCount} 个` }
      : null,
    profitNotificationsEnabled && pendingProfitCount && pendingProfitCount > 0
      ? { type: "pending_profit" as const, message: `分润待配置 ${pendingProfitCount} 条` }
      : null,
    profitNotificationsEnabled && allocatedProfitCount && allocatedProfitCount > 0
      ? { type: "allocated_profit" as const, message: `获得分润通知 ${allocatedProfitCount} 条` }
      : null,
    overdueInstallmentsEnabled && overdueInstallmentCount && overdueInstallmentCount > 0
      ? { type: "overdue_installment" as const, message: `逾期合约 ${overdueInstallmentCount} 个` }
      : null,
  ].filter((item): item is DashboardAlert => item !== null);
}
