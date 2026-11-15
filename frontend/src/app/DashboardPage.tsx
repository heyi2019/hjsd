/** 工作台：优先动作 + 当前登录用户的轻量关注卡片。
 * 经营中心保留全局经营总览与人员筛选，工作台只展示当前用户自己的订单/收益。 */
import { useEffect, useRef, useState } from "react";
import { installmentsApi } from "../shared/api/installments.api";
import { notificationsApi } from "../shared/api/misc.api";
import { optionSetsApi } from "../shared/api/options.api";
import { ordersApi } from "../shared/api/orders.api";
import { reportsApi } from "../shared/api/reports.api";
import { stocksApi } from "../shared/api/stocks.api";
import { normalizeError } from "../shared/api/client";
import { EntryCard, EntryRow, ErrorBanner, PageHeader, PermissionGate, StatRow } from "../shared/ui";
import { CreateBusinessModal, type BusinessOrderType } from "../orders/CreateBusinessModal";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import type { BusinessCenterEntryTab } from "../orders/businessCenter";
import { BusinessAlerts, BusinessOverview } from "./BusinessOverview";
import {
  BUSINESS_REMINDER_CONFIG_CODE,
  DEFAULT_BUSINESS_REMINDER_CONFIG,
  parseBusinessReminderConfig,
  type BusinessReminderConfig,
} from "./businessReminderConfig";

