import { useCallback, useEffect, useRef, useState } from "react";
import { listOrders, type OrderRow } from "../api";

const PAGE_SIZE = 20;
const TYPES = [
  { value: "", label: "全部" },
  { value: "HS", label: "回收销售" },
  { value: "TH", label: "提号销售" },
  { value: "DG", label: "代挂" },
];

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

export function OrdersPage() {
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
    <div className="h5-page">
      <header className="h5-pagehead">
        <h1>业务</h1>
        <p>共 {total} 张单据</p>
      </header>

      <div className="h5-toolbar">
        <input
          className="h5-search"
          type="search"
          inputMode="search"
          placeholder="搜索单号 / 对方 / 账号"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
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
        </div>
      </div>

      {error ? <div className="h5-alert h5-alert--error">{error}</div> : null}
      {loading ? <p className="h5-empty">加载中…</p> : null}
      {!loading && items.length === 0 && !error ? <p className="h5-empty">没有匹配的业务单据</p> : null}

      <ul className="h5-list">
        {items.map((order) => (
          <li key={order.id} className="h5-row h5-row--stacked">
            <div className="h5-row__main">
              <div className="h5-row__title">
                <span className="h5-tag">{order.order_type}</span>
                <strong>{order.order_no}</strong>
              </div>
              <p className="h5-row__meta">
                {order.trade_date} · {order.party_name ?? order.account_game_account ?? "—"}
                {order.account_game_type ? ` · ${order.account_game_type}` : ""}
              </p>
            </div>
            <div className="h5-row__side">
              <strong>¥{money(order.event_total)}</strong>
              <span>利润 ¥{money(order.profit_base)}</span>
              <span className={`h5-row__status ${statusClass(order.status)}`}>{STATUS_LABEL[order.status] ?? order.status}</span>
            </div>
          </li>
        ))}
      </ul>

      {items.length < total ? (
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
