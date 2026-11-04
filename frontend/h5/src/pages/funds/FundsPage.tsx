import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchPoolBalances,
  listCashflows,
  type CashflowRow,
  type PoolBalance,
} from "../../api";
import { cashflowStatusLabel, cashflowStatusTone, money } from "../../labels";

const PAGE_SIZE = 20;
const FILTERS = [
  { value: "", label: "全部" },
  { value: "IN", label: "收入" },
  { value: "OUT", label: "支出" },
  { value: "PENDING", label: "待审核" },
];

export function FundsPage() {
  const [pools, setPools] = useState<PoolBalance[]>([]);
  const [items, setItems] = useState<CashflowRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    void fetchPoolBalances()
      .then(setPools)
      .catch((issue: Error) => setError(issue.message));
  }, []);

  const load = useCallback(
    async (offset: number) => {
      const seq = ++requestId.current;
      if (offset === 0) setLoading(true);
      else setLoadingMore(true);
      try {
        // 「待审核」不是方向，而是状态：两者不能塞进同一个参数，否则会互相覆盖。
        const isStatus = filter === "PENDING";
        const page = await listCashflows({
          limit: PAGE_SIZE,
          offset,
          direction: isStatus ? undefined : filter || undefined,
          status: isStatus ? "PENDING" : undefined,
        });
        if (seq !== requestId.current) return;
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setTotal(page.total);
        setError(null);
      } catch (issue) {
        if (seq === requestId.current) setError((issue as Error).message);
      } finally {
        if (seq === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filter],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const available = pools.reduce((sum, pool) => sum + Number(pool.available ?? 0), 0);

  return (
    <div className="h5-page">
      <header className="h5-pagehead">
        <h1>资金</h1>
        <p>账户余额与流水</p>
      </header>

      <section className="h5-balance" aria-label="资金总览">
        <div className="h5-balance__top">
          <span>可用资金</span>
          <span className="h5-balance__badge">{pools.length} 个账户</span>
        </div>
        <p className="h5-balance__value">
          <small>¥</small>
          {money(available)}
        </p>
        <div className="h5-balance__split">
          <div>
            <span>现金头寸</span>
            <strong>¥{money(pools.reduce((sum, pool) => sum + Number(pool.cash_balance ?? 0), 0))}</strong>
          </div>
          <div>
            <span>押金占用</span>
            <strong>¥{money(pools.reduce((sum, pool) => sum + Number(pool.deposit_held ?? 0), 0))}</strong>
          </div>
        </div>
      </section>

      <section className="h5-section">
        <div className="h5-section__head"><h2>资金账户</h2></div>
        <ul className="h5-list">
          {pools.map((pool) => (
            <li key={pool.pool_id} className="h5-row">
              <span className="h5-row__icon h5-row__icon--blue">户</span>
              <div className="h5-row__main">
                <div className="h5-row__title">
                  <strong>{pool.pool_code}</strong>
                </div>
                <p className="h5-row__meta">
                  现金 ¥{money(pool.cash_balance)}
                  {Number(pool.deposit_held) > 0 ? ` · 押金 ¥${money(pool.deposit_held)}` : ""}
                </p>
              </div>
              <div className="h5-row__side">
                <strong>¥{money(pool.available)}</strong>
                <span>可用</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="h5-toolbar h5-toolbar--plain">
        <div className="h5-chips" role="tablist" aria-label="流水筛选">
          {FILTERS.map((item) => (
            <button
              key={item.value || "all"}
              type="button"
              role="tab"
              aria-selected={filter === item.value}
              className={`h5-chip${filter === item.value ? " is-active" : ""}`}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
          <span className="h5-chips__count">共 {total}</span>
        </div>
      </div>

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}

      {loading ? (
        <p className="h5-empty">加载中…</p>
      ) : items.length === 0 ? (
        <p className="h5-empty">没有符合条件的流水</p>
      ) : (
        <ul className="h5-list">
          {items.map((flow) => {
            const isIn = flow.direction === "IN";
            return (
              <li key={flow.id} className="h5-row">
                <span className={`h5-row__icon h5-row__icon--${isIn ? "green" : "red"}`}>
                  {isIn ? "收" : "支"}
                </span>
                <div className="h5-row__main">
                  <div className="h5-row__title">
                    <strong>{flow.flow_no}</strong>
                    <span className={`h5-pill h5-pill--${cashflowStatusTone(flow.status)}`}>
                      {cashflowStatusLabel(flow.status)}
                    </span>
                  </div>
                  <p className="h5-row__meta">
                    {flow.category} · {flow.occurred_on}
                  </p>
                </div>
                <div className="h5-row__side">
                  <strong className={isIn ? "h5-row__profit--up" : ""}>
                    {isIn ? "+" : "−"}¥{money(flow.amount)}
                  </strong>
                  {flow.note ? <span>{flow.note}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && items.length < total ? (
        <button
          type="button"
          className="h5-more"
          disabled={loadingMore}
          onClick={() => void load(items.length)}
        >
          {loadingMore ? "加载中…" : `加载更多（${items.length}/${total}）`}
        </button>
      ) : null}
    </div>
  );
}
