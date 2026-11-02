/** 工作台：优先动作 + 当前登录用户的轻量关注卡片。
 * 经营中心保留全局经营总览与人员筛选，工作台只展示当前用户自己的订单/收益。 */
import { useEffect, useRef, useState } from "react";
import { installmentsApi, notificationsApi, optionSetsApi, ordersApi, reportsApi, stocksApi, type Order } from "../shared/api/catalog";
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
  const [orders, setOrders] = useState<Order[]>([]);
  const [personalOrders, setPersonalOrders] = useState<Order[]>([]);
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
    const [personalOrdersResult, ordersResult, earningsResult] = await Promise.allSettled([
      ordersApi.list({ mine: true }),
      ordersApi.list(),
      reportsApi.commission({ mine: true }),
    ]);
    if (!mountedRef.current) return;
    if (personalOrdersResult.status === "fulfilled") {
      setPersonalOrders(personalOrdersResult.value);
      setPersonalOrdersError(null);
    } else {
      setPersonalOrdersError(normalizeError(personalOrdersResult.reason));
    }
    if (ordersResult.status === "fulfilled") {
      setOrders(ordersResult.value);
      setSummaryError(null);
    } else {
      setSummaryError(normalizeError(ordersResult.reason));
    }
    if (earningsResult.status === "fulfilled") {
      setPersonalEarnings(earningsResult.value.total.profit_base);
      setEarningsError(null);
    } else {
      setEarningsError(normalizeError(earningsResult.reason));
    }
    const [stockResult, installmentResult, reminderConfigResult] = await Promise.allSettled([
      stocksApi.list({ status: "WAITING" }),
      installmentsApi.list(),
      optionSetsApi.get(BUSINESS_REMINDER_CONFIG_CODE),
    ]);
    const notificationResult = await Promise.allSettled([
      notificationsApi.list({ limit: 50, unread_only: true }),
    ]);
    if (!mountedRef.current) return;
    const reminderConfig = reminderConfigResult.status === "fulfilled"
      ? parseBusinessReminderConfig(reminderConfigResult.value?.options)
      : DEFAULT_BUSINESS_REMINDER_CONFIG;
    setBusinessReminderConfig(reminderConfig);
    if (stockResult.status === "fulfilled") {
      setInventoryCount(stockResult.value.length);
      // 天数与档位都来自后端（AccountOut）；阈值可配的是「提醒天数」，只做比较不做日期差。
      setInventoryAgingCount(stockResult.value.filter((item) => (item.inventory_age_days ?? 0) > reminderConfig.inventoryAgingDays).length);
      setInventoryOverdueCount(stockResult.value.filter((item) => item.inventory_age_level === "OVERDUE").length);
    } else {
      setInventoryCount(null);
      setInventoryAgingCount(null);
      setInventoryOverdueCount(null);
    }
    if (installmentResult.status === "fulfilled") {
      setInstallmentCount(installmentResult.value.length);
      setOverdueInstallmentCount(installmentResult.value.filter((item) => item.status === "OVERDUE").length);
    } else {
      setInstallmentCount(null);
      setOverdueInstallmentCount(null);
    }
    if (notificationResult[0].status === "fulfilled") {
      setNewProfitNotificationCount(notificationResult[0].value.items.filter((item) =>
        [item.notification_type ?? "", item.title, item.message].some((value) => /分润|利润|提成/.test(value)),
      ).length);
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
    inventoryAgingCount && inventoryAgingCount > 0 ? `库存订单入库超过 7 天 ${inventoryAgingCount} 个` : null,
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
          orders={orders}
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
          personalOrders={personalOrders.length}
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
