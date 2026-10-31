/** 工作台：优先动作 + 当前登录用户的轻量关注卡片。
 * 经营中心保留全局经营总览与人员筛选，工作台只展示当前用户自己的订单/收益。 */
import { useEffect, useRef, useState } from "react";
import { ordersApi, reportsApi, type Order } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { EntryCard, EntryRow, ErrorBanner, PageHeader, PermissionGate, StatRow } from "../shared/ui";
import { CreateBusinessModal, type BusinessOrderType } from "../orders/CreateBusinessModal";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import type { BusinessCenterEntryTab } from "../orders/businessCenter";

export function DashboardPage({ onNavigate, onPersonalNavigate, active = true }: { onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void; onPersonalNavigate?: (view: "orders" | "earnings") => void; active?: boolean }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<BusinessOrderType>("HS");
  const [orders, setOrders] = useState<Order[]>([]);
  const [personalOrders, setPersonalOrders] = useState<Order[]>([]);
  const [summaryError, setSummaryError] = useState<{ message: string; code?: string } | null>(null);
  const [personalOrdersError, setPersonalOrdersError] = useState<{ message: string; code?: string } | null>(null);
  const [personalEarnings, setPersonalEarnings] = useState<string | null>(null);
  const [earningsError, setEarningsError] = useState<{ message: string; code?: string } | null>(null);
  const mountedRef = useRef(true);
  const loadSummary = async () => {
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

      <section className="dashboard-summary" aria-labelledby="dashboard-summary-title">
        <h2 id="dashboard-summary-title" className="dashboard-summary__title">今日关注</h2>
        <ErrorBanner error={summaryError} onRetry={() => void loadSummary()} />
        <StatRow items={[
          /* summaryError 非空表示汇总接口失败：此时 orders 仍是初始 []，
             若照常取 .length 会把「加载失败」显示成「0 笔业务」，用户在经营场景会误判
             （「0」有确定的业务含义）。StatRow 契约规定 amount 为 null 时显示 "-"，
             这里直接复用该失败态占位。 */
          { label: "进行中业务", kind: "count", amount: summaryError ? null : String(orders.filter((order) => order.status === "ACTIVE").length) },
          { label: "已完成业务", kind: "count", amount: summaryError ? null : String(orders.filter((order) => order.status !== "ACTIVE").length) },
        ]} />
      </section>

      <section className="dashboard-summary" aria-labelledby="dashboard-personal-summary-title">
        <h2 id="dashboard-personal-summary-title" className="dashboard-summary__title">我的关注</h2>
        <ErrorBanner error={personalOrdersError ?? earningsError} onRetry={() => void loadSummary()} />
        <StatRow items={[
          { label: "我的订单", kind: "count", amount: personalOrdersError ? null : String(personalOrders.length), hint: "创建 / 售出订单", onClick: () => onPersonalNavigate?.("orders") },
          { label: "我的收益", amount: earningsError ? null : personalEarnings, hint: "当前登录用户分润", onClick: () => onPersonalNavigate?.("earnings") },
        ]} />
      </section>

      <CreateBusinessModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          // 建单成功后同步刷新「今日关注」计数；业务台账的刷新由 OrdersPage 的 active 重拉机制负责。
          void loadSummary();
        }}
        initialOrderType={createType}
      />
    </section>
  );
}
