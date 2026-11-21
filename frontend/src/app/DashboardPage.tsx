/** 工作台：优先动作 + 当前登录用户的轻量关注卡片。
 * 经营中心保留全局经营总览与人员筛选，工作台只展示当前用户自己的订单/收益。 */
import { Card } from "antd";
import { normalizeError } from "../shared/api/client";
import { notificationsApi } from "../shared/api/notifications.api";
import { ErrorBanner, PageHeader } from "../shared/ui";
import { appMessage } from "../shared/ui/appFeedback";
import type { BusinessCenterEntryTab } from "../business/businessCenter";
import { QuickAccess } from "./workbench/quick-access/QuickAccess";
import { BusinessOverview } from "./workbench/overview/BusinessOverview";
import { BusinessAlerts } from "./workbench/notifications/BusinessAlerts";
import { useDashboardSummary } from "./workbench/overview/useDashboardSummary";
import { useBusinessPeriod } from "../shared/state/businessPeriod";
import { BusinessPeriodPicker } from "../shared/ui/BusinessPeriodPicker";

export function DashboardPage({ onNavigate, onDashboardNavigate, active = true }: { onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void; onDashboardNavigate?: (path: string) => void; active?: boolean }) {
  const periodState = useBusinessPeriod();
  const { summary, error, loading, loadSummary } = useDashboardSummary(active && periodState.ready, periodState.period);
  const period = summary?.period ?? null;
  const withPeriod = (path: string) => {
    if (!period) return path;
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}trade_date_from=${encodeURIComponent(period.from)}&trade_date_to=${encodeURIComponent(period.to)}`;
  };
  const openDashboardPath = (path: string) => onDashboardNavigate?.(path);
  const openPendingProfitAllocation = async (notificationId?: number) => {
    if (!onDashboardNavigate) return;
    try {
      const target = await notificationsApi.pendingOrder(notificationId);
      if (!target.order_no) {
        appMessage.warning("没有找到待配置分润的订单");
        return;
      }
      if (target.order_id === null) {
        appMessage.warning(`未找到订单 ${target.order_no}`);
        return;
      }
      onDashboardNavigate(`/business/ledger?allocation_order_id=${target.order_id}&keyword=${encodeURIComponent(target.order_no)}`);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };
  return (
    <section className="ui-stack dashboard-page">
      <PageHeader
        title="今天从这里开始"
      />
      <QuickAccess onNavigate={onNavigate} onCreated={() => void loadSummary()} />

      <div className="dashboard-summary">
        <Card className="glass" title="我的业务总览">
        <div className="ui-filter-bar ui-filter-bar--spaced"><BusinessPeriodPicker state={periodState} showAll /></div>
        <ErrorBanner error={periodState.error ? { message: periodState.error } : null} onRetry={periodState.retry} />
        <ErrorBanner error={error} onRetry={() => void loadSummary()} />
        <BusinessOverview
          orderCount={summary?.orders?.total_count ?? null}
          inventoryCount={summary?.inventory?.account_count ?? null}
          inventoryOverdueCount={summary?.inventory?.overdue_count ?? null}
          installmentCount={summary?.installments?.total_count ?? null}
          overdueInstallmentCount={summary?.installments?.overdue_count ?? null}
          loading={loading}
          allPeriods={periodState.period === null}
          personalOrders={summary?.personal_orders ?? null}
          personalCustomers={summary?.personal_customers ?? null}
          onPersonalOrdersClick={() => openDashboardPath(withPeriod("/business/ledger?mine=true"))}
          onPersonalCustomersClick={() => onDashboardNavigate ? openDashboardPath(withPeriod("/customers?mine_orders=true")) : undefined}
          personalEarnings={summary?.personal_earnings ?? null}
          onPersonalEarningsClick={() => openDashboardPath(period
              ? `/operations?tab=my-earnings&from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`
              : "/operations?tab=my-earnings&period=all")}
          onInventoryClick={() => openDashboardPath("/business/inventory")}
          onOrdersClick={() => openDashboardPath(withPeriod("/business/ledger"))}
          onInstallmentsClick={() => openDashboardPath("/business/collections")}
          onOverdueInstallmentsClick={() => openDashboardPath("/business/collections?status=OVERDUE")}
          onInventoryOverdueClick={() => openDashboardPath("/business/inventory?age_gt_days=30")}
        />
        </Card>
        <BusinessAlerts
          onPartyNavigate={onDashboardNavigate}
          onPendingProfitNotificationsClick={(notificationId) => void openPendingProfitAllocation(notificationId)}
          onProfitNotificationsRead={() => void loadSummary()}
          active={active}
        />
      </div>
    </section>
  );
}
