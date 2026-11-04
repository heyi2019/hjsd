import { useCallback, useEffect, useState } from "react";
import { fetchInstallmentTotals, listInstallments, type InstallmentRow } from "../../api";
import {
  contractTypeLabel,
  installmentStatusLabel,
  installmentStatusTone,
  money,
} from "../../labels";

const FILTERS = [
  { value: "", label: "全部" },
  { value: "ACTIVE", label: "还款中" },
  { value: "OVERDUE", label: "逾期" },
  { value: "SETTLED", label: "已结清" },
];

export function CollectionsTab() {
  const [items, setItems] = useState<InstallmentRow[]>([]);
  const [totals, setTotals] = useState<{ total_receivable: string; total_paid: string; total_remaining: string } | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = status ? { status } : undefined;
      // 合计与列表必须同一套筛选：否则切到「逾期」时合计仍显示全量，数字对不上。
      const [rows, sum] = await Promise.all([
        listInstallments(params),
        fetchInstallmentTotals(params),
      ]);
      setItems(rows);
      setTotals(sum);
      setError(null);
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <section className="h5-balance h5-balance--calm" aria-label="分期合计">
        <div className="h5-balance__top">
          <span>待收剩余</span>
          <span className="h5-balance__badge">{items.length} 份合约</span>
        </div>
        <p className="h5-balance__value">
          <small>¥</small>
          {money(totals?.total_remaining)}
        </p>
        <div className="h5-balance__split">
          <div>
            <span>应收合计</span>
            <strong>¥{money(totals?.total_receivable)}</strong>
          </div>
          <div>
            <span>已收合计</span>
            <strong>¥{money(totals?.total_paid)}</strong>
          </div>
        </div>
      </section>

      <div className="h5-toolbar h5-toolbar--plain">
        <div className="h5-chips" role="tablist" aria-label="分期状态">
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
        <p className="h5-empty">加载中…</p>
      ) : items.length === 0 ? (
        <p className="h5-empty">没有符合条件的分期合约</p>
      ) : (
        <ul className="h5-list">
          {items.map((row) => (
            <li key={row.id} className="h5-row">
              <span className={`h5-row__icon h5-row__icon--${installmentStatusTone(row.status)}`}>期</span>
              <div className="h5-row__main">
                <div className="h5-row__title">
                  <strong>{row.inst_no}</strong>
                  <span className={`h5-pill h5-pill--${installmentStatusTone(row.status)}`}>
                    {installmentStatusLabel(row.status)}
                  </span>
                </div>
                <p className="h5-row__meta">
                  {row.order_no ?? "—"} · {contractTypeLabel(row.contract_type)} · 首期{" "}
                  {row.first_due_on ? row.first_due_on.slice(0, 10) : "—"}
                  {row.overdue_periods > 0 ? ` · 逾期 ${row.overdue_periods} 期` : ""}
                </p>
              </div>
              <div className="h5-row__side">
                <strong>¥{money(row.remaining_amount)}</strong>
                <span>已收 ¥{money(row.paid_amount)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
