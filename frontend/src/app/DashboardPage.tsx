/** 工作台：优先动作 + 低负担导航入口。
 * 资金/订单数据总览仍归「经营中心 · 数据中心」，这里不复制数据、不制造假 KPI。 */
import { useEffect, useState } from "react";
import { ordersApi, type Order } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { EntryCard, EntryRow, ErrorBanner, PageHeader, PermissionGate, StatRow } from "../shared/ui";
import { CreateBusinessModal } from "../orders/CreateBusinessModal";

export function DashboardPage({ onNavigate }: { onNavigate?: (key: string, tab?: string) => void }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState("HS");
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
  const openCreate = (orderType: string) => {
    setCreateType(orderType);
    setCreateOpen(true);
  };
  return (
    <section className="ui-stack dashboard-page">
      <PageHeader
        title="今天从这里开始"
        description="先处理最重要的动作；业务数据与经营指标分别在对应中心查看。"
      />
      <EntryRow>
      <PermissionGate permission="order.create">
        <section className="dashboard-sell-group" aria-labelledby="dashboard-sell-title">
          <div className="dashboard-business-group__heading">
            <h2 id="dashboard-sell-title">售出</h2>
            <span>回收 / 提号 / 代挂 库存账号的统一出售入口</span>
          </div>
          <div className="dashboard-sell-group__items">
            <EntryCard
              tone="primary"
              title="售出库存账号"
              description="从库存中心选择任意渠道（回收 / 提号 / 代挂）的账号售出"
              onClick={() => onNavigate?.("business", "inventory")}
            />
          </div>
        </section>
        <section className="dashboard-business-group dashboard-self-owned-group" aria-labelledby="dashboard-self-owned-title">
          <div className="dashboard-business-group__heading">
            <h2 id="dashboard-self-owned-title">自营</h2>
            <span>内部货源：回收后进入库存，再售出</span>
          </div>
          <div className="dashboard-business-group__items">
            <EntryCard
              title="自营·回收"
              description="录入游戏账号、来源与回收费用，创建回收单"
              onClick={() => openCreate("HS")}
            />
          </div>
        </section>
          <section className="dashboard-distribution-group" aria-labelledby="dashboard-distribution-title">
            <div className="dashboard-distribution-group__heading">
              <h2 id="dashboard-distribution-title">分销</h2>
              <span>提号、代挂两个订单类型</span>
            </div>
            <div className="dashboard-distribution-group__items">
              <EntryCard
                title="分销·提号"
                description="登记提号业务与同行交付信息"
                onClick={() => openCreate("TH")}
              />
              <EntryCard
                title="分销·代挂"
                description="登记委托账号与代挂服务信息"
                onClick={() => openCreate("DG")}
              />
            </div>
          </section>
          <section className="dashboard-value-service-group" aria-labelledby="dashboard-value-service-title">
            <div className="dashboard-business-group__heading">
              <h2 id="dashboard-value-service-title">增值服务</h2>
              <span>可附着在自营或分销业务上</span>
            </div>
            <EntryCard
              title="代分期服务"
              description="为客户代付剩余号款，再按期收回"
              onClick={() => openCreate("DFQ")}
            />
          </section>
        </PermissionGate>
      </EntryRow>

      <section className="dashboard-summary" aria-labelledby="dashboard-summary-title">
        <h2 id="dashboard-summary-title" className="dashboard-summary__title">今日关注</h2>
        <ErrorBanner error={summaryError} onRetry={() => void loadSummary()} />
        <StatRow items={[
          { label: "待处理业务", kind: "count", amount: String(orders.filter((order) => order.status === "ACTIVE").length) },
          { label: "已完成业务", kind: "count", amount: String(orders.filter((order) => order.status !== "ACTIVE").length) },
        ]} />
      </section>

      <div className="dashboard-note" role="note">
        <span className="dashboard-note__eyebrow">工作提示</span>
        <strong>需要快速开始时，从一个明确动作开始。</strong>
        <span className="muted">待处理事项会在对应业务中心内按状态显示，不在工作台重复堆叠。</span>
      </div>

      <CreateBusinessModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => setCreateOpen(false)}
        initialOrderType={createType}
      />
    </section>
  );
}
