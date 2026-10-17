/** 工作台：优先动作 + 低负担导航入口。
 * 资金/订单数据总览仍归「经营中心 · 数据中心」，这里不复制数据、不制造假 KPI。 */
import { useEffect, useState } from "react";
import { ordersApi, type Order } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { EntryCard, EntryRow, ErrorBanner, PageHeader, PermissionGate, StatRow } from "../shared/ui";
import { CreateBusinessModal, type BusinessOrderType } from "../orders/CreateBusinessModal";
import type { BusinessCenterEntryTab } from "../orders/businessCenter";

export function DashboardPage({ onNavigate }: { onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<BusinessOrderType>("HS");
  const [orders, setOrders] = useState<Order[]>([]);
  const [summaryError, setSummaryError] = useState<{ message: string; code?: string } | null>(null);
  const loadSummary = async () => {
    try {
      setOrders(await ordersApi.list());
      setSummaryError(null);
    } catch (error) {
      setSummaryError(normalizeError(error));
    }
  };
  useEffect(() => { void loadSummary(); }, []);
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
          <section className="dashboard-entry-group dashboard-entry-group--no-accent dashboard-entry-group--neutral dashboard-entry-group--service" aria-labelledby="dashboard-value-service-title">
            <div className="dashboard-entry-group__heading">
              <h2 id="dashboard-value-service-title">增值服务</h2>
            </div>
            <div className="dashboard-entry-group__items">
              <EntryCard
                title="代分期服务"
                onClick={() => openCreate("DFQ")}
              />
            </div>
          </section>
        </PermissionGate>
      </EntryRow>

      <section className="dashboard-summary" aria-labelledby="dashboard-summary-title">
        <h2 id="dashboard-summary-title" className="dashboard-summary__title">今日关注</h2>
        <ErrorBanner error={summaryError} onRetry={() => void loadSummary()} />
        <StatRow items={[
          { label: "进行中业务", kind: "count", amount: String(orders.filter((order) => order.status === "ACTIVE").length) },
          { label: "已完成业务", kind: "count", amount: String(orders.filter((order) => order.status !== "ACTIVE").length) },
        ]} />
      </section>

      <CreateBusinessModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => setCreateOpen(false)}
        initialOrderType={createType}
      />
    </section>
  );
}
