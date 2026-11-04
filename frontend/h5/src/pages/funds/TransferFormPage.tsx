/**
 * 账户间划转（内部调拨）。
 *
 * 这是唯一正确的「把钱从一个账户挪到另一个账户」的做法：后端写两腿成对流水
 * （转出腿 + 转入腿，共享 transfer_id），既不进损益也不影响净头寸。
 * 用「记一笔支出 + 记一笔收入」代替会虚增当月支出与收入，经营报表直接失真。
 */
import { useCallback, useEffect, useState } from "react";
import { createTransfer, listPools, type PoolRow } from "../../api";
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

export function TransferFormPage() {
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState(today());
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

  const options = pools.map((pool) => ({ value: String(pool.id), label: pool.name, hint: pool.code }));

  const submit = useCallback(async () => {
    const next: Record<string, string> = {};
    if (!fromId) next.from = "请选择转出账户";
    if (!toId) next.to = "请选择转入账户";
    if (fromId && toId && fromId === toId) next.to = "转出与转入不能是同一个账户";
    if (!amount || Number(amount) <= 0) next.amount = "请填写金额";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      await createTransfer({
        source_pool_id: Number(fromId),
        target_pool_id: Number(toId),
        amount,
        occurred_on: occurredOn,
        note: note.trim() || undefined,
      });
      navigate("/funds/pools", true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "划转失败");
    } finally {
      setBusy(false);
    }
  }, [amount, fromId, note, occurredOn, toId]);

  return (
    <FormPage
      title="账户划转"
      subtitle="内部调拨，不进损益"
      onBack={() => goBack("/funds/pools")}
      footer={<SubmitBar label="确认划转" busy={busy} onClick={() => void submit()} />}
    >
      <FormError error={error} />

      <FormSection title="转出与转入">
        <PickerField
          label="转出账户"
          required
          value={fromId}
          options={options}
          searchable
          onChange={setFromId}
          placeholder="钱从哪里出"
          error={errors.from}
        />
        <PickerField
          label="转入账户"
          required
          value={toId}
          options={options.filter((option) => option.value !== fromId)}
          searchable
          onChange={setToId}
          placeholder="钱进到哪个账户"
          error={errors.to}
        />
        <Field label="金额" required error={errors.amount}>
          <MoneyInput value={amount} onChange={setAmount} placeholder="0.00" />
        </Field>
        <Field label="划转日期" required>
          <DateInput value={occurredOn} onChange={setOccurredOn} />
        </Field>
        <Field label="备注">
          <TextArea value={note} onChange={setNote} rows={2} placeholder="例如：农行卡转支付宝余额" />
        </Field>
      </FormSection>

      <p className="h5-footnote">
        划转会生成转出与转入两条成对流水，两边金额相同、方向相反，净头寸不变。
      </p>
    </FormPage>
  );
}
