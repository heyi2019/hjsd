/**
 * 订单编辑（PATCH /orders/{id}）。
 *
 * 只放「改了不会破坏账」的字段：交易日期、备注、交付信息。
 * 金额、客户、事件一律不在这里改——金额改动必须走事件冲销/退款，否则流水与订单
 * 会对不上（后端也不会允许直接改 event_total）。后端 PATCH 对 `form_extra` 是
 * **合并**语义（`{**old, **new}`），所以这里只提交改动的交付字段即可。
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchOrder,
  listEmployees,
  patchOrder,
  type EmployeeOption,
  type OrderDetail,
} from "../../api";
import {
  Field,
  FormError,
  FormPage,
  FormSection,
  PickerField,
  SubmitBar,
  TextArea,
  TextInput,
  DateInput,
} from "../../forms/controls";
import { useOptionSet } from "../../forms/useOptionSets";
import { money, orderTypeLabel, today } from "../../labels";
import { goBack, navigate } from "../../router";

export function OrderEditPage({ orderId }: { orderId: number }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const platformOptions = useOptionSet("INTERMEDIARY_PLATFORM");
  const intermediaryTypes = useOptionSet("INTERMEDIARY_TYPE");
  const compensationOptions = useOptionSet("COMPENSATION_TYPE");

  const [v, setV] = useState({
    trade_date: today(),
    note: "",
    bound_phone: "",
    bound_phone_owner: "",
    intermediary_platform: "",
    intermediary_type: "",
    compensation_type: "",
    delivery_responsible_id: "",
  });

  useEffect(() => {
    let alive = true;
    void Promise.all([fetchOrder(orderId), listEmployees().catch(() => [])])
      .then(([detail, employeeRows]) => {
        if (!alive) return;
        setOrder(detail);
        setEmployees((employeeRows as EmployeeOption[]).filter((item) => item.is_active));
        const extra = (detail.form_extra ?? {}) as Record<string, unknown>;
        const responsible = extra.delivery_responsible_ids;
        setV({
          trade_date: detail.trade_date,
          note: detail.note ?? "",
          bound_phone: String(extra.bound_phone ?? ""),
          bound_phone_owner: String(extra.bound_phone_owner ?? ""),
          intermediary_platform: String(extra.intermediary_platform ?? ""),
          intermediary_type: String(extra.intermediary_type ?? ""),
          compensation_type: String(extra.compensation_type ?? ""),
          delivery_responsible_id: Array.isArray(responsible) && responsible.length
            ? String(responsible[0])
            : "",
        });
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "加载订单失败");
      });
    return () => {
      alive = false;
    };
  }, [orderId]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const formExtra: Record<string, unknown> = {
        bound_phone: v.bound_phone,
        bound_phone_owner: v.bound_phone_owner,
        intermediary_platform: v.intermediary_platform,
        intermediary_type: v.intermediary_type,
        compensation_type: v.compensation_type,
      };
      if (v.delivery_responsible_id) {
        formExtra.delivery_responsible_ids = [Number(v.delivery_responsible_id)];
      }
      await patchOrder(orderId, {
        trade_date: v.trade_date,
        note: v.note || null,
        form_extra: formExtra,
      });
      navigate(`/orders/${orderId}`, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }, [orderId, v]);

  return (
    <FormPage
      title="编辑订单"
      subtitle={order ? `${order.order_no} · ${orderTypeLabel(order.order_type)}` : undefined}
      onBack={() => goBack(`/orders/${orderId}`)}
      footer={<SubmitBar label="保存" busy={busy} hint="金额与客户不在此修改，需通过事件冲销或退款处理" onClick={() => void submit()} />}
    >
      <FormError error={error} />

      {order ? (
        <FormSection title="单据">
          <Field label="交易日期" required>
            <DateInput value={v.trade_date} max={today()} onChange={(next) => setV((prev) => ({ ...prev, trade_date: next }))} />
          </Field>
          <Field label="备注">
            <TextArea value={v.note} onChange={(next) => setV((prev) => ({ ...prev, note: next }))} rows={3} />
          </Field>
          <div className="h5-readonly">
            <div>
              <span>成交总额</span>
              <strong>¥{money(order.event_total)}</strong>
            </div>
            <div>
              <span>利润</span>
              <strong>¥{money(order.profit_base)}</strong>
            </div>
          </div>
        </FormSection>
      ) : null}

      <FormSection title="交付信息" description="与桌面端共用同一组 form_extra 字段">
        <Field label="换绑手机号">
          <TextInput
            value={v.bound_phone}
            onChange={(next) => setV((prev) => ({ ...prev, bound_phone: next }))}
            inputMode="tel"
          />
        </Field>
        <Field label="手机号绑定人">
          <TextInput
            value={v.bound_phone_owner}
            onChange={(next) => setV((prev) => ({ ...prev, bound_phone_owner: next }))}
          />
        </Field>
        <PickerField
          label="交易平台"
          value={v.intermediary_platform}
          options={platformOptions}
          onChange={(next) => setV((prev) => ({ ...prev, intermediary_platform: next }))}
          allowClear
          placeholder="可选填"
        />
        <PickerField
          label="中介类型"
          value={v.intermediary_type}
          options={intermediaryTypes}
          onChange={(next) =>
            setV((prev) => ({
              ...prev,
              intermediary_type: next,
              compensation_type: next === "包赔" ? prev.compensation_type : "",
            }))
          }
          allowClear
          placeholder="可选填"
        />
        <PickerField
          label="包赔类型"
          value={v.compensation_type}
          options={compensationOptions}
          onChange={(next) => setV((prev) => ({ ...prev, compensation_type: next }))}
          disabled={v.intermediary_type !== "包赔"}
          placeholder={v.intermediary_type === "包赔" ? "请选择" : "选择包赔后可选"}
        />
        {employees.length ? (
          <PickerField
            label="交付负责人"
            value={v.delivery_responsible_id}
            options={employees.map((item) => ({ value: String(item.id), label: item.display_name || item.username }))}
            onChange={(next) => setV((prev) => ({ ...prev, delivery_responsible_id: next }))}
            searchable
            allowClear
          />
        ) : null}
      </FormSection>
    </FormPage>
  );
}
