import { useEffect, useState } from "react";
import {
  fetchPoolBalances,
  fetchStockTotal,
  listOrders,
  type OrderRow,
  type PoolBalance,
  type SessionUser,
} from "../api";
import {
  greeting,
  money,
  moneyWan,
  orderTypeGlyph,
  orderTypeLabel,
  orderTypeTone,
  statusLabel,
  statusTone,
  today,
} from "../labels";

export function DashboardPage({ user, onOpenOrders }: { user: SessionUser; onOpenOrders: () => void }) {
  const [pools, setPools] = useState<PoolBalance[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [todayCount, setTodayCount] = useState<number | null>(null);
  const [stockTotal, setStockTotal] = useState<number | null>(null);
  const [recent, setRecent] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const day = today();
    void Promise.allSettled([
      fetchPoolBalances(),
      listOrders({ limit: 1 }),
      listOrders({ limit: 1, tradeDateFrom: day, tradeDateTo: day }),
      listOrders({ limit: 5 }),
      fetchStockTotal(),
    ]).then((results) => {
      if (!alive) return;
      const [poolResult, totalResult, todayResult, recentResult, stockResult] = results;
      if (poolResult.status === "fulfilled") setPools(poolResult.value);
      if (totalResult.status === "fulfilled") setTotal(totalResult.value.total);
      if (todayResult.status === "fulfilled") setTodayCount(todayResult.value.total);
      if (recentResult.status === "fulfilled") setRecent(recentResult.value.items);
      if (stockResult.status === "fulfilled") setStockTotal(stockResult.value);

      // 任一块失败都要让用户看见，而不是显示成 0（0 和「没加载到」后果完全不同）。
      const failed = results.find((item) => item.status === "rejected");
      if (failed && failed.status === "rejected") {
        setError((failed.reason as Error)?.message ?? "数据加载失败");
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const available = pools.reduce((sum, pool) => sum + Number(pool.available ?? 0), 0);
  const profitPool = pools.find((pool) => pool.pool_code === "HJ_PROFIT");
  const investPool = pools.find((pool) => pool.pool_code === "HJ_INVEST");
  const availableText = moneyWan(available);

  return (
    <div className="h5-page">
      <header className="h5-hero">
        <p className="h5-hero__kicker">{today()} · 工作台</p>
        <h1>{greeting()}，{user.display_name || user.username}</h1>
      </header>

      <section className="h5-balance" aria-label="资金总览">
        <div className="h5-balance__top">
          <span>可用资金</span>
          <span className="h5-balance__badge">{pools.length ? `${pools.length} 个账户` : "未同步"}</span>
        </div>
        <p className="h5-balance__value">
          {loading ? (
            "—"
          ) : (
            <>
              <small>¥</small>
              {availableText.text}
              {availableText.unit ? <span className="h5-balance__unit">{availableText.unit}</span> : null}
            </>
          )}
        </p>
        <div className="h5-balance__split">
          <div>
            <span>投资款 · HJ_INVEST</span>
            <strong>¥{money(investPool?.available)}</strong>
          </div>
          <div>
            <span>利润 · HJ_PROFIT</span>
            <strong>¥{money(profitPool?.available)}</strong>
          </div>
        </div>
      </section>

      <div className="h5-stats">
        <div className="h5-stat">
          <strong>{loading ? "—" : (todayCount ?? "—")}</strong>
          <span>今日单量</span>
        </div>
        <div className="h5-stat">
          <strong>{loading ? "—" : (total ?? "—")}</strong>
          <span>累计订单</span>
        </div>
        <div className="h5-stat">
          <strong>{loading ? "—" : (stockTotal ?? "—")}</strong>
          <span>在库账号</span>
        </div>
      </div>

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}

      <section className="h5-section">
        <div className="h5-section__head">
          <h2>最近业务</h2>
          <button type="button" className="h5-link" onClick={onOpenOrders}>全部</button>
        </div>

        {loading ? (
          <div className="h5-skel-list" aria-label="加载中">
            {[0, 1, 2].map((key) => (
              <div key={key} className="h5-skel-row">
                <span className="h5-skel" style={{ width: 38, height: 38, borderRadius: 11 }} />
                <span>
                  <span className="h5-skel" style={{ display: "block", width: "46%", height: 15 }} />
                  <span className="h5-skel" style={{ display: "block", width: "72%", height: 12, marginTop: 7 }} />
                </span>
                <span className="h5-skel" style={{ width: 62, height: 15 }} />
              </div>
            ))}
          </div>
        ) : recent.length === 0 ? (
          <p className="h5-empty">暂无业务单据</p>
        ) : (
          <ul className="h5-list">
            {recent.map((order) => (
              <li key={order.id} className="h5-row">
                <span className={`h5-row__icon h5-row__icon--${orderTypeTone(order.order_type)}`}>
                  {orderTypeGlyph(order.order_type)}
                </span>
                <div className="h5-row__main">
                  <div className="h5-row__title">
                    <strong>{order.order_no}</strong>
                    <span className={`h5-pill h5-pill--${statusTone(order.status)}`}>
                      {statusLabel(order.status)}
                    </span>
                  </div>
                  <p className="h5-row__meta">
                    {orderTypeLabel(order.order_type)} · {order.trade_date} ·{" "}
                    {order.party_name ?? order.account_game_account ?? "—"}
                  </p>
                </div>
                <div className="h5-row__side">
                  <strong>¥{money(order.event_total)}</strong>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
