import { useCallback, useEffect, useRef, useState } from "react";
import { listOrders, type OrderRow } from "../../api";
import {
  money,
  orderTypeGlyph,
  orderTypeLabel,
  orderTypeTone,
  profitClass,
  statusLabel,
  statusTone,
} from "../../labels";
import { SearchIcon } from "../../icons";
import { navigate } from "../../router";

const PAGE_SIZE = 20;
const TYPES = [
  { value: "", label: "全部" },
  { value: "HS", label: "回收销售" },
  { value: "TH", label: "提号销售" },
  { value: "DG", label: "代挂" },
];

export function LedgerTab() {
  const [items, setItems] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [orderType, setOrderType] = useState("");
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
        const page = await listOrders({
          limit: PAGE_SIZE,
          offset,
          keyword: keyword.trim() || undefined,
          orderType: orderType || undefined,
        });
        // 快速改筛选时会并发多次请求，只认最后一次的结果，避免旧结果覆盖新筛选。
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
    [keyword, orderType],
  );

  useEffect(() => {
    // 关键词防抖 350ms：手机上每敲一个字就发请求，列表会闪。
    const timer = window.setTimeout(() => void load(0), 350);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <>
      <div className="h5-toolbar">
        <label className="h5-search">
          <SearchIcon />
          <input
            type="search"
            inputMode="search"
            placeholder="搜索单号 / 对方 / 账号"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </label>
        <div className="h5-chips" role="tablist" aria-label="业务类型">
          {TYPES.map((type) => (
            <button
              key={type.value || "all"}
              type="button"
              role="tab"
              aria-selected={orderType === type.value}
              className={`h5-chip${orderType === type.value ? " is-active" : ""}`}
              onClick={() => setOrderType(type.value)}
            >
              {type.label}
            </button>
          ))}
          <span className="h5-chips__count">共 {total}</span>
        </div>
      </div>

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}

      {loading ? (
        <div className="h5-skel-list" aria-label="加载中">
          {[0, 1, 2, 3, 4].map((key) => (
            <div key={key} className="h5-skel-row">
              <span className="h5-skel" style={{ width: 38, height: 38, borderRadius: 11 }} />
              <span>
                <span className="h5-skel" style={{ display: "block", width: "40%", height: 15 }} />
                <span className="h5-skel" style={{ display: "block", width: "76%", height: 12, marginTop: 7 }} />
              </span>
              <span className="h5-skel" style={{ width: 66, height: 15 }} />
            </div>
          ))}
        </div>
      ) : items.length === 0 && !error ? (
        <p className="h5-empty">没有匹配的业务单据</p>
      ) : (
        <ul className="h5-list">
          {items.map((order) => (
            <li key={order.id}>
              <button
                type="button"
                className="h5-row h5-row--link"
                onClick={() => navigate(`/orders/${order.id}`)}
              >
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
                  <span className={profitClass(order.profit_base)}>利润 ¥{money(order.profit_base)}</span>
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
