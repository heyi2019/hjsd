/**
 * 交一笔押金：押金不是支出，而是「占用」。
 *
 * 后端在池上单独记 `deposit_held`，可用资金 = 现金 − 押金占用，
 * 所以押金必须走 `/deposits`，不能用「记一笔支出」代替 —— 后者会直接虚增成本。
 */
import { useCallback, useEffect, useState } from "react";
import { createDeposit, listPools, type PoolRow } from "../../api";
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
} from "../../forms/controls";
import { today } from "../../labels";
import { goBack, navigate } from "../../router";

export function DepositFormPage() {
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [poolId, setPoolId] = useState("");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today());
  const [releaseOn, setReleaseOn] = useState("");
  const [note, setNote] = useState("");
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
    if (!amount || Number(amount) <= 0) next.amount = "请填写押金金额";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      await createDeposit({
        pool_id: Number(poolId),
        amount,
        paid_on: paidOn,
        expected_release_on: releaseOn || null,
        note: note.trim() || null,
      });
      navigate("/funds/deposits", true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登记失败");
    } finally {
      setBusy(false);
    }
  }, [amount, note, paidOn, poolId, releaseOn]);

  return (
    <FormPage
      title="交押金"
      subtitle="占用资金，不计成本"
      onBack={() => goBack("/funds/deposits")}
      footer={<SubmitBar label="登记押金" busy={busy} onClick={() => void submit()} />}
    >
      <FormError error={error} />

      <FormSection title="押金信息">
        <PickerField
          label="资金账户"
          required
          value={poolId}
          options={pools.map((pool) => ({ value: String(pool.id), label: pool.name, hint: pool.code }))}
          searchable
          onChange={setPoolId}
          placeholder="押金从哪个账户出"
          error={errors.pool_id}
        />
        <Field label="押金金额" required error={errors.amount}>
          <MoneyInput value={amount} onChange={setAmount} placeholder="0.00" />
        </Field>
        <Field label="交纳日期" required>
          <DateInput value={paidOn} onChange={setPaidOn} />
        </Field>
        <Field label="预计退还日期" hint="填了会在押金列表里提示，不填也可以">
          <DateInput value={releaseOn} onChange={setReleaseOn} />
        </Field>
        <Field label="备注">
          <TextArea value={note} onChange={setNote} rows={2} placeholder="例如：交给同行 A 的账号押金" />
        </Field>
      </FormSection>

      <p className="h5-footnote">押金只占用可用资金；退不回来的部分请到押金列表里「登记损失」。</p>
    </FormPage>
  );
}
