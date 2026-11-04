/**
 * 合作方（同行 / 供货方 / 平台 / 中介）列表。
 *
 * 与客户的区别：合作方是「对端主体」，按单参与角色（PEER / SUPPLIER / PLATFORM…），
 * 而客户每一单的角色都可能不同。所以这里按 `type` 筛选，而不是按「角色」。
 */
import { useCallback, useEffect, useState } from "react";
import { listCounterparties, type CounterpartyRow } from "../../../api";
import { SearchIcon } from "../../../icons";
import { navigate } from "../../../router";

const TYPE_LABEL: Record<string, string> = {
  PEER: "同行",
  SUPPLIER: "供货方",
  PLATFORM: "平台",
  INTERMEDIARY: "中介",
};

const TYPES = [
  { value: "", label: "全部" },
  { value: "PEER", label: "同行" },
  { value: "SUPPLIER", label: "供货方" },
  { value: "PLATFORM", label: "平台" },
  { value: "INTERMEDIARY", label: "中介" },
];

export function CounterpartyTab() {
  const [items, setItems] = useState<CounterpartyRow[]>([]);
  const [type, setType] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listCounterparties({ type: type || undefined }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = items.filter((item) => {
    const query = keyword.trim().toLowerCase();
    if (!query) return true;
    return [item.display_name, item.counterparty_no, item.contact_name, item.phone, item.wechat]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  return (
    <>
      <div className="h5-toolbar">
        <label className="h5-search">
          <SearchIcon />
          <input
            type="search"
            inputMode="search"
            placeholder="搜索名称 / 编号 / 联系方式"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </label>
        <div className="h5-chips" role="tablist" aria-label="合作方类型">
          {TYPES.map((item) => (
            <button
              key={item.value || "all"}
              type="button"
              role="tab"
              aria-selected={type === item.value}
              className={`h5-chip${type === item.value ? " is-active" : ""}`}
              onClick={() => setType(item.value)}
            >
              {item.label}
            </button>
          ))}
          <span className="h5-chips__count">共 {filtered.length}</span>
        </div>
      </div>

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}

      {loading ? (
        <p className="h5-empty">加载中…</p>
      ) : filtered.length === 0 ? (
        <p className="h5-empty">还没有合作方档案</p>
      ) : (
        <ul className="h5-list">
          {filtered.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="h5-row h5-row--link"
                onClick={() => navigate(`/counterparties/${row.id}/edit`)}
              >
                <span className={`h5-row__icon h5-row__icon--${row.status === "ACTIVE" ? "blue" : "gray"}`}>
                  {row.display_name.slice(0, 1)}
                </span>
                <div className="h5-row__main">
                  <div className="h5-row__title">
                    <strong>{row.display_name}</strong>
                    <span className="h5-pill h5-pill--gray">{TYPE_LABEL[row.type] ?? row.type}</span>
                  </div>
                  <p className="h5-row__meta">
                    {row.counterparty_no}
                    {row.contact_name ? ` · ${row.contact_name}` : ""}
                    {row.phone ? ` · ${row.phone}` : ""}
                    {row.status !== "ACTIVE" ? " · 已停用" : ""}
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
