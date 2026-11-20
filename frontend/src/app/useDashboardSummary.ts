import { useEffect, useRef, useState } from "react";
import { normalizeError } from "../shared/api/client";
import { dashboardApi, type DashboardSummary } from "../shared/api/dashboard.api";
import { buildDashboardAlertMessages } from "./dashboardSummary";

export function useDashboardSummary(active = true, selectedPeriod?: { from: string; to: string } | null) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  const loadSummary = async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const result = await dashboardApi.summary(selectedPeriod);
      if (!mountedRef.current || request !== requestRef.current) return;
      setSummary(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setSummary(null);
      setError(normalizeError(err));
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (active) void loadSummary();
    return () => { requestRef.current += 1; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, selectedPeriod === null, selectedPeriod?.from, selectedPeriod?.to]);

  const alerts = summary ? buildDashboardAlertMessages({
    inventoryAgingCount: summary.inventory?.aging_count ?? null,
    inventoryAgingDays: summary.reminders.inventory_aging_days,
    pendingProfitCount: summary.notifications.pending_profit_count,
    allocatedProfitCount: summary.notifications.allocated_profit_count,
    profitNotificationsEnabled: summary.reminders.profit_notifications_enabled,
    overdueInstallmentCount: summary.installments?.overdue_count ?? null,
    overdueInstallmentsEnabled: summary.reminders.overdue_installments_enabled,
  }) : [];

  return { summary, error, loading, alerts, loadSummary };
}
