/**
 * 登记退款（REFUND 事件）。
 *
 * 后端的三条硬规则（违反会直接 400，手机端必须提前拦住）：
 *  1) 必须已交付：非分期单看 SELL 事件，分期单看 DELIVER 事件 —— 交付前只能取消或冲销；
 *  2) 金额不能超过「已收 − 已退」；
 *  3) 原因与责任方必填（责任方决定这笔钱记到谁的账上）。
 *
 * 资金账户必填：退款是从某个资金账户里真的把钱退出去，没有账户这笔支出无处可记。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchExecutionDetail,
  fetchOrder,
  listPools,
  postOrderEvent,
  type ExecutionEvent,
  type OrderDetail,
  type PoolRow,
} from "../../api";
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
  revealFirstError,
} from "../../forms/controls";
import { money, today } from "../../labels";
import { goBack, navigate } from "../../router";

const RESPONSIBILITIES = [
  { value: "COMPANY", label: "公司承担" },
  { value: "CUSTOMER", label: "客户承担" },
  { value: "CONSIGNOR", label: "寄售方承担" },
  { value: "PLATFORM", label: "平台承担" },
  { value: "OTHER", label: "其他" },
];

export function OrderRefundPage({ orderId }: { orderId: number }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const [v, setV] = useState({
    amount: "",
    occurred_on: today(),
    pool_id: "",
    reason: "",
    responsibility: "COMPANY",
    note: "",
  });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [detail, poolRows] = await Promise.all([fetchOrder(orderId), listPools()]);
        if (!alive) return;
        setOrder(detail);
        setPools(poolRows.filter((pool) => pool.status === "ACTIVE"));
        if (detail.account_id) {
          const execution = await fetchExecutionDetail(detail.account_id);
          const target = execution.orders.find((item) => item.order_id === detail.id);
          if (alive) setEvents(target?.events ?? []);
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : "加载订单失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, [orderId]);

  /** 可退余额：已收（SELL + PAYMENT）− 已退（REFUND），与后端同一口径。 */
  const refundable = useMemo(() => {
    const received = events
      .filter((event) => event.is_posted && (event.event_type === "SELL" || event.event_type === "PAYMENT"))
      .reduce((sum, event) => sum + Number(event.amount || 0), 0);
    const refunded = events
      .filter((event) => event.is_posted && event.event_type === "REFUND")
      .reduce((sum, event) => sum + Number(event.amount || 0), 0);
    return Math.max(received - refunded, 0);
  }, [events]);

  const delivered = useMemo(
    () => events.some((event) => event.is_posted && (event.event_type === "SELL" || event.event_type === "DELIVER")),
    [events],
  );

  const submit = useCallback(async () => {
    const next: Record<string, string> = {};
    if (!(Number(v.amount) > 0)) next.amount = "请输入退款金额";
    else if (Number(v.amount) > refundable) next.amount = `不能超过可退余额 ¥${money(refundable)}`;
    if (!v.pool_id) next.pool_id = "请选择出账账户";
    if (!v.reason.trim()) next.reason = "退款原因必填";
    setErrors(next);
    if (Object.keys(next).length) {
      revealFirstError();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await postOrderEvent(orderId, {
        event_type: "REFUND",
        amount: v.amount,
        occurred_on: v.occurred_on,
        pool_id: Number(v.pool_id),
        reason: v.reason.trim(),
        refund_responsibility: v.responsibility as "COMPANY" | "CUSTOMER" | "CONSIGNOR" | "PLATFORM" | "OTHER",
        note: v.note || undefined,
      });
      navigate(`/orders/${orderId}`, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "退款失败");
    } finally {
      setBusy(false);
    }
  }, [orderId, refundable, v]);

  return (
    <FormPage
      title="登记退款"
      subtitle={order?.order_no}
      onBack={() => goBack(`/orders/${orderId}`)}
      footer={
        <SubmitBar
          label="确认退款"
          busy={busy}
          hint={delivered ? `可退余额 ¥${money(refundable)}` : "该订单尚未交付，不能退款"}
          disabled={!delivered}
          onClick={() => void submit()}
        />
      }
    >
      <FormError error={error} />

      {!delivered ? (
        <div className="h5-alert">
          该订单还没有交付记录。交付前如需撤回，请用「取消订单」，不要走退款 ——
          退款只用于已交付后把钱退给买家。
        </div>
      ) : null}

      <FormSection title="退款金额">
        <Field
          label="退款金额"
          required
          error={errors.amount}
          aside={delivered ? `可退 ¥${money(refundable)}` : undefined}
        >
          <MoneyInput value={v.amount} onChange={(next) => setV((prev) => ({ ...prev, amount: next }))} />
        </Field>
        <Field label="退款日期" required>
          <DateInput
            value={v.occurred_on}
            max={today()}
            onChange={(next) => setV((prev) => ({ ...prev, occurred_on: next }))}
          />
        </Field>
        <PickerField
          label="出账账户"
          required
          value={v.pool_id}
          options={pools.map((pool) => ({ value: String(pool.id), label: `${pool.name}（${pool.code}）` }))}
          onChange={(next) => setV((prev) => ({ ...prev, pool_id: next }))}
          placeholder="请选择出账的资金账户"
          error={errors.pool_id}
        />
      </FormSection>

      <FormSection title="责任归属">
        <ChipField
          label="退款责任方"
          value={v.responsibility}
          options={RESPONSIBILITIES}
          onChange={(next) => setV((prev) => ({ ...prev, responsibility: next }))}
          hint="决定这笔损失计入谁的账"
        />
        <Field label="退款原因" required error={errors.reason}>
          <TextArea
            value={v.reason}
            onChange={(next) => setV((prev) => ({ ...prev, reason: next }))}
            rows={3}
            placeholder="例如：买家三日无理由退号"
          />
        </Field>
        <Field label="备注">
          <TextArea
            value={v.note}
            onChange={(next) => setV((prev) => ({ ...prev, note: next }))}
            rows={2}
            placeholder="可选填"
          />
        </Field>
      </FormSection>

      <p className="h5-footnote">
        退款会生成一条 REFUND 事件与对应资金流水，并写入审计；不可删除，只能再冲销。
      </p>
    </FormPage>
  );
}
