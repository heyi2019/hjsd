/** 工作台：优先动作 + 当前登录用户的轻量关注卡片。
 * 经营中心保留全局经营总览与人员筛选，工作台只展示当前用户自己的订单/收益。 */
import { useState } from "react";
import { EntryCard, EntryRow, ErrorBanner, PageHeader, PermissionGate, StatRow } from "../shared/ui";
import { CreateBusinessModal, type BusinessOrderType } from "../orders/CreateBusinessModal";
import type { BusinessCenterEntryTab } from "../orders/businessCenter";
import { BusinessAlerts, BusinessOverview } from "./BusinessOverview";
import { useDashboardSummary } from "./useDashboardSummary";

export function DashboardPage({ onNavigate, onPersonalNavigate, active = true }: { onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void; onPersonalNavigate?: (view: "orders" | "earnings") => void; active?: boolean }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<BusinessOrderType>("HS");
  const {
    orderSummary,
    personalOrders,
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
  } = useDashboardSummary(active);
  const openCreate = (orderType: BusinessOrderType) => {
    setCreateType(orderType);
    setCreateOpen(true);
  };
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
