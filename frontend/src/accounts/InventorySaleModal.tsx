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
  const [form] = Form.useForm();
  const open = Boolean(props.account);
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
    const nextValue = Number(((principal - firstPayment + fee) / count).toFixed(2));
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
    }
  };

  return (
    <Modal
      title="售出账号"
      open={open}
      destroyOnHidden
      onCancel={props.onClose}
      footer={
        <PermissionButton permission="order.create" type="primary" onClick={() => form.submit()}>
          确认售出
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} />
      <p className="muted">{props.account?.game_account ?? "未填写账号"}</p>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="customer_id" label="买家" rules={[{ required: true, message: "请选择买家" }]}>
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="请选择买家"
            options={customers.map((customer) => ({ value: customer.id, label: customer.display_name }))}
            notFoundContent="暂无可用客户"
          />
        </Form.Item>
        <Form.Item name="amount" label="售出金额" rules={[{ required: true, message: "请输入售出金额" }]}>
          <MoneyInput placeholder="请输入金额" />
        </Form.Item>
        <Form.Item name="payment_method" label="付款方式" initialValue="FULL">
          <Radio.Group
            options={[
              { value: "FULL", label: "全款" },
              { value: "INSTALLMENT", label: "分期付款" },
            ]}
            optionType="button"
            buttonStyle="solid"
          />
        </Form.Item>
        {paymentMethod === "FULL" ? (
          <Form.Item name="pool_id" label="收款资金账户" rules={[{ required: true, message: "请选择收款资金账户" }]}> 
            <Select
              placeholder="请选择收款资金账户"
              options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))}
              notFoundContent="暂无可用资金账户"
            />
          </Form.Item>
        ) : (
          <div className="inventory-sale-installment-fields">
            <p className="muted">出售时选择分期，系统会建立对应的售出分期合同，并将账号标记为“分期中”。</p>
            <Form.Item name="down_payment" label="首付金额" initialValue="0">
              <MoneyInput placeholder="没有首付填 0" />
            </Form.Item>
            <Form.Item name="service_fee" label="分期服务费总额" initialValue="0">
              <MoneyInput placeholder="可选填" />
            </Form.Item>
            <Form.Item name="periods" label="分期期数" initialValue={1} rules={[{ required: true, message: "请输入分期期数" }]}> 
              <Input inputMode="numeric" placeholder="请输入期数" />
            </Form.Item>
            <Form.Item name="per_period_service_fee" label="每期服务费">
              <MoneyInput placeholder="按服务费总额/期数计算" />
            </Form.Item>
            <Form.Item
              name="per_period"
              label="每期金额"
              rules={[{ required: true, message: "请输入每期金额" }]}
              extra={defaultPeriodAmount ? `按售出金额减首付自动参考：${defaultPeriodAmount}` : undefined}
            >
              <MoneyInput placeholder="请输入每期应收" />
            </Form.Item>
            <Form.Item name="first_due_on" label="首期日期" initialValue={dayjs()} rules={[{ required: true, message: "请选择首期日期" }]}>
              <DatePicker className="ui-control-full" placeholder="请选择日期" />
            </Form.Item>
          </div>
        )}
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={2} placeholder="可选" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
