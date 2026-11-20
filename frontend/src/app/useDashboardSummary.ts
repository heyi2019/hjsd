import { useEffect, useRef, useState } from "react";
import { normalizeError } from "../shared/api/client";
import { dashboardApi } from "../shared/api/dashboard.api";
import { DEFAULT_BUSINESS_REMINDER_CONFIG, type BusinessReminderConfig } from "./businessReminderConfig";
import { buildDashboardAlertMessages } from "./dashboardSummary";

export function useDashboardSummary(active = true, selectedPeriod?: { from: string; to: string } | null) {
  const [orderSummary, setOrderSummary] = useState<{ total_count: number; completed_count: number } | null>(null);
  const [personalOrders, setPersonalOrders] = useState<number | null>(null);
  const [personalCustomers, setPersonalCustomers] = useState<number | null>(null);
  const [summaryError, setSummaryError] = useState<{ message: string; code?: string } | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [personalOrdersError, setPersonalOrdersError] = useState<{ message: string; code?: string } | null>(null);
  const [personalEarnings, setPersonalEarnings] = useState<string | null>(null);
  const [earningsError, setEarningsError] = useState<{ message: string; code?: string } | null>(null);
  const [inventoryCount, setInventoryCount] = useState<number | null>(null);
  const [inventoryAgingCount, setInventoryAgingCount] = useState<number | null>(null);
  const [inventoryOverdueCount, setInventoryOverdueCount] = useState<number | null>(null);
  const [installmentCount, setInstallmentCount] = useState<number | null>(null);
  const [overdueInstallmentCount, setOverdueInstallmentCount] = useState<number | null>(null);
  const [pendingProfitCount, setPendingProfitCount] = useState<number | null>(null);
  const [allocatedProfitCount, setAllocatedProfitCount] = useState<number | null>(null);
  const [businessReminderConfig, setBusinessReminderConfig] = useState<BusinessReminderConfig>(DEFAULT_BUSINESS_REMINDER_CONFIG);
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  const loadSummary = async () => {
    const request = ++requestRef.current;
    setSummaryLoading(true);
    try {
      const summary = await dashboardApi.summary(selectedPeriod);
      if (!mountedRef.current || request !== requestRef.current) return;
      setPeriod(summary.period);
      setOrderSummary(summary.orders ? {
        total_count: summary.orders.total_count,
        completed_count: summary.orders.completed_count,
      } : null);
      setSummaryError(null);
      setPersonalOrders(summary.personal_orders);
      setPersonalOrdersError(null);
      setPersonalCustomers(summary.personal_customers);
      setPersonalEarnings(summary.personal_earnings == null ? null : String(summary.personal_earnings));
      setEarningsError(null);
      setInventoryCount(summary.inventory?.account_count ?? null);
      setInventoryAgingCount(summary.inventory?.aging_count ?? null);
      setInventoryOverdueCount(summary.inventory?.overdue_count ?? null);
      setInstallmentCount(summary.installments?.total_count ?? null);
      setOverdueInstallmentCount(summary.installments?.overdue_count ?? null);
      setPendingProfitCount(summary.notifications.pending_profit_count);
      setAllocatedProfitCount(summary.notifications.allocated_profit_count);
      setBusinessReminderConfig({
        inventoryAgingDays: summary.reminders.inventory_aging_days,
        profitNotificationsEnabled: summary.reminders.profit_notifications_enabled,
        overdueInstallmentsEnabled: summary.reminders.overdue_installments_enabled,
      });
    } catch (err) {
      if (!mountedRef.current || request !== requestRef.current) return;
      const error = normalizeError(err);
      setOrderSummary(null);
      setPeriod(null);
      setSummaryError(error);
      setPersonalOrdersError(error);
      setPersonalOrders(null);
      setPersonalCustomers(null);
      setPersonalEarnings(null);
      setEarningsError(null);
      setInventoryCount(null);
      setInventoryAgingCount(null);
      setInventoryOverdueCount(null);
      setInstallmentCount(null);
      setOverdueInstallmentCount(null);
      setPendingProfitCount(null);
      setAllocatedProfitCount(null);
    } finally {
      if (mountedRef.current && request === requestRef.current) setSummaryLoading(false);
    }
  };

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);
  useEffect(() => {
    if (active) void loadSummary();
    return () => { requestRef.current += 1; };
  // 仅在激活或日期变化时重查；loadSummary 本身每次渲染都会重建。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, selectedPeriod === null, selectedPeriod?.from, selectedPeriod?.to]);

  const businessAlerts = buildDashboardAlertMessages({
    inventoryAgingCount,
    inventoryAgingDays: businessReminderConfig.inventoryAgingDays,
    pendingProfitCount,
    allocatedProfitCount,
    profitNotificationsEnabled: businessReminderConfig.profitNotificationsEnabled,
    overdueInstallmentCount,
    overdueInstallmentsEnabled: businessReminderConfig.overdueInstallmentsEnabled,
  });

  return {
    orderSummary,
    period,
    personalOrders,
    personalCustomers,
    summaryError,
    summaryLoading,
    personalOrdersError,
    personalEarnings,
    earningsError,
    inventoryCount,
    inventoryAgingCount,
    inventoryOverdueCount,
    installmentCount,
    overdueInstallmentCount,
    businessReminderConfig,
    businessAlerts,
    loadSummary,
  };
}
