import { useCallback, useEffect, useRef, useState } from "react";
import { listCustomers, type CustomerRow } from "../../api";
import { customerStatusLabel } from "../../labels";
import { SearchIcon } from "../../icons";
import { navigate } from "../../router";

const PAGE_SIZE = 20;
const FILTERS = [
  { value: "", label: "全部" },
  { value: "ACTIVE", label: "正常" },
  { value: "DISABLED", label: "已停用" },
];

function statusTone(status: string): string {
  if (status === "ACTIVE") return "green";
  if (status === "MERGED") return "blue";
  return "gray";
}

export function CustomersPage() {
  const [items, setItems] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState("");
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
        const page = await listCustomers({
          limit: PAGE_SIZE,
          offset,
          keyword: keyword.trim() || undefined,
          status: status || undefined,
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
    [keyword, status],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(0), 350);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <div className="h5-page">
      <header className="h5-pagehead">
        <div className="h5-pagehead__row">
          <div>
            <h1>客户</h1>
            <p>{total ? `共 ${total} 位客户` : "客户与合作方档案"}</p>
          </div>
          <button type="button" className="h5-pagehead__action" onClick={() => navigate("/customers/new")}>
            新建
          </button>
        </div>
      </header>

      <div className="h5-toolbar">
        <label className="h5-search">
          <SearchIcon />
          <input
            type="search"
            inputMode="search"
            placeholder="搜索姓名 / 手机号 / 编号"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </label>
        <div className="h5-chips" role="tablist" aria-label="客户状态">
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
          {[0, 1, 2, 3, 4].map((key) => (
            <div key={key} className="h5-skel-row">
              <span className="h5-skel" style={{ width: 38, height: 38, borderRadius: 19 }} />
              <span>
                <span className="h5-skel" style={{ display: "block", width: "45%", height: 15 }} />
                <span className="h5-skel" style={{ display: "block", width: "66%", height: 12, marginTop: 7 }} />
              </span>
              <span className="h5-skel" style={{ width: 40, height: 15 }} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="h5-empty">没有匹配的客户</p>
      ) : (
        <ul className="h5-list">
          {items.map((customer) => (
            <li key={customer.id}>
              <button
                type="button"
                className="h5-row h5-row--link"
                onClick={() => navigate(`/customers/${customer.id}`)}
              >
                <span className={`h5-row__icon h5-row__icon--${statusTone(customer.status)}`}>
                  {customer.display_name.slice(0, 1)}
                </span>
                <div className="h5-row__main">
                  <div className="h5-row__title">
                    <strong>{customer.display_name}</strong>
                    <span className={`h5-pill h5-pill--${statusTone(customer.status)}`}>
                      {customerStatusLabel(customer.status)}
                    </span>
                  </div>
                  <p className="h5-row__meta">
                    {customer.customer_no}
                    {customer.phone ? ` · ${customer.phone}` : ""}
                    {customer.source ? ` · ${customer.source}` : ""}
                  </p>
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
    </div>
  );
}
