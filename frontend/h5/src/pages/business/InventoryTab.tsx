import { useCallback, useEffect, useRef, useState } from "react";
import { listStocks, type StockRow } from "../../api";
import { money, stockStatusLabel, stockStatusTone } from "../../labels";
import { navigate } from "../../router";

const PAGE_SIZE = 20;

const FILTERS = [
  { value: "", label: "全部" },
  { value: "WAITING", label: "待售" },
  { value: "SOLD", label: "已售" },
];

/** 库龄档位：只在超期时用颜色提示，正常档位不额外着色，避免整屏颜色噪音 */
function ageClass(level: StockRow["inventory_age_level"]): string {
  if (level === "OVERDUE") return "h5-pill--red";
  if (level === "WARNING") return "h5-pill--orange";
  return "h5-pill--gray";
}

export function InventoryTab() {
  const [items, setItems] = useState<StockRow[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const seq = ++requestId.current;
      if (offset === 0) setLoading(true);
      else setLoadingMore(true);
      try {
        const page = await listStocks({ limit: PAGE_SIZE, offset, status: status || undefined });
        // 快速切筛选会并发多次请求，只认最后一次的结果。
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
    [status],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  return (
    <>
      <div className="h5-toolbar h5-toolbar--plain">
        <div className="h5-chips" role="tablist" aria-label="库存状态">
          {FILTERS.map((item) => (
            <button
              key={item.value || "all"}
              type="button"
              role="tab"
              aria-selected={status === item.value}
              className={`h5-chip${status === item.value ? " is-active" : ""}`}
              onClick={() => setStatus(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}

      {loading ? (
        <div className="h5-skel-list" aria-label="加载中">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="h5-skel-row">
              <span className="h5-skel" style={{ width: 38, height: 38, borderRadius: 11 }} />
              <span>
                <span className="h5-skel" style={{ display: "block", width: "44%", height: 15 }} />
                <span className="h5-skel" style={{ display: "block", width: "70%", height: 12, marginTop: 7 }} />
              </span>
              <span className="h5-skel" style={{ width: 60, height: 15 }} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="h5-empty">没有符合条件的库存账号</p>
      ) : (
        <ul className="h5-list">
          {items.map((stock) => (
            <li key={stock.id}>
              <button
                type="button"
                className="h5-row h5-row--link"
                onClick={() => navigate(`/stocks/${stock.id}`)}
              >
                <span className={`h5-row__icon h5-row__icon--${stockStatusTone(stock.status)}`}>库</span>
                <div className="h5-row__main">
                  <div className="h5-row__title">
                    <strong>{stock.stock_no ?? `#${stock.id}`}</strong>
                    <span className={`h5-pill h5-pill--${stockStatusTone(stock.status)}`}>
                      {stockStatusLabel(stock.status)}
                    </span>
                  </div>
                  <p className="h5-row__meta">
                    {stock.game_account ?? "—"}
                    {stock.platform ? ` · ${stock.platform}` : ""}
                    {stock.inventory_age_days !== null && stock.inventory_age_days !== undefined
                      ? ` · 在库 ${stock.inventory_age_days} 天`
                      : ""}
                  </p>
                </div>
                <div className="h5-row__side">
                  <strong>¥{money(stock.cost_amount)}</strong>
                  {stock.inventory_age_level && stock.inventory_age_level !== "NORMAL" ? (
                    <span className={`h5-pill ${ageClass(stock.inventory_age_level)}`}>
                      {stock.inventory_age_level === "OVERDUE" ? "超 30 天" : "超 7 天"}
                    </span>
                  ) : null}
                </div>
              </button>
            </li>
          ))}
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
    </>
  );
}
