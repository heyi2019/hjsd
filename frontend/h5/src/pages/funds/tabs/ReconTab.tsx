/**
 * 日对账：一个资金池 + 一天 + 一个账户标签 只能对一次（后端有唯一性校验）。
 *
 * 状态只有 OPEN（有差异，待处理）与 RESOLVED（已核销）。差异为 0 的当天也照样
 * 入库成 OPEN 还是 RESOLVED 由后端判定，前端不猜 —— 只按返回的 status 渲染。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listPools,
  listReconciliations,
  resolveReconciliation,
  type PoolRow,
  type ReconciliationRow,
  type SessionUser,
} from "../../../api";
import { Sheet } from "../../../components/Sheet";
import { TextArea } from "../../../forms/controls";
import { money, reconciliationStatusLabel, reconciliationStatusTone } from "../../../labels";
import { can } from "../../../perm";
import { navigate } from "../../../router";

export function ReconTab({ user }: { user: SessionUser | null }) {
  const [rows, setRows] = useState<ReconciliationRow[]>([]);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ReconciliationRow | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void Promise.all([listReconciliations(), listPools()])
      .then(([reconRows, poolRows]) => {
        if (!alive) return;
        setRows(reconRows);
        setPools(poolRows);
        setError(null);
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
  }, [reloadKey]);

  const poolName = useCallback(
    (id: number) => pools.find((pool) => pool.id === id)?.name ?? `#${id}`,
    [pools],
  );

  const doResolve = useCallback(async () => {
    if (!active || !reason.trim()) return;
    setBusy(true);
    try {
      await resolveReconciliation(active.id, reason.trim());
      setActive(null);
      setReason("");
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "处理失败");
    } finally {
      setBusy(false);
    }
  }, [active, reason]);

  const canPost = can(user, "deposit.post");
  const list = useMemo(() => rows, [rows]);

  if (loading) return <p className="h5-empty">加载中…</p>;

  return (
    <>
      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}

      {list.length === 0 ? (
        <p className="h5-empty">还没有对账记录</p>
      ) : (
        <ul className="h5-list">
          {list.map((row) => {
            const diff = Number(row.difference ?? 0);
            return (
              <li key={row.id}>
                <button
                  type="button"
                  className="h5-row h5-row--link"
                  onClick={() => {
                    if (row.status === "OPEN" && canPost) {
                      setActive(row);
                      setReason(row.reason ?? "");
                    }
                  }}
                >
                  <span className={`h5-row__icon h5-row__icon--${diff === 0 ? "green" : "orange"}`}>
                    {diff === 0 ? "平" : "差"}
                  </span>
                  <div className="h5-row__main">
                    <div className="h5-row__title">
                      <strong>{row.account_label}</strong>
                      <span className={`h5-pill h5-pill--${reconciliationStatusTone(row.status)}`}>
                        {reconciliationStatusLabel(row.status)}
                      </span>
                    </div>
                    <p className="h5-row__meta">
                      {row.reconciled_on} · {poolName(row.pool_id)}
                    </p>
                    <p className="h5-row__meta">
                      账面 ¥{money(row.system_balance)} / 实盘 ¥{money(row.statement_balance)}
                    </p>
                  </div>
                  <div className="h5-row__side">
                    <strong className={diff === 0 ? "" : "h5-row__profit--down"}>
                      {diff === 0 ? "无差异" : `${diff > 0 ? "+" : "−"}¥${money(Math.abs(diff))}`}
                    </strong>
                    {row.status === "OPEN" && canPost ? <span>点此处理</span> : null}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Sheet
        open={active !== null}
        title="处理对账差异"
        description={
          active
            ? `${active.reconciled_on} · ${active.account_label} · 差异 ¥${money(active.difference)}`
            : undefined
        }
        onClose={() => setActive(null)}
        footer={
          <div className="h5-sheet__confirm">
            <button type="button" className="h5-ghost" onClick={() => setActive(null)} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="h5-primary"
              onClick={() => void doResolve()}
              disabled={!reason.trim() || busy}
            >
              {busy ? "处理中…" : "标记已核销"}
            </button>
          </div>
        }
      >
        <label className="h5-field">
          <div className="h5-field__label"><label>差异原因 / 处理说明</label></div>
          <TextArea
            value={reason}
            onChange={setReason}
            rows={3}
            placeholder="例如：银行手续费未入账，已在 12 月补记"
          />
        </label>
      </Sheet>

      {canPost ? (
        <button type="button" className="h5-more" onClick={() => navigate("/funds/reconciliations/new")}>
          新建一次对账
        </button>
      ) : null}
    </>
  );
}
