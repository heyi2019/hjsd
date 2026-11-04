/**
 * 押金：交进来 → 退还 / 记损失 / 作废。
 *
 * 三条处置口径互斥，不能混：
 *  - 退还（returns）：按金额退，可多次，累计不超过剩余；
 *  - 记损失（losses）：退不回来的一部分，转成支出流水，必须填类别与原因；
 *  - 作废（cancel）：只对「一分没退也没损失」的押金允许，全额冲正。
 * 剩余额一律用后端给的 `remaining_amount`，前端不再自己减。
 */
import { useCallback, useEffect, useState } from "react";
import {
  cancelDeposit,
  loseDeposit,
  listDeposits,
  listPools,
  returnDeposit,
  type DepositRow,
  type PoolRow,
  type SessionUser,
} from "../../../api";
import { ActionSheet, Sheet } from "../../../components/Sheet";
import { DateInput, Field, MoneyInput, TextArea, TextInput } from "../../../forms/controls";
import { depositStatusLabel, depositStatusTone, money, today } from "../../../labels";
import { can } from "../../../perm";
import { navigate } from "../../../router";

type Mode = "return" | "loss" | "cancel";

const MODE_TITLE: Record<Mode, string> = {
  return: "退还押金",
  loss: "登记押金损失",
  cancel: "作废押金",
};

export function DepositsTab({ user }: { user: SessionUser | null }) {
  const [rows, setRows] = useState<DepositRow[]>([]);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [active, setActive] = useState<DepositRow | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [amount, setAmount] = useState("");
  const [onDate, setOnDate] = useState(today());
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState("押金损失");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void Promise.all([listDeposits(), listPools()])
      .then(([depositRows, poolRows]) => {
        if (!alive) return;
        setRows(depositRows);
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

  const openMode = useCallback(
    (row: DepositRow, next: Mode) => {
      setMode(next);
      setReason("");
      setOnDate(today());
      const remaining = Number(row.remaining_amount ?? 0);
      setAmount(next === "return" ? String(remaining || "") : String(remaining || ""));
      setCategory("押金损失");
    },
    [],
  );

  const submit = useCallback(async () => {
    if (!active || !mode) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "return") {
        await returnDeposit(active.id, { amount, released_on: onDate });
      } else if (mode === "loss") {
        if (!reason.trim()) throw new Error("请填写损失原因");
        await loseDeposit(active.id, {
          amount,
          lost_on: onDate,
          category: category.trim() || "押金损失",
          reason: reason.trim(),
        });
      } else {
        if (!reason.trim()) throw new Error("请填写作废原因");
        await cancelDeposit(active.id, { cancelled_on: onDate, reason: reason.trim() });
      }
      setMode(null);
      setActive(null);
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "处理失败");
    } finally {
      setBusy(false);
    }
  }, [active, amount, category, mode, onDate, reason]);

  const canPost = can(user, "deposit.post");
  const remaining = active ? Number(active.remaining_amount ?? 0) : 0;
  const fullyConsumed = active ? remaining <= 0 : true;

  if (loading) return <p className="h5-empty">加载中…</p>;

  return (
    <>
      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}

      {rows.length === 0 ? (
        <p className="h5-empty">还没有押金记录</p>
      ) : (
        <ul className="h5-list">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="h5-row h5-row--link"
                onClick={() => setActive(row)}
              >
                <span className="h5-row__icon h5-row__icon--purple">押</span>
                <div className="h5-row__main">
                  <div className="h5-row__title">
                    <strong>¥{money(row.paid_amount)}</strong>
                    <span className={`h5-pill h5-pill--${depositStatusTone(row.status)}`}>
                      {depositStatusLabel(row.status)}
                    </span>
                  </div>
                  <p className="h5-row__meta">
                    {row.paid_on} · {poolName(row.pool_id)}
                    {row.note ? ` · ${row.note}` : ""}
                  </p>
                </div>
                <div className="h5-row__side">
                  <strong>¥{money(row.remaining_amount ?? 0)}</strong>
                  <span>剩余</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {canPost ? (
        <button type="button" className="h5-more" onClick={() => navigate("/funds/deposits/new")}>
          交一笔押金
        </button>
      ) : null}

      <ActionSheet
        open={active !== null && mode === null}
        title={active ? `押金 ¥${money(active.paid_amount)}` : undefined}
        description={
          active
            ? `剩余 ¥${money(active.remaining_amount ?? 0)} · ${active.paid_on} 交纳`
            : undefined
        }
        onClose={() => setActive(null)}
        actions={[
          {
            key: "return",
            label: "退还押金",
            hint: fullyConsumed ? "已无剩余可退" : `最多可退 ¥${money(remaining)}`,
            disabled: !canPost || fullyConsumed,
            onSelect: () => active && openMode(active, "return"),
          },
          {
            key: "loss",
            label: "登记损失",
            hint: "退不回来的部分转支出",
            disabled: !canPost || fullyConsumed,
            danger: true,
            onSelect: () => active && openMode(active, "loss"),
          },
          {
            key: "cancel",
            label: "作废这笔押金",
            hint:
              (active?.returned_amount && Number(active.returned_amount) > 0) ||
              (active?.lost_amount && Number(active.lost_amount) > 0)
                ? "已发生退还/损失，不能作废"
                : "全额冲正，仅限未退未失的押金",
            disabled:
              !canPost ||
              Boolean(
                (active?.returned_amount && Number(active.returned_amount) > 0) ||
                  (active?.lost_amount && Number(active.lost_amount) > 0),
              ),
            danger: true,
            onSelect: () => active && openMode(active, "cancel"),
          },
        ]}
      />

      <Sheet
        open={mode !== null}
        title={mode ? MODE_TITLE[mode] : undefined}
        description={active ? `剩余 ¥${money(active.remaining_amount ?? 0)}` : undefined}
        onClose={() => setMode(null)}
        footer={
          <div className="h5-sheet__confirm">
            <button type="button" className="h5-ghost" onClick={() => setMode(null)} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className={`h5-primary${mode === "cancel" || mode === "loss" ? " h5-primary--danger" : ""}`}
              onClick={() => void submit()}
              disabled={busy || (mode !== "cancel" && !amount)}
            >
              {busy ? "处理中…" : "确认"}
            </button>
          </div>
        }
      >
        {mode !== "cancel" ? (
          <Field label={mode === "return" ? "退还金额" : "损失金额"} required>
            <MoneyInput value={amount} onChange={setAmount} />
          </Field>
        ) : null}

        <Field label={mode === "cancel" ? "作废日期" : "发生日期"} required>
          <DateInput value={onDate} onChange={setOnDate} />
        </Field>

        {mode === "loss" ? (
          <Field label="支出类别" required hint="落成一条支出流水，类别会进经营报表">
            <TextInput value={category} onChange={setCategory} placeholder="押金损失" />
          </Field>
        ) : null}

        {mode !== "return" ? (
          <Field label="原因" required>
            <TextArea
              value={reason}
              onChange={setReason}
              rows={3}
              placeholder={mode === "cancel" ? "例如：押金收错账户" : "例如：账号被找回，押金不退"}
            />
          </Field>
        ) : null}
      </Sheet>
    </>
  );
}
