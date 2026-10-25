/** 库存账号售出：回收 / 代挂账号从库存中心售出，按货源类型映射订单类型。 */
import { DatePicker, Form, Input, Modal, Radio, message } from "antd";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  customersApi,
  installmentsApi,
  ordersApi,
  poolsApi,
  type Account,
  type Customer,
  type Pool,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { ErrorBanner, MoneyInput, PermissionButton, Select } from "../shared/ui";
import { CfgItem, FieldConfigContext, useOrderFormConfig } from "../orders/ConfigurableField";

/** 库存账号售出：按货源类型映射回收 / 代挂订单类型。 */
const SALE_ORDER_TYPE: Record<string, string> = {
  RECOVERY: "HS",
  PICKUP: "TH",
  CONSIGNMENT: "DG",
};
const resolveSaleOrderType = (inventoryType?: string | null): string =>
  (inventoryType && SALE_ORDER_TYPE[inventoryType]) || "HS";

export function InventorySaleModal(props: {
  account: Account | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const open = Boolean(props.account);
  const { config } = useOrderFormConfig(open ? "SALE" : undefined);
  const paymentMethod = Form.useWatch("payment_method", form) ?? "FULL";
  const saleAmount = Form.useWatch("amount", form);
  const downPayment = Form.useWatch("down_payment", form);
  const serviceFee = Form.useWatch("service_fee", form);
  const periodServiceFee = Form.useWatch("per_period_service_fee", form);
  const perPeriod = Form.useWatch("per_period", form);
  const periods = Form.useWatch("periods", form);
  const lastAutoPeriodFee = useRef<number | undefined>();
  const lastAutoPeriodAmount = useRef<number | undefined>();

  useEffect(() => {
    const total = Number(serviceFee);
    const count = Number(periods);
    if (!Number.isFinite(total) || !Number.isFinite(count) || count <= 0) return;
    const nextValue = Number((total / count).toFixed(2));
    const isAutoValue = periodServiceFee === undefined || periodServiceFee === lastAutoPeriodFee.current;
    if (isAutoValue) {
      form.setFieldValue("per_period_service_fee", nextValue);
      lastAutoPeriodFee.current = nextValue;
    }
  }, [form, periodServiceFee, periods, serviceFee]);

  const defaultPeriodAmount = useMemo(() => {
    const principal = Number(saleAmount ?? 0);
    const firstPayment = Number(downPayment ?? 0);
    const count = Number(periods ?? 0);
    if (!Number.isFinite(principal) || !Number.isFinite(firstPayment) || !Number.isFinite(count) || count <= 0) {
      return undefined;
    }
    return ((principal - firstPayment + Number(serviceFee ?? 0)) / count).toFixed(2);
  }, [downPayment, periods, saleAmount, serviceFee]);

  useEffect(() => {
    const principal = Number(saleAmount);
    const firstPayment = Number(downPayment);
    const fee = Number(serviceFee);
    const count = Number(periods);
    if (![principal, firstPayment, fee, count].every(Number.isFinite) || count <= 0) return;
    const nextValue = Math.ceil((Math.round(principal * 100) - Math.round(firstPayment * 100) + Math.round(fee * 100)) / count) / 100;
    const isAutoValue = perPeriod === undefined || perPeriod === lastAutoPeriodAmount.current;
    if (isAutoValue) {
      form.setFieldValue("per_period", nextValue);
      lastAutoPeriodAmount.current = nextValue;
    }
  }, [downPayment, form, periods, perPeriod, saleAmount, serviceFee]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([customersApi.list(), poolsApi.list()])
      .then(([customerList, poolList]) => {
        if (cancelled) return;
        setCustomers(customerList);
        setPools(poolList.filter((pool) => pool.status === "ACTIVE"));
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) setError(normalizeError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const submit = async (values: Record<string, unknown>) => {
    if (!props.account) return;
    setSubmitting(true);
    try {
      const order = await ordersApi.create({
        order_type: resolveSaleOrderType(props.account.inventory_type),
        trade_date: today(),
        account_id: props.account.id,
        note: values.note as string | undefined,
        customer_roles: [{
          customer_id: values.customer_id as number,
          role: props.account.inventory_type === "CONSIGNMENT" ? "CONSIGNOR" : "BUYER",
        }],
      });

      if (values.payment_method === "INSTALLMENT") {
        const firstDueOn = values.first_due_on && typeof values.first_due_on === "object" && "format" in values.first_due_on
          ? (values.first_due_on as { format: (template: string) => string }).format("YYYY-MM-DD")
          : today();
        await installmentsApi.create({
          order_id: order.id,
          adjust_final_period: true,
          contract_type: props.account.inventory_type === "PICKUP"
            ? "PICKUP_SALE"
            : props.account.inventory_type === "CONSIGNMENT"
              ? "CONSIGNMENT_SALE"
              : "STOCK_SALE",
          principal: String(values.amount ?? 0),
          down_payment: String(values.down_payment ?? 0),
          service_fee: String(values.service_fee ?? 0),
          periods: Number(values.periods ?? 1),
          per_period_service_fee: String(values.per_period_service_fee ?? 0),
          per_period: String(values.per_period ?? 0),
          first_due_on: firstDueOn,
          note: values.note as string | undefined,
        });
        message.success("分期售出已创建，账号已进入分期中");
      } else {
        await ordersApi.postEvent(order.id, {
          event_type: "SELL",
          amount: values.amount as string,
          occurred_on: today(),
          pool_id: values.pool_id as number,
          portion: "PROFIT",
          note: values.note as string | undefined,
        });
        message.success("账号已售出");
      }
      form.resetFields();
      props.onClose();
      await props.onCreated();
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="售出账号"
      open={open}
      destroyOnHidden
      onCancel={props.onClose}
      footer={
        <PermissionButton permission="order.create" type="primary" loading={submitting} onClick={() => form.submit()}>
          确认售出
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} />
      <p className="muted">{props.account?.game_account ?? "未填写账号"}</p>
      <FieldConfigContext.Provider value={config}>
        <Form form={form} layout="vertical" onFinish={submit}>
          <CfgItem name="customer_id" label="买家" rules={[{ required: true, message: "请选择买家" }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择买家"
              options={customers.map((customer) => ({ value: customer.id, label: customer.display_name }))}
              notFoundContent="暂无可用客户"
            />
          </CfgItem>
          <CfgItem name="amount" label="售出金额" rules={[{ required: true, message: "请输入售出金额" }, { validator: async (_, v) => { if (v !== undefined && v !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0)) throw new Error("请输入非负金额"); } }]}>
            <MoneyInput placeholder="请输入金额" />
          </CfgItem>
          <CfgItem name="payment_method" label="付款方式" initialValue="FULL">
            <Radio.Group
              options={[
                { value: "FULL", label: "全款" },
                { value: "INSTALLMENT", label: "分期付款" },
              ]}
              optionType="button"
              buttonStyle="solid"
            />
          </CfgItem>
          {paymentMethod === "FULL" ? (
            <CfgItem name="pool_id" label="收款资金账户" rules={[{ required: true, message: "请选择收款资金账户" }]}>
              <Select
                placeholder="请选择收款资金账户"
                options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))}
                notFoundContent="暂无可用资金账户"
              />
            </CfgItem>
          ) : (
            <div className="inventory-sale-installment-fields">
              <p className="muted">出售时选择分期，系统会建立对应的售出分期合同，并将账号标记为“分期中”。</p>
              <CfgItem name="down_payment" label="首付金额" initialValue="0" rules={[{ validator: async (_, v) => { if (!Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > Number(saleAmount)) throw new Error("首付不能为负数或超过售出金额"); } }]}>
                <MoneyInput placeholder="没有首付填 0" />
              </CfgItem>
              <CfgItem name="service_fee" label="分期服务费总额" initialValue="0" rules={[{ validator: async (_, v) => { if (!Number.isFinite(Number(v)) || Number(v) < 0) throw new Error("服务费不能为负数"); } }]}>
                <MoneyInput placeholder="可选填" />
              </CfgItem>
              <CfgItem name="periods" label="分期期数" initialValue={1} rules={[{ validator: async (_, v) => { if (!Number.isInteger(Number(v)) || Number(v) <= 0) throw new Error("期数必须为正整数"); } }]}>
                <Input inputMode="numeric" placeholder="请输入期数" />
              </CfgItem>
              <CfgItem name="per_period_service_fee" label="每期服务费" rules={[{ validator: async (_, v) => { if (v !== undefined && v !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0)) throw new Error("每期服务费必须为非负金额"); } }]}>
                <MoneyInput placeholder="按服务费总额/期数计算" />
              </CfgItem>
              <CfgItem
                name="per_period"
                label="每期金额"
                rules={[{ required: true, message: "请输入每期金额" }, { validator: async (_, value) => {
                  const count = Number(periods), total = Number(saleAmount) - Number(downPayment || 0) + Number(serviceFee || 0), amount = Number(value);
                  if (!Number.isFinite(amount) || amount < 0 || (count > 0 && (amount * count + 0.001 < Number(saleAmount) - Number(downPayment || 0) || amount * (count - 1) > total + 0.001))) throw new Error("每期金额与分期总额不匹配");
                } }]}
                extra={defaultPeriodAmount && perPeriod != null && Number(periods) > 0 ? `最后一期：${((Math.round((Number(saleAmount) - Number(downPayment || 0) + Number(serviceFee || 0)) * 100) - Math.round(Number(perPeriod) * 100) * (Number(periods) - 1)) / 100).toFixed(2)} 元` : undefined}
              >
                <MoneyInput placeholder="请输入每期应收" />
              </CfgItem>
              <CfgItem name="first_due_on" label="首期日期" initialValue={dayjs()} rules={[{ required: true, message: "请选择首期日期" }]}>
                <DatePicker className="ui-control-full" placeholder="请选择日期" />
              </CfgItem>
            </div>
          )}
          <CfgItem name="note" label="备注">
            <Input.TextArea rows={2} placeholder="可选" />
          </CfgItem>
        </Form>
      </FieldConfigContext.Provider>
    </Modal>
  );
}
