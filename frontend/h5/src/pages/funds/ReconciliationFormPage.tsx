/**
 * 新建一次日对账：某账户在某天的「账面 vs 实盘」快照。
 *
 * 两个前端口径：
 *  - 账面余额由后端算（`system_balance`），前端只填**实盘**数字，不做任何减法；
 *  - 同一资金池 + 同一天 + 同一账户标签只能对一次，重复会被后端拒绝，
 *    所以这里不做「已存在则更新」，冲突时直接把后端原话展示出来。
 */
import { useCallback, useEffect, useState } from "react";
import {
  createReconciliation,
  listPools,
  type PoolRow,
  type ReconciliationRow,
} from "../../api";
import {
  DateInput,
  Field,
  FormError,
  FormPage,
  FormSection,
  MoneyInput,
  PickerField,
  SubmitBar,
  TextArea,
  TextInput,
} from "../../forms/controls";
import { money, today } from "../../labels";
import { goBack, navigate } from "../../router";

export function ReconciliationFormPage() {
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [poolId, setPoolId] = useState("");
  const [onDate, setOnDate] = useState(today());
  const [accountLabel, setAccountLabel] = useState("");
  const [statement, setStatement] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<ReconciliationRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void listPools()
      .then((rows) => {
        if (alive) setPools(rows.filter((pool) => pool.status !== "INACTIVE"));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const submit = useCallback(async () => {
    const next: Record<string, string> = {};
    if (!poolId) next.pool_id = "请选择资金账户";
    if (!accountLabel.trim()) next.account_label = "请填写对账账户";
    if (statement === "") next.statement = "请填写实盘余额";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      const row = await createReconciliation({
        pool_id: Number(poolId),
        reconciled_on: onDate,
        account_label: accountLabel.trim(),
        statement_balance: statement,
        reason: reason.trim() || undefined,
        note: note.trim() || undefined,
      });
      setCreated(row);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "对账失败";
      // 账面由后端算，前端无从预判是否有差异；后端要求「有差异必须写原因」，
      // 这里把这条 422 归位到原因字段上，而不是丢一条飘在页顶的报错。
      if (message.includes("差异原因")) setErrors({ reason: message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [accountLabel, note, onDate, poolId, reason, statement]);

  // 对完账先看差异，再决定回列表还是继续对下一个账户。
  if (created) {
    const diff = Number(created.difference ?? 0);
    return (
      <FormPage
        title="对账结果"
        onBack={() => navigate("/funds/reconciliations", true)}
        footer={
          <SubmitBar
            label="回到对账列表"
            onClick={() => navigate("/funds/reconciliations", true)}
            secondary={{
              label: "再对一笔",
              onClick: () => {
                setCreated(null);
                setAccountLabel("");
                setStatement("");
                setNote("");
              },
            }}
          />
        }
      >
        <FormSection title={created.account_label}>
          <div className="h5-figures">
            <div>
              <span>账面余额</span>
              <strong>¥{money(created.system_balance)}</strong>
            </div>
            <div>
              <span>实盘余额</span>
              <strong>¥{money(created.statement_balance)}</strong>
            </div>
            <div>
              <span>差异</span>
              <strong className={diff === 0 ? "" : "h5-row__profit--down"}>
                {diff === 0 ? "无差异" : `¥${money(diff)}`}
              </strong>
            </div>
          </div>
          <p className="h5-footnote">
            {diff === 0
              ? "账面与实盘一致，本次对账已核销。"
              : "存在差异，请到对账列表点开这一条填写原因后核销。"}
          </p>
        </FormSection>
      </FormPage>
    );
  }

  return (
    <FormPage
      title="新建对账"
      onBack={() => goBack("/funds/reconciliations")}
      footer={<SubmitBar label="提交对账" busy={busy} onClick={() => void submit()} />}
    >
      <FormError error={error} />

      <FormSection title="对账对象">
        <PickerField
          label="资金账户"
          required
          value={poolId}
          options={pools.map((pool) => ({ value: String(pool.id), label: pool.name, hint: pool.code }))}
          searchable
          onChange={setPoolId}
          placeholder="选择要核对的账户"
          error={errors.pool_id}
        />
        <Field label="对账日期" required>
          <DateInput value={onDate} onChange={setOnDate} />
        </Field>
        <Field
          label="对账账户"
          required
          hint="区分同一资金池下的多个实体：农行 8678 / 支付宝 / 微信"
          error={errors.account_label}
        >
          <TextInput
            value={accountLabel}
            onChange={setAccountLabel}
            placeholder="例如：农行 8678"
          />
        </Field>
        <Field label="实盘余额" required error={errors.statement}>
          <MoneyInput value={statement} onChange={setStatement} placeholder="0.00" />
        </Field>
        <Field
          label="差异原因"
          required={Boolean(errors.reason)}
          error={errors.reason}
          hint="账面与实盘不一致时必填；一致可留空"
        >
          <TextArea
            value={reason}
            onChange={setReason}
            rows={2}
            placeholder="例如：银行手续费未入账"
          />
        </Field>
        <Field label="说明">
          <TextArea value={note} onChange={setNote} rows={2} placeholder="可选" />
        </Field>
      </FormSection>

      <p className="h5-footnote">
        账面余额由系统按已入账流水汇总，前端不填；差异会留成待处理项，处理完才算核销。
      </p>
    </FormPage>
  );
}
