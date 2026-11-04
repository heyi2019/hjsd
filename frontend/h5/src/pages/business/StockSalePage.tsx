/**
 * 库存账号售出（全款 / 分期 / 代挂）。
 *
 * 这是手机上最常用的写操作：外出收号、当场卖给下一个买家，都是在手机上完成的。
 * 业务流程与桌面端 `stocks/InventorySaleModal.tsx` 完全一致：
 *
 *  1) 先给「来源订单」挂买家角色（`POST /orders/{id}/customer-roles`），
 *     **不新建订单** —— 售出是入库单上的一个事件，不是第二张单。
 *  2) 全款：在原单上登记 SELL 事件（portion=PROFIT），金额直接进资金账户；
 *     代挂无买入价，只登记利润，另把「售出金额」写进 form_extra 作记录。
 *  3) 分期：建 STOCK_SALE / PICKUP_SALE 合约，首付作为期次 0 收一笔。
 *  4) 交付信息（换绑手机、平台、中介类型）合并写回来源单的 form_extra。
 *
 * 三个容易出错的地方：
 *  - 代挂的买家角色是 CONSIGNOR（委托方），不是 BUYER；
 *  - 客户若已停用/已合并，必须拦住（后端也会拦，但手机上要给出人话）；
 *  - 分期首付为 0 时不产生收款事件，资金账户可以不选。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addOrderCustomerRole,
  createCustomer,
  createInstallmentForOrder,
  fetchStock,
  listCustomers,
  listEmployees,
  listPools,
  payInstallment,
  patchOrder,
  postOrderEvent,
  type CustomerRow,
  type EmployeeOption,
  type PoolRow,
  type StockRow,
} from "../../api";
import { ConfirmSheet } from "../../components/Sheet";
import {
  ChipField,
  DateInput,
  Field,
  FormError,
  FormPage,
  FormSection,
  MoneyInput,
  NumberInput,
  PickerField,
  SubmitBar,
  TextArea,
  TextInput,
  revealFirstError,
} from "../../forms/controls";
import { useOptionSet } from "../../forms/useOptionSets";
import { money, today } from "../../labels";
import { goBack, navigate } from "../../router";

const CUSTOMER_SOURCE_FALLBACK = ["自营", "微博", "小红书", "闲鱼", "同行推荐", "其他"].map((value) => ({
  value,
  label: value,
}));

/** 加一个月的日期（分期首期默认下一月同日）。 */
function addMonths(iso: string, months: number): string {
  const date = new Date(`${iso}T00:00:00`);
  const day = date.getDate();
  date.setMonth(date.getMonth() + months);
  if (date.getDate() < day) date.setDate(0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function StockSalePage({ stockId }: { stockId: number }) {
  const [stock, setStock] = useState<StockRow | null>(null);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const sourceOptions = useOptionSet("CUSTOMER_SOURCE");
  const platformOptions = useOptionSet("INTERMEDIARY_PLATFORM");
  const intermediaryTypes = useOptionSet("INTERMEDIARY_TYPE");
  const compensationOptions = useOptionSet("COMPENSATION_TYPE");

  const [v, setV] = useState({
    trade_date: today(),
    customer_nickname: "",
    customer_contact_name: "",
    customer_phone: "",
    customer_wechat: "",
    customer_qq: "",
    customer_source: "",
    customer_source_other: "",
    note: "",
    bound_phone: "",
    bound_phone_owner: "",
    intermediary_platform: "",
    intermediary_type: "",
    compensation_type: "",
    delivery_responsible_id: "",
    payment_method: "FULL",
    amount: "",
    sale_amount: "",
    pool_id: "",
    amount2: "",
    pool_id2: "",
    cashflow_note: "",
    down_payment: "0",
    service_fee: "0",
    periods: "3",
    per_period: "",
    first_due_on: addMonths(today(), 1),
  });
  const set = useCallback((key: keyof typeof v, value: string) => {
    setV((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void Promise.all([fetchStock(stockId), listPools(), listEmployees(), listCustomers({ limit: 500 })])
      .then(([stockRow, poolRows, employeeRows, customerPage]) => {
        if (!alive) return;
        setStock(stockRow);
        setPools(poolRows.filter((pool) => pool.status === "ACTIVE"));
        setEmployees(employeeRows.filter((employee) => employee.is_active));
        setCustomers(customerPage.items ?? []);
        setV((prev) => ({ ...prev, bound_phone: stockRow.bound_phone ?? "" }));
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "加载库存账号失败");
      });
    return () => {
      alive = false;
    };
  }, [stockId]);

  const isConsignment = stock?.inventory_type === "CONSIGNMENT";
  const paymentMethod = isConsignment ? "FULL" : v.payment_method;

  /** 分期每期金额：只做展示建议，最终以后端「分」的换算为准（此处按元两位小数取整）。 */
  const suggestedPerPeriod = useMemo(() => {
    const total = Number(v.amount) || 0;
    const down = Number(v.down_payment) || 0;
    const fee = Number(v.service_fee) || 0;
    const periods = Number(v.periods) || 0;
    if (!total || !periods) return "";
    const rest = total + fee - down;
    return rest > 0 ? (rest / periods).toFixed(2) : "0.00";
  }, [v.amount, v.down_payment, v.periods, v.service_fee]);

  const validate = useCallback((): boolean => {
    const next: Record<string, string> = {};
    if (!v.customer_nickname.trim()) next.customer_nickname = "买家昵称必填";
    if (!(Number(v.amount) > 0)) {
      next.amount = isConsignment ? "请输入利润" : "请输入售出金额";
    }
    if (paymentMethod === "FULL") {
      if (!v.pool_id) next.pool_id = "请选择资金账户";
      if (Number(v.amount2) > 0 && !v.pool_id2) next.pool_id2 = "请选择资金账户2";
    } else {
      const periods = Number(v.periods);
      if (!Number.isInteger(periods) || periods <= 0) next.periods = "期数必须为正整数";
      if (!(Number(v.per_period) > 0)) next.per_period = "请输入每期金额";
      if (Number(v.down_payment) > 0 && !v.pool_id) next.pool_id = "请选择首付收款账户";
      if (Number(v.down_payment) > Number(v.amount)) next.down_payment = "首付不能超过售出金额";
    }
    setErrors(next);
    if (Object.keys(next).length) {
      revealFirstError();
      return false;
    }
    return true;
  }, [isConsignment, paymentMethod, v]);

  const submit = useCallback(async () => {
    if (!stock?.source_order_id) {
      setError("该库存账号未关联到入库订单，无法登记售出");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sourceOrderId = stock.source_order_id;
      // 1) 买家/委托方建档：昵称 + 手机/微信 去重。
      const nickname = v.customer_nickname.trim();
      const phone = v.customer_phone.trim();
      const wechat = v.customer_wechat.trim();
      const existing = customers.find(
        (customer) =>
          customer.display_name === nickname
          && ((phone && customer.phone === phone) || (wechat && customer.wechat === wechat) || (!phone && !wechat)),
      );
      const customer = existing
        ? existing
        : (await createCustomer({
          display_name: nickname,
          contact_name: v.customer_contact_name || null,
          phone: phone || null,
          wechat: wechat || null,
          qq: v.customer_qq || null,
          source: v.customer_source === "其他" ? v.customer_source_other || null : v.customer_source || null,
          note: v.note || null,
        })).customer;

      if (customer.status === "MERGED" || customer.status === "DISABLED") {
        setErrors((prev) => ({
          ...prev,
          customer_nickname: customer.status === "MERGED" ? "客户已合并，不能作为买家" : "客户已停用，不能作为买家",
        }));
        revealFirstError();
        return;
      }

      // 2) 挂买家角色（代挂是委托方 CONSIGNOR）。
      await addOrderCustomerRole(sourceOrderId, {
        customer_id: customer.id,
        role: isConsignment ? "CONSIGNOR" : "BUYER",
      });

      const occurredOn = v.trade_date || today();
      if (paymentMethod === "INSTALLMENT") {
        // 3a) 分期售出：建合约 + 收首付（首付为期次 0）。
        const periods = Number(v.periods);
        const installment = await createInstallmentForOrder({
          order_id: sourceOrderId,
          contract_type: stock.inventory_type === "PICKUP" ? "PICKUP_SALE" : "STOCK_SALE",
          principal: v.amount,
          down_payment: v.down_payment || "0",
          service_fee: v.service_fee || "0",
          periods,
          per_period_service_fee: "0",
          per_period: v.per_period,
          first_due_on: v.first_due_on,
          adjust_final_period: true,
          schedule: Array.from({ length: periods }, (_, index) => ({
            period_no: index + 1,
            due_on: addMonths(v.first_due_on, index),
          })),
        });
        const downPayment = Number(v.down_payment) || 0;
        if (downPayment > 0) {
          await payInstallment(installment.id, {
            amount: v.down_payment,
            period_no: 0,
            paid_on: occurredOn,
            pool_id: v.pool_id ? Number(v.pool_id) : undefined,
          });
        }
      } else {
        // 3b) 全款：在原单登记 SELL；金额作 PROFIT 入账。
        await postOrderEvent(sourceOrderId, {
          event_type: "SELL",
          amount: v.amount,
          occurred_on: occurredOn,
          pool_id: Number(v.pool_id),
          portion: "PROFIT",
          note: v.cashflow_note || undefined,
          bound_phone: v.bound_phone || undefined,
          bound_phone_owner: v.bound_phone_owner || undefined,
          ...(Number(v.amount2) > 0
            ? { amount2: v.amount2, pool_id2: Number(v.pool_id2) }
            : {}),
          ...(isConsignment && v.sale_amount ? { form_extra: { sale_amount: v.sale_amount } } : {}),
        });
      }

      // 4) 交付信息合并回来源单：详情页与桌面读的是同一组 form_extra。
      const deliveryExtra: Record<string, unknown> = {};
      for (const key of [
        "bound_phone",
        "bound_phone_owner",
        "intermediary_platform",
        "intermediary_type",
        "compensation_type",
      ] as const) {
        if (v[key]) deliveryExtra[key] = v[key];
      }
      if (v.delivery_responsible_id) deliveryExtra.delivery_responsible_ids = [Number(v.delivery_responsible_id)];
      if (Object.keys(deliveryExtra).length) {
        await patchOrder(sourceOrderId, { form_extra: deliveryExtra });
      }

      navigate(`/stocks/${stock.id}`, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "售出失败");
    } finally {
      setBusy(false);
    }
  }, [customers, isConsignment, paymentMethod, stock, v]);

  const onPress = useCallback(() => {
    if (!validate()) return;
    setConfirmOpen(true);
  }, [validate]);

  if (!stock) {
    return (
      <FormPage title="售出账号" onBack={() => goBack("/business/inventory")}>
        {error ? <FormError error={error} /> : <p className="h5-empty">加载中…</p>}
      </FormPage>
    );
  }

  const buyerLabel = isConsignment ? "委托方" : "买家";

  return (
    <FormPage
      title={`售出 · ${stock.stock_no ?? stock.game_account ?? ""}`}
      subtitle={isConsignment ? "代挂售出" : stock.inventory_type === "PICKUP" ? "提号售出" : "回收售出"}
      onBack={() => goBack(`/stocks/${stock.id}`)}
      footer={
        <SubmitBar
          label="确认售出"
          busy={busy}
          hint={
            paymentMethod === "INSTALLMENT"
              ? `分期 ${v.periods} 期，每期 ¥${money(v.per_period || "0")}`
              : `本次入账 ¥${money(v.amount || "0")}`
          }
          onClick={onPress}
        />
      }
    >
      <FormError error={error} />

      <FormSection title="售出概要" description={`成本 ¥${money(stock.cost_amount)} · 账号 ${stock.game_account ?? "—"}`}>
        <Field label="成交日期" required>
          <DateInput value={v.trade_date} max={today()} onChange={(next) => set("trade_date", next)} />
        </Field>

        <Field label={isConsignment ? "利润（代挂佣金）" : "售出金额"} required error={errors.amount}>
          <MoneyInput value={v.amount} onChange={(next) => set("amount", next)} placeholder="请输入金额" />
        </Field>

        {isConsignment ? (
          <Field label="售出金额（仅记录）" hint="代挂无买入价，此金额只作记录，不计入利润">
            <MoneyInput value={v.sale_amount} onChange={(next) => set("sale_amount", next)} />
          </Field>
        ) : (
          <ChipField
            label="付款方式"
            value={v.payment_method}
            options={[
              { value: "FULL", label: "全款" },
              { value: "INSTALLMENT", label: "分期" },
            ]}
            onChange={(next) => set("payment_method", next)}
          />
        )}

        {paymentMethod === "FULL" ? (
          <>
            <PickerField
              label="资金账户"
              required
              value={v.pool_id}
              options={pools.map((pool) => ({ value: String(pool.id), label: `${pool.name}（${pool.code}）` }))}
              onChange={(next) => set("pool_id", next)}
              placeholder="请选择资金账户"
              error={errors.pool_id}
            />
            {!isConsignment ? (
              <>
                <Field label="售出金额 2" hint="可选：分笔进入不同资金账户">
                  <MoneyInput value={v.amount2} onChange={(next) => set("amount2", next)} />
                </Field>
                {Number(v.amount2) > 0 ? (
                  <PickerField
                    label="资金账户 2"
                    required
                    value={v.pool_id2}
                    options={pools.map((pool) => ({ value: String(pool.id), label: `${pool.name}（${pool.code}）` }))}
                    onChange={(next) => set("pool_id2", next)}
                    error={errors.pool_id2}
                  />
                ) : null}
              </>
            ) : null}
            <Field label="资金流水备注">
              <TextInput value={v.cashflow_note} onChange={(next) => set("cashflow_note", next)} placeholder="可选填" />
            </Field>
          </>
        ) : (
          <>
            <Field label="首付金额" error={errors.down_payment} hint="没有首付填 0">
              <MoneyInput value={v.down_payment} onChange={(next) => set("down_payment", next)} />
            </Field>
            {Number(v.down_payment) > 0 ? (
              <PickerField
                label="首付收款账户"
                required
                value={v.pool_id}
                options={pools.map((pool) => ({ value: String(pool.id), label: `${pool.name}（${pool.code}）` }))}
                onChange={(next) => set("pool_id", next)}
                error={errors.pool_id}
              />
            ) : null}
            <Field label="分期服务费总额">
              <MoneyInput value={v.service_fee} onChange={(next) => set("service_fee", next)} />
            </Field>
            <Field label="分期期数" required error={errors.periods}>
              <NumberInput value={v.periods} onChange={(next) => set("periods", next)} placeholder="例如 3" />
            </Field>
            <Field
              label="每期金额"
              required
              error={errors.per_period}
              aside={suggestedPerPeriod ? `建议 ¥${suggestedPerPeriod}` : undefined}
              hint={suggestedPerPeriod ? "按（售出金额 + 服务费 − 首付）÷ 期数估算，尾差由末期吸收" : undefined}
            >
              <MoneyInput value={v.per_period} onChange={(next) => set("per_period", next)} />
            </Field>
            <Field label="首期到期日" required>
              <DateInput value={v.first_due_on} onChange={(next) => set("first_due_on", next)} />
            </Field>
          </>
        )}
      </FormSection>

      <FormSection title={`${buyerLabel}信息`} description="按昵称 + 手机/微信自动去重">
        <Field label={`${buyerLabel}昵称`} required error={errors.customer_nickname}>
          <TextInput
            value={v.customer_nickname}
            onChange={(next) => set("customer_nickname", next)}
            placeholder={`请输入${buyerLabel}昵称`}
          />
        </Field>
        <Field label="姓名">
          <TextInput value={v.customer_contact_name} onChange={(next) => set("customer_contact_name", next)} />
        </Field>
        <Field label="手机号">
          <TextInput
            value={v.customer_phone}
            onChange={(next) => set("customer_phone", next)}
            inputMode="tel"
          />
        </Field>
        <Field label="微信号">
          <TextInput value={v.customer_wechat} onChange={(next) => set("customer_wechat", next)} />
        </Field>
        <Field label="QQ">
          <TextInput value={v.customer_qq} onChange={(next) => set("customer_qq", next)} />
        </Field>
        <PickerField
          label="客户来源"
          value={v.customer_source}
          options={sourceOptions.length ? sourceOptions : CUSTOMER_SOURCE_FALLBACK}
          onChange={(next) => {
            set("customer_source", next);
            if (next !== "其他") set("customer_source_other", "");
          }}
          allowClear
          placeholder="请选择客户来源"
        />
        {v.customer_source === "其他" ? (
          <Field label="其他来源" required>
            <TextInput value={v.customer_source_other} onChange={(next) => set("customer_source_other", next)} />
          </Field>
        ) : null}
        <Field label="备注">
          <TextArea value={v.note} onChange={(next) => set("note", next)} rows={2} placeholder="可选填" />
        </Field>
      </FormSection>

      <FormSection title="交付信息" description="换绑与平台信息会写回来源订单">
        <Field label="换绑手机号">
          <TextInput value={v.bound_phone} onChange={(next) => set("bound_phone", next)} inputMode="tel" />
        </Field>
        <Field label="手机号绑定人">
          <TextInput value={v.bound_phone_owner} onChange={(next) => set("bound_phone_owner", next)} />
        </Field>
        <PickerField
          label="交易平台"
          value={v.intermediary_platform}
          options={platformOptions}
          onChange={(next) => set("intermediary_platform", next)}
          allowClear
          placeholder="可选填"
        />
        <PickerField
          label="中介类型"
          value={v.intermediary_type}
          options={intermediaryTypes}
          onChange={(next) => {
            set("intermediary_type", next);
            if (next !== "包赔") set("compensation_type", "");
          }}
          allowClear
          placeholder="可选填"
        />
        <PickerField
          label="包赔类型"
          value={v.compensation_type}
          options={compensationOptions}
          onChange={(next) => set("compensation_type", next)}
          disabled={v.intermediary_type !== "包赔"}
          placeholder={v.intermediary_type === "包赔" ? "请选择" : "选择包赔后可选"}
        />
        {employees.length ? (
          <PickerField
            label="交付负责人"
            value={v.delivery_responsible_id}
            options={employees.map((item) => ({ value: String(item.id), label: item.display_name || item.username }))}
            onChange={(next) => set("delivery_responsible_id", next)}
            searchable
            allowClear
            placeholder="可选填"
          />
        ) : null}
      </FormSection>

      <p className="h5-footnote">
        售出登记在来源订单上（{stock.source_order_no ?? "—"}），不新建订单；确认后账号进入已售出状态。
      </p>

      <ConfirmSheet
        open={confirmOpen}
        title={isConsignment ? "确认代挂售出？" : "确认售出？"}
        description={
          paymentMethod === "INSTALLMENT"
            ? `将建立 ${v.periods} 期分期合约，首付 ¥${money(v.down_payment || "0")}。`
            : `将登记 SELL 事件并收入 ¥${money(v.amount || "0")} 到所选资金账户。`
        }
        okText="确认售出"
        busy={busy}
        onConfirm={() => {
          setConfirmOpen(false);
          void submit();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </FormPage>
  );
}
