/**
 * 记一笔收支（独立资金流水）。
 *
 * 三个必须守住的口径：
 *  1) **提交即入账**：后端独立流水直接写 APPROVED，系统没有「审核/驳回」，
 *     所以这里也没有「提交审核」这种措辞——它骗人。
 *  2) **性质决定必需项**：`EXTERNAL_IN`（外部/借款）后端强制要求摘要，
 *     前端必须提前拦；`BUSINESS_OUT` 的类别进经营报表，不能空。
 *  3) **金额是字符串**：一路原样传到后端由 `to_money` 收敛，前端不做浮点运算。
 */
import { useCallback, useEffect, useState } from "react";
import { createCashflow, listPools, type PoolRow } from "../../api";
import {
  ChipField,
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
import { useOptionSet } from "../../forms/useOptionSets";
import { today } from "../../labels";
import { goBack, navigate } from "../../router";

type Direction = "IN" | "OUT";

/** 支出科目兜底：词典没加载出来时也得能记账（与桌面端 STUDIO_EXPENSE_ITEM 同名）。 */
const FALLBACK_EXPENSES = ["房租", "日用", "水电", "物业", "其他"];
const INCOME_ITEMS = ["货款", "退款", "其他"];

export function CashflowFormPage() {
  const pools: PoolRow[] = usePoolSetPools();
  const expenseItems = useOptionSet("STUDIO_EXPENSE_ITEM");

  const [direction, setDirection] = useState<Direction>("OUT");
  const [nature, setNature] = useState("BUSINESS_OUT");
  const [category, setCategory] = useState("");
  const [customCategory, setCustomCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState(today());
  const [poolId, setPoolId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const items = direction === "OUT"
    ? (expenseItems.length > 0 ? expenseItems.map((item) => item.value) : FALLBACK_EXPENSES)
    : INCOME_ITEMS;

  // 换方向时把性质与类别一起重置：留着上一个方向的类别必然记错科目。
  useEffect(() => {
    setNature(direction === "IN" ? "BUSINESS_IN" : "BUSINESS_OUT");
    setCategory("");
    setCustomCategory("");
  }, [direction]);

  const submit = useCallback(async () => {
    const next: Record<string, string> = {};
    const finalCategory = (category === "其他" ? customCategory : category).trim();
    if (!amount || Number(amount) <= 0) next.amount = "请填写金额";
    if (!poolId) next.pool_id = "请选择资金账户";
    if (!finalCategory) next.category = "请选择或填写类别";
    if (nature === "EXTERNAL_IN" && !note.trim()) next.note = "外部/借款必须填写摘要";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      await createCashflow({
        pool_id: Number(poolId),
        occurred_on: occurredOn,
        direction,
        nature,
        category: finalCategory,
        amount,
        note: note.trim() || null,
      });
      navigate("/funds", true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }, [amount, category, customCategory, direction, nature, note, occurredOn, poolId]);

  return (
    <FormPage
      title="记一笔"
      subtitle="提交即入账"
      onBack={() => goBack("/funds")}
      footer={<SubmitBar label="保存并入账" busy={busy} onClick={() => void submit()} />}
    >
      <FormError error={error} />

      <FormSection title="方向与金额">
        <ChipField
          label="收 / 支"
          required
          value={direction}
          options={[
            { value: "OUT", label: "支出" },
            { value: "IN", label: "收入" },
          ]}
          onChange={(next) => setDirection(next as Direction)}
        />
        <Field label="金额" required error={errors.amount}>
          <MoneyInput value={amount} onChange={setAmount} placeholder="0.00" />
        </Field>
        <Field label="发生日期" required>
          <DateInput value={occurredOn} onChange={setOccurredOn} />
        </Field>
        <PickerField
          label="资金账户"
          required
          value={poolId}
          options={pools.map((pool) => ({
            value: String(pool.id),
            label: pool.name,
            hint: pool.code,
          }))}
          searchable
          onChange={setPoolId}
          placeholder="这笔钱从哪个账户出入"
          error={errors.pool_id}
        />
      </FormSection>

      <FormSection title="性质与科目">
        <ChipField
          label="资金性质"
          required
          value={nature}
          options={
            direction === "IN"
              ? [
                  { value: "BUSINESS_IN", label: "业务收入" },
                  { value: "EXTERNAL_IN", label: "外部/借款" },
                ]
              : [{ value: "BUSINESS_OUT", label: "业务支出" }]
          }
          onChange={setNature}
          hint={
            direction === "IN"
              ? "外部/借款指非经营产生的进账（股东注资、临时周转），必须写摘要"
              : "日常开销走业务支出；账户间挪钱请用「划转」，不要记支出"
          }
        />
        <ChipField
          label={direction === "OUT" ? "支出类别" : "收入类别"}
          required
          value={category}
          options={items.map((item) => ({ value: item, label: item }))}
          onChange={setCategory}
          error={errors.category}
        />
        {category === "其他" ? (
          <Field label="具体类别" required>
            <TextInput
              value={customCategory}
              onChange={setCustomCategory}
              placeholder="例如：快递费"
            />
          </Field>
        ) : null}
        <Field
          label="摘要 / 备注"
          required={nature === "EXTERNAL_IN"}
          error={errors.note}
          hint={nature === "EXTERNAL_IN" ? "外部进账必须写清来源，否则对账对不出来" : undefined}
        >
          <TextArea value={note} onChange={setNote} rows={3} placeholder="例如：10 月房租" />
        </Field>
      </FormSection>

      <p className="h5-footnote">
        记完立即计入账户余额与经营报表；登记错了请到流水里「冲销」，不要另记一笔相反的账。
      </p>
    </FormPage>
  );
}

/** 资金账户列表：单独提出去，避免和表单状态混在一个 useEffect 里。 */
function usePoolSetPools(): PoolRow[] {
  const [pools, setPools] = useState<PoolRow[]>([]);
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
  return pools;
}
