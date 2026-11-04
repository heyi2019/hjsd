/**
 * 资金账户：池内余额一览。系统只有 Pool 一级（没有 PoolAccount），
 * 余额 = 池内已入账流水的有符号和，所以这里不提供「改余额」，只有划转。
 */
import { useEffect, useState } from "react";
import { fetchPoolBalances, type PoolBalance } from "../../../api";
import { money } from "../../../labels";

export function PoolsTab() {
  const [pools, setPools] = useState<PoolBalance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void fetchPoolBalances()
      .then((rows) => {
        if (alive) setPools(rows);
      })
      .catch((issue: Error) => {
        if (alive) setError(issue.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <p className="h5-empty">加载中…</p>;
  if (error) return <div className="h5-alert h5-alert--error" role="alert">{error}</div>;

  return (
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
  );
}