export function DashboardPage({ onNavigate, onPersonalNavigate, active = true }: { onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void; onPersonalNavigate?: (view: "orders" | "earnings") => void; active?: boolean }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<BusinessOrderType>("HS");
  const [orderSummary, setOrderSummary] = useState<{ total_count: number; completed_count: number } | null>(null);
  const [personalOrders, setPersonalOrders] = useState(0);
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
  const [newProfitNotificationCount, setNewProfitNotificationCount] = useState<number | null>(null);
  const [businessReminderConfig, setBusinessReminderConfig] = useState<BusinessReminderConfig>(DEFAULT_BUSINESS_REMINDER_CONFIG);
  const mountedRef = useRef(true);
  const loadSummary = async () => {
    setSummaryLoading(true);
    // 「我的本月收益」按自然月至今统计：跨月不清零的话，月初会和上月混在一起。
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const monthEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const [personalOrdersResult, orderSummaryResult, earningsResult] = await Promise.allSettled([
      ordersApi.summary({ mine: true }),
      ordersApi.summary(),
      reportsApi.commission({ mine: true, from: monthStart, to: monthEnd }),
    ]);
    if (!mountedRef.current) return;
    if (personalOrdersResult.status === "fulfilled") {
      setPersonalOrders(personalOrdersResult.value.total_count);
      setPersonalOrdersError(null);
    } else {
      setPersonalOrdersError(normalizeError(personalOrdersResult.reason));
    }
    if (orderSummaryResult.status === "fulfilled") {
      setOrderSummary(orderSummaryResult.value);
      setSummaryError(null);
    } else {
      setOrderSummary(null);
      setSummaryError(normalizeError(orderSummaryResult.reason));
    }
    if (earningsResult.status === "fulfilled") {
      // payable 才是「我这份」分润；profit_base 是整单利润基数，不是个人收益。
      setPersonalEarnings(earningsResult.value.total.payable);
      setEarningsError(null);
    } else {
      setEarningsError(normalizeError(earningsResult.reason));
    }
    const [installmentResult, reminderConfigResult] = await Promise.allSettled([
      installmentsApi.totals(),
      optionSetsApi.get(BUSINESS_REMINDER_CONFIG_CODE),
    ]);
    const reminderConfig = reminderConfigResult.status === "fulfilled"
      ? parseBusinessReminderConfig(reminderConfigResult.value?.options)
      : DEFAULT_BUSINESS_REMINDER_CONFIG;
    setBusinessReminderConfig(reminderConfig);
    const [stockResult, notificationResult] = await Promise.allSettled([
      stocksApi.dashboardSummary(reminderConfig.inventoryAgingDays),
      notificationsApi.summary(),
    ]);
    if (!mountedRef.current) return;
    if (stockResult.status === "fulfilled") {
      setInventoryCount(stockResult.value.account_count);
      setInventoryAgingCount(stockResult.value.aging_count);
      setInventoryOverdueCount(stockResult.value.overdue_count);
    } else {
      setInventoryCount(null);
      setInventoryAgingCount(null);
      setInventoryOverdueCount(null);
    }
    if (installmentResult.status === "fulfilled") {
      setInstallmentCount(installmentResult.value.total_count);
      setOverdueInstallmentCount(installmentResult.value.overdue_count);
    } else {
      setInstallmentCount(null);
      setOverdueInstallmentCount(null);
    }
    if (notificationResult.status === "fulfilled") {
      setNewProfitNotificationCount(notificationResult.value.unread_profit_total);
    } else {
      setNewProfitNotificationCount(null);
    }
    setSummaryLoading(false);
  };
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);
  // keep-alive：工作台常驻挂载，重新激活时重拉汇总，避免其他页面完成的业务不反映在计数里。
  useReloadOnActive(active, loadSummary);
  const openCreate = (orderType: BusinessOrderType) => {
    setCreateType(orderType);
    setCreateOpen(true);
  };
  const businessAlerts = [
    inventoryAgingCount && inventoryAgingCount > 0 ? `库存订单入库超过 ${businessReminderConfig.inventoryAgingDays} 天 ${inventoryAgingCount} 个` : null,
    businessReminderConfig.profitNotificationsEnabled && newProfitNotificationCount && newProfitNotificationCount > 0 ? `新的分润通知 ${newProfitNotificationCount} 条` : null,
    businessReminderConfig.overdueInstallmentsEnabled && overdueInstallmentCount && overdueInstallmentCount > 0 ? `逾期合约 ${overdueInstallmentCount} 个` : null,
  ].filter((item): item is string => Boolean(item));
  return (
    <section className="ui-stack dashboard-page">
      <PageHeader
        title="今天从这里开始"
      />
      <EntryRow>
      <PermissionGate permission="order.create">
        <section className="dashboard-entry-group dashboard-entry-group--no-accent dashboard-entry-group--sell" aria-labelledby="dashboard-sell-title">
          <div className="dashboard-entry-group__heading">
            <h2 id="dashboard-sell-title">售出</h2>
          </div>
          <div className="dashboard-entry-group__items">
            <EntryCard
              tone="primary"
              eyebrow="主推入口"
              title="售出库存账号"
              onClick={() => onNavigate?.("business", "inventory")}
            />
          </div>
        </section>
        <section className="dashboard-entry-group dashboard-entry-group--no-accent dashboard-entry-group--self-owned" aria-labelledby="dashboard-self-owned-title">
          <div className="dashboard-entry-group__heading">
            <h2 id="dashboard-self-owned-title">自营</h2>
          </div>
          <div className="dashboard-entry-group__items">
            <EntryCard
              eyebrow="高频业务"
              title="自营·回收"
              onClick={() => openCreate("HS")}
            />
          </div>
        </section>
          <section className="dashboard-entry-group dashboard-entry-group--no-accent dashboard-entry-group--neutral dashboard-entry-group--distribution" aria-labelledby="dashboard-distribution-title">
            <div className="dashboard-entry-group__heading">
              <h2 id="dashboard-distribution-title">分销</h2>
            </div>
            <div className="dashboard-entry-group__items">
              <EntryCard
                title="提号"
                onClick={() => openCreate("TH")}
              />
              <EntryCard
                title="代挂"
                onClick={() => openCreate("DG")}
              />
            </div>
          </section>
        </PermissionGate>
      </EntryRow>

      <div className="dashboard-summary">
        <h2 id="dashboard-summary-title" className="dashboard-summary__title">我的业务总览</h2>
        <ErrorBanner error={summaryError} onRetry={() => void loadSummary()} />
        <BusinessOverview
          orderSummary={orderSummary}
          inventoryCount={inventoryCount}
          inventoryAgingCount={inventoryAgingCount}
          inventoryOverdueCount={inventoryOverdueCount}
          installmentCount={installmentCount}
          newProfitNotificationCount={newProfitNotificationCount}
          overdueInstallmentCount={overdueInstallmentCount}
          profitNotificationsEnabled={businessReminderConfig.profitNotificationsEnabled}
          overdueInstallmentsEnabled={businessReminderConfig.overdueInstallmentsEnabled}
          ordersError={Boolean(summaryError)}
          loading={summaryLoading}
          personalOrders={personalOrders}
          personalOrdersError={Boolean(personalOrdersError)}
          onPersonalOrdersClick={() => onPersonalNavigate?.("orders")}
          personalEarnings={personalEarnings}
          personalEarningsError={Boolean(earningsError)}
          onPersonalEarningsClick={() => onPersonalNavigate?.("earnings")}
        />
        <ErrorBanner error={earningsError} onRetry={() => void loadSummary()} />
        <BusinessAlerts alerts={businessAlerts} loading={summaryLoading} />
      </div>

      <CreateBusinessModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          // 建单成功后同步刷新「今日关注」计数；订单台账的刷新由 OrdersPage 的 active 重拉机制负责。
          void loadSummary();
        }}
        initialOrderType={createType}
      />
    </section>
  );
}
