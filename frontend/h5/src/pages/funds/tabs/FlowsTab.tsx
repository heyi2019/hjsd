/**
 * 资金流水：列表 + 逐条操作（冲销）。
 *
 * 冲销的口径比按钮看起来窄得多，必须逐个条件判：
 *  - 只有 APPROVED 能冲销（后端 `_get_cashflow` 之后第一句就拦）；
 *  - 业务事件派生的流水（order_event_id）必须回到订单事件里冲销；
 *  - 押金（deposit_id）、划转（transfer_id）必须走原业务流程；
 *  - 冲销流水本身（category=REVERSAL / reversal_of_id）不能再冲销。
 * 与其让用户点出一个必失败的按钮，不如在面板里直接写清原因。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listCashflows, reverseCashflow, type CashflowRow, type SessionUser } from "../../../api";
import { ActionSheet, Sheet } from "../../../components/Sheet";
import { DateInput, Field, TextArea } from "../../../forms/controls";
import { cashflowStatusLabel, cashflowStatusTone, directionLabel, money, today } from "../../../labels";
import { can } from "../../../perm";

const PAGE_SIZE = 20;
const FILTERS = [
  { value: "", label: "全部" },
  { value: "IN", label: "收入" },
  { value: "OUT", label: "支出" },
];

/** 该条流水能否直接冲销；返回 null 表示可以，否则是禁用的原因。 */
function reverseBlockedReason(flow: CashflowRow): string | null {
  if (flow.status !== "APPROVED") return "只有已入账的流水可以冲销";
  if (flow.reversal_of_id) return "这是冲销流水，不能再次冲销";
  if (flow.category === "REVERSAL") return "这是冲销流水，不能再次冲销";
  if (flow.order_event_id) return "业务事件流水请在订单里冲销";
  if (flow.deposit_id) return "押金流水请在押金里退还或作废";
  if (flow.transfer_id) return "划转流水请做反向划转";
  return null;
}

export function FlowsTab({ user }: { user: SessionUser | null }) {
  const [items, setItems] = useState<CashflowRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<CashflowRow | null>(null);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseOn, setReverseOn] = useState(today());
  const [reverseReason, setReverseReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const requestId = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const seq = ++requestId.current;
      if (offset === 0) setLoading(true);
      else setLoadingMore(true);
      try {
        const page = await listCashflows({
          limit: PAGE_SIZE,
          offset,
          direction: filter || undefined,
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
  }, [load, reloadKey]);

  const doReverse = useCallback(async () => {
    if (!active || !reverseReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await reverseCashflow(active.id, { reversed_on: reverseOn, reason: reverseReason.trim() });
      setReverseOpen(false);
      setActive(null);
      setReverseReason("");
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "冲销失败");
    } finally {
      setBusy(false);
    }
  }, [active, reverseOn, reverseReason]);

  const blocked = active ? reverseBlockedReason(active) : null;

  return (
    <>
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
              <li key={flow.id}>
                <button type="button" className="h5-row h5-row--link" onClick={() => setActive(flow)}>
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
                      {flow.order_no ? ` · ${flow.order_no}` : ""}
                    </p>
                  </div>
                  <div className="h5-row__side">
                    <strong className={isIn ? "h5-row__profit--up" : ""}>
                      {isIn ? "+" : "−"}¥{money(flow.amount)}
                    </strong>
                    {flow.note ? <span>{flow.note}</span> : null}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && items.length < total ? (
        <button type="button" className="h5-more" disabled={loadingMore} onClick={() => void load(items.length)}>
          {loadingMore ? "加载中…" : `加载更多（${items.length}/${total}）`}
        </button>
      ) : null}

      <ActionSheet
        open={active !== null}
        title={active ? `${active.flow_no} · ${directionLabel(active.direction)}` : undefined}
        description={
          active
            ? `${active.category} ¥${money(active.amount)} · ${active.occurred_on}${active.note ? ` · ${active.note}` : ""}`
            : undefined
        }
        onClose={() => setActive(null)}
        actions={[
          {
            key: "reverse",
            label: "冲销这笔流水",
            hint: blocked ?? "生成一笔反向流水，原流水保留并标记",
            disabled: Boolean(blocked) || !can(user, "deposit.post"),
            danger: true,
            onSelect: () => {
              setReverseOn(today());
              setReverseReason("");
              setReverseOpen(true);
            },
          },
        ]}
      />

      <Sheet
        open={reverseOpen}
        title="冲销这笔流水"
        description={
          active
            ? `${active.flow_no} · ${directionLabel(active.direction)} ¥${money(active.amount)}。冲销会写入一笔反向流水，原流水保留并标记，不可重复冲销。`
            : undefined
        }
        onClose={() => setReverseOpen(false)}
        footer={
          <div className="h5-sheet__confirm">
            <button type="button" className="h5-ghost" onClick={() => setReverseOpen(false)} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="h5-primary h5-primary--danger"
              onClick={() => void doReverse()}
              disabled={!reverseReason.trim() || busy}
            >
              {busy ? "处理中…" : "确认冲销"}
            </button>
          </div>
        }
      >
        <Field label="冲销日期" required>
          <DateInput value={reverseOn} onChange={setReverseOn} />
        </Field>
        <Field label="冲销原因" required>
          <TextArea
            value={reverseReason}
            onChange={setReverseReason}
            rows={3}
            placeholder="例如：重复登记，原路抹掉"
          />
        </Field>
      </Sheet>
    </>
  );
}
