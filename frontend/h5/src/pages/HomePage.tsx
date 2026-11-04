import { useEffect, useState } from "react";
import { fetchPoolBalances, listOrders, type OrderRow, type PoolBalance, type SessionUser } from "../api";

const ORDER_TYPE_LABEL: Record<string, string> = { HS: "回收销售", TH: "提号销售", DG: "代挂" };
const STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  CONFIRMED: "已确认",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  VOID: "已作废",
};

function statusClass(status: string): string {
  if (status === "COMPLETED") return "h5-row__status--done";
  if (status === "CANCELLED" || status === "VOID") return "h5-row__status--muted";
  return "";
}

function money(value: string | null | undefined): string {
  if (!value) return "0.00";
  const num = Number(value);
  return Number.isFinite(num)
    ? num.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : value;
}

/** 三宫格里的数字列宽只有 ~90px，十万级金额会被截断成「¥111,832....」。
 *  超过一万改按万/亿显示，保证一眼能读完；精确到分的金额在下方资金卡片里。 */
function moneyCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_0000_0000) return `${(value / 1_0000_0000).toFixed(2)}亿`;
  if (abs >= 10000) return `${(value / 10000).toFixed(2)}万`;
  return money(String(value));
}

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function HomePage({ user, onOpenOrders }: { user: SessionUser; onOpenOrders: () => void }) {
  const [pools, setPools] = useState<PoolBalance[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [todayCount, setTodayCount] = useState<number | null>(null);
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
    ]).then((results) => {
      if (!alive) return;
      const [poolResult, totalResult, todayResult, recentResult] = results;
      if (poolResult.status === "fulfilled") setPools(poolResult.value);
      if (totalResult.status === "fulfilled") setTotal(totalResult.value.total);
      if (todayResult.status === "fulfilled") setTodayCount(todayResult.value.total);
      if (recentResult.status === "fulfilled") setRecent(recentResult.value.items);

      // 三块内容任一失败都要让用户看见，而不是显示成 0（0 和「没加载到」后果完全不同）。
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

  return (
    <div className="h5-page">
      <header className="h5-hero">
        <p className="h5-hero__kicker">工作台</p>
        <h1>你好，{user.display_name || user.username}</h1>
        <p className="h5-hero__meta">{today()}</p>

        <div className="h5-metrics">
          <div className="h5-metric">
            <span>可用资金</span>
            <strong>{loading ? "—" : `¥${moneyCompact(available)}`}</strong>
          </div>
          <div className="h5-metric">
            <span>今日单量</span>
            <strong>{loading ? "—" : (todayCount ?? "—")}</strong>
          </div>
          <div className="h5-metric">
            <span>累计订单</span>
            <strong>{loading ? "—" : (total ?? "—")}</strong>
          </div>
        </div>
      </header>

      <section className="h5-section">
        <div className="h5-section__head">
          <h2>资金账户</h2>
        </div>
        <div className="h5-cards">
          <div className="h5-card">
            <span className="h5-card__label">投资款 · HJ_INVEST</span>
            <strong className="h5-card__value">¥{money(investPool?.available)}</strong>
          </div>
          <div className="h5-card">
            <span className="h5-card__label">利润 · HJ_PROFIT</span>
            <strong className="h5-card__value">¥{money(profitPool?.available)}</strong>
          </div>
        </div>
      </section>

      <section className="h5-section">
        <div className="h5-section__head">
          <h2>最近业务</h2>
          <button type="button" className="h5-link" onClick={onOpenOrders}>全部</button>
        </div>

        {error ? <div className="h5-alert h5-alert--error">{error}</div> : null}
        {loading ? <p className="h5-empty">加载中…</p> : null}
        {!loading && recent.length === 0 ? <p className="h5-empty">暂无业务单据</p> : null}

        <ul className="h5-list">
          {recent.map((order) => (
            <li key={order.id} className="h5-row">
              <div className="h5-row__main">
                <div className="h5-row__title">
                  <span className="h5-tag">{ORDER_TYPE_LABEL[order.order_type] ?? order.order_type}</span>
                  <strong>{order.order_no}</strong>
                </div>
                <p className="h5-row__meta">
                  {order.trade_date} · {order.party_name ?? order.account_game_account ?? "—"}
                </p>
              </div>
              <div className="h5-row__side">
                <strong>¥{money(order.event_total)}</strong>
                <span className={`h5-row__status ${statusClass(order.status)}`}>{STATUS_LABEL[order.status] ?? order.status}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
