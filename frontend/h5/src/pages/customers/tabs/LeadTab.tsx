/**
 * 需求线索池：客户说「我想找个某某号」，先记成需求，成单时再转成订单。
 *
 * 状态只有两种有效流转：OPEN → CONVERTED（已转单）/ OPEN → CLOSED（已关闭）。
 * 转单必须指定已存在的订单号 —— 需求本身不能凭空生成订单，它只是「意向」。
 */
import { useCallback, useEffect, useState } from "react";
import { listCustomers, listLeads, type CustomerRow, type LeadRow } from "../../../api";
import { money } from "../../../labels";
import { navigate } from "../../../router";

const REQUEST_TYPE_LABEL: Record<string, string> = {
  FIND_ACCOUNT: "找号",
  SELL_ACCOUNT: "卖号",
  SPECIFIC_SEARCH: "指定找号",
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: "跟进中",
  CONVERTED: "已转单",
  CLOSED: "已关闭",
};

const FILTERS = [
  { value: "OPEN", label: "跟进中" },
  { value: "", label: "全部" },
];

export function LeadTab() {
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [filter, setFilter] = useState("OPEN");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [leadRows, customerPage] = await Promise.all([listLeads(), listCustomers({ limit: 500 })]);
      setLeads(leadRows);
      setCustomers(customerPage.items ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (id: number) => customers.find((customer) => customer.id === id)?.display_name ?? `#${id}`;
  const visible = filter ? leads.filter((lead) => lead.status === filter) : leads;

  return (
    <>
      <div className="h5-toolbar h5-toolbar--plain">
        <div className="h5-chips" role="tablist" aria-label="需求状态">
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
          <span className="h5-chips__count">共 {visible.length}</span>
        </div>
      </div>

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}

      {loading ? (
        <p className="h5-empty">加载中…</p>
      ) : visible.length === 0 ? (
        <p className="h5-empty">没有需求记录</p>
      ) : (
        <ul className="h5-list">
          {visible.map((lead) => (
            <li key={lead.id}>
              <button
                type="button"
                className="h5-row h5-row--link"
                onClick={() => navigate(`/leads/${lead.id}`)}
              >
                <span className={`h5-row__icon h5-row__icon--${lead.status === "OPEN" ? "orange" : "gray"}`}>
                  {REQUEST_TYPE_LABEL[lead.request_type]?.slice(0, 1) ?? "需"}
                </span>
                <div className="h5-row__main">
                  <div className="h5-row__title">
                    <strong>{nameOf(lead.customer_id)}</strong>
                    <span className={`h5-pill h5-pill--${lead.status === "OPEN" ? "orange" : "gray"}`}>
                      {STATUS_LABEL[lead.status] ?? lead.status}
                    </span>
                  </div>
                  <p className="h5-row__meta">
                    {REQUEST_TYPE_LABEL[lead.request_type] ?? lead.request_type} · {lead.target}
                  </p>
                </div>
                {lead.budget ? (
                  <div className="h5-row__side">
                    <strong>¥{money(lead.budget)}</strong>
                  </div>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
