import { useEffect, useState } from "react";
import {
  fetchCommission,
  fetchInventoryCount,
  listOrders,
  type OrderRow,
  type SessionUser,
} from "../api";
import {
  greeting,
  money,
  orderTypeGlyph,
  orderTypeLabel,
  orderTypeTone,
  statusLabel,
  statusTone,
  today,
} from "../labels";

/** 本月区间：月初 → 今天。收益按「实际发生」计，不把未来日期算进去。 */
function monthRange(): { from: string; to: string } {
  const now = new Date();
  const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  return { from, to: today() };
}

/**
 * 工作台：我的三项数字 + 最近业务。
 *
 * 三个数字的口径（与桌面端工作台完全一致，两端改一处必须同步另一处）：
 *  - 我的订单：`/orders?mine=true` 的总数，即当前登录用户创建/经办的订单；
 *  - 在库账号：`/stocks?status=WAITING` 的总数（不含已售）；
 *  - 我的本月收益：`/reports/commission?mine=true&from=月初&to=今天` 的 `payable`
 *    （本月应得提成），不是订单利润基数——那是整单的利润，不是「我的」。
 *
 * 刻意**不放资金余额卡**：可用资金属于资金中心（`/funds`），从「我的」进入。
 */
export function DashboardPage({
  user,
  onOpenOrders,
  onOpenInventory,
}: {
  user: SessionUser;
  onOpenOrders: () => void;
  onOpenInventory: () => void;
}) {
  const [myOrders, setMyOrders] = useState<number | null>(null);
  const [inventoryCount, setInventoryCount] = useState<number | null>(null);
  const [monthEarnings, setMonthEarnings] = useState<string | null>(null);
  const [todayCount, setTodayCount] = useState<number | null>(null);
  const [recent, setRecent] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const day = today();
    const range = monthRange();
    void Promise.allSettled([
      listOrders({ limit: 1, mine: true }),
      listOrders({ limit: 1, tradeDateFrom: day, tradeDateTo: day }),
      // 「最近业务」只要自己的单；列表接口已按交易日倒序（近 → 远），取 5 条即可。
      listOrders({ limit: 5, mine: true }),
      fetchInventoryCount(),
      fetchCommission({ mine: true, from: range.from, to: range.to }),
    ]).then((results) => {
      if (!alive) return;
      const [mineResult, todayResult, recentResult, stockResult, earningsResult] = results;
      if (mineResult.status === "fulfilled") setMyOrders(mineResult.value.total);
      if (todayResult.status === "fulfilled") setTodayCount(todayResult.value.total);
      if (recentResult.status === "fulfilled") setRecent(recentResult.value.items);
      if (stockResult.status === "fulfilled") setInventoryCount(stockResult.value);
      if (earningsResult.status === "fulfilled") setMonthEarnings(earningsResult.value.total.payable);

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

  return (
    <div className="h5-page">
      <header className="h5-hero">
        <p className="h5-hero__kicker">
          {today()} · {loading ? "工作台" : `今日 ${todayCount ?? 0} 单`}
        </p>
        <h1>{greeting()}，{user.display_name || user.username}</h1>
      </header>

      <div className="h5-stats" aria-label="我的三项数字">
        <button type="button" className="h5-stat" onClick={onOpenOrders}>
          <strong>{loading ? "—" : (myOrders ?? "—")}</strong>
          <span>我的订单</span>
          <em>创建 / 售出订单</em>
        </button>
        <button type="button" className="h5-stat" onClick={onOpenInventory}>
          <strong>{loading ? "—" : (inventoryCount ?? "—")}</strong>
          <span>在库账号</span>
        </button>
        <div className="h5-stat">
          <strong className="h5-stat__money">
            <small>¥</small>
            {loading ? "—" : money(monthEarnings)}
          </strong>
          <span>我的本月收益</span>
          <em>本月应得提成</em>
        </div>
      </div>

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}

      <section className="h5-section">
        <div className="h5-section__head">
          <h2>我的最近业务</h2>
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
