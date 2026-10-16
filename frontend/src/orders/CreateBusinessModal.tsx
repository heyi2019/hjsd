/** 业务创建弹窗（从业务中心提取为共享组件，2026-10-13）。
 *  工作台「新建业务」入口卡点击后直接在本页打开，不再跳转业务中心。
 *  数据自加载：打开时才拉 业务类型/客户/合作方/账号，关闭不保留。 */
import { Collapse, Form, Input, Modal, Space, message } from "antd";
import { Select } from "../shared/ui";
import { useEffect, useState } from "react";
import {
  accountsApi,
  counterpartiesApi,
  customersApi,
  ordersApi,
  poolsApi,
  orderTypesApi,
  type Account,
  type Counterparty,
  type Customer,
  type Order,
  type OrderType,
  type Pool,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { COUNTERPARTY_TYPE_LABEL } from "../shared/lib/labels";
import { ErrorBanner, PermissionButton, ResizableModal } from "../shared/ui";
import { RecoveryAccountSection } from "./recovery/RecoveryAccountSection";
import { RecoveryCustomerSection } from "./recovery/RecoveryCustomerSection";
import { RecoveryFeeSection } from "./recovery/RecoveryFeeSection";
import { getRecoveryLayout } from "./recovery/recoveryConfig";
import { useRecoveryFormState } from "./recovery/useRecoveryFormState";
import { ThOrderSection } from "./th/ThOrderSection";
import { DgOrderSection } from "./dg/DgOrderSection";
import { DfqOrderSection } from "./dfq/DfqOrderSection";

type AccountCreationOrderType = "HS" | "TH" | "DG";
type BusinessOrderType = AccountCreationOrderType | "DG" | "DFQ";

const ADAPTIVE_BUSINESS_TYPES = new Set<BusinessOrderType>(["HS", "TH", "DG", "DFQ"]);

const MODAL_TITLES: Record<string, string> = {
  HS: "新建回收订单",
  TH: "新建提号订单",
  DG: "新建代挂订单",
  DFQ: "新建代分期订单",
};

const BUSINESS_CONTEXT: Partial<Record<BusinessOrderType, { business: string; type: string }>> = {
  HS: { business: "自营", type: "回收" },
  TH: { business: "分销", type: "提号" },
  DG: { business: "分销", type: "代挂" },
  DFQ: { business: "增值服务（独立分销服务）", type: "代分期" },
};

export function getAccountValues(values: Record<string, unknown>, orderType: AccountCreationOrderType) {
  const prefix = orderType === "HS" ? "" : `${orderType.toLowerCase()}_`;
  const field = (name: string) => values[`${prefix}${name}`];
  return {
    game_type: field("game_type") as string,
    business_mode: orderType === "HS" ? "SELF" : "DISTRIBUTION",
    inventory_type: orderType === "HS" ? "RECOVERY" : orderType === "TH" ? "PICKUP" : "CONSIGNMENT",
    game_account: field("game_account") as string,
    game_password: field("game_password") as string,
    channel_region: field("channel_region") as string,
    bound_phone: field("bound_phone") as string,
    has_secondary: field("has_secondary") ? field("has_secondary") === "有" : undefined,
    note: values[orderType === "HS" ? "game_account_note" : `${prefix}account_note`] as string,
  };
}

function toDateString(value: unknown) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && "format" in value && typeof value.format === "function") {
    return value.format("YYYY-MM-DD");
  }
  return today();
}

export function CreateBusinessModal(props: {
  open: boolean;
  onClose: () => void;
  /** 建单成功后的刷新回调（页面重新拉列表）。 */
  onCreated: () => void | Promise<void>;
  /** 从明确业务入口打开时，直接带入业务类型，减少一次选择。 */
  initialOrderType?: string;
}) {
  const orderType = props.initialOrderType as BusinessOrderType | undefined;
  const modalTitle = MODAL_TITLES[orderType ?? ""] ?? "新建业务";
  const isRecovery = orderType === "HS";
  const isTh = orderType === "TH";
  const isDg = orderType === "DG";
  const isDfq = orderType === "DFQ";
  const isAdaptiveBusiness = orderType ? ADAPTIVE_BUSINESS_TYPES.has(orderType) : false;
  const isGeneralBusiness = !isAdaptiveBusiness;
  const businessContext = orderType ? BUSINESS_CONTEXT[orderType] : undefined;
  const needsAccountCreation = isRecovery || isTh || isDg;
  const [types, setTypes] = useState<OrderType[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
  const { customerSource, totalRecoveryCost } = useRecoveryFormState(form);
  const formId = isAdaptiveBusiness ? "business-order-form" : undefined;

  const resetAdaptiveModalLayout = (open: boolean) => {
    if (!open || !isAdaptiveBusiness) return;
    window.requestAnimationFrame(() => {
      const modal = document.querySelector<HTMLElement>(".adaptive-business-modal .ant-modal");
      if (!modal) return;
      modal.dataset.recoveryLayout = getRecoveryLayout(modal.getBoundingClientRect().width);
      modal.style.removeProperty("position");
      modal.style.removeProperty("left");
      modal.style.removeProperty("top");
      modal.style.removeProperty("margin");
      modal.style.removeProperty("transform");
      modal.style.removeProperty("--resizable-modal-width");
      modal.style.removeProperty("--resizable-modal-height");
    });
  };

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    void (async () => {
      try {
        const [typeList, customerList, cpList, accountList, poolList, orderList] = await Promise.all([
          orderTypesApi.list(),
          customersApi.list(),
          counterpartiesApi.list(),
          accountsApi.list(),
          poolsApi.list(),
          ordersApi.list(),
        ]);
        if (cancelled) return;
        setTypes(typeList);
        setCustomers(customerList);
        setCounterparties(cpList);
        setAccounts(accountList);
        setPools(poolList.filter((pool) => pool.status === "ACTIVE"));
        setOrders(orderList);
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError(normalizeError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open || !orderType) return;
    const defaults: Record<string, unknown> = {
      order_type: orderType,
    };
    if (isRecovery) {
      defaults.customer_role = "SELLER";
      defaults.counterparty_role = "PEER";
    }
    if (isTh) defaults.supplier_source = "氪金联盟";
    form.setFieldsValue(defaults);
  }, [form, isRecovery, isTh, orderType, props.open]);

  const submit = async (values: Record<string, unknown>) => {
    try {
      if (isDfq) {
        const customer = await customersApi.create({
          display_name: values.dfq_customer_nickname as string,
          contact_name: values.dfq_customer_contact as string,
          phone: values.dfq_customer_phone as string,
          wechat: values.dfq_customer_wechat as string,
          qq: values.dfq_customer_qq as string,
          source: values.dfq_customer_source as string,
          note: values.dfq_note as string,
        });
        const order = await ordersApi.create({
          order_type: "DFQ",
          trade_date: today(),
          note: values.dfq_note as string,
          customer_roles: [{ customer_id: customer.customer.id, role: "INSTALLMENT_CUSTOMER" }],
          initial_buy: {
            amount: String(values.dfq_total_amount ?? 0),
            occurred_on: today(),
            portion: "PRINCIPAL",
            pool_id: values.dfq_payment_pool_id as number,
            note: `代付剩余号款｜付款对象：${String(values.dfq_payment_recipient || "供货方")}${values.dfq_payment_note ? `｜${String(values.dfq_payment_note)}` : ""}`,
          },
          installment: {
            contract_type: "ADVANCE_PURCHASE",
            principal: String(values.dfq_total_amount ?? 0),
            down_payment: "0",
            service_fee: String(values.dfq_service_fee ?? 0),
            periods: Number(values.dfq_periods ?? 1),
            per_period_service_fee: String(values.dfq_period_service_fee ?? 0),
            per_period: String(values.dfq_period_amount ?? 0),
            first_due_on: toDateString((values.dfq_schedule as Array<{ due_on?: unknown }> | undefined)?.[0]?.due_on),
            schedule: ((values.dfq_schedule as Array<{ due_on?: unknown }> | undefined) ?? []).map((item, index) => ({
              period_no: index + 1,
              due_on: toDateString(item.due_on),
            })),
            note: values.dfq_note as string,
          },
        });
        message.success("代分期订单已创建");
        props.onClose();
        form.resetFields();
        await props.onCreated();
        return;
      }
      const accountProfile = needsAccountCreation
        ? getAccountValues(values, orderType as AccountCreationOrderType)
        : undefined;
      const customerPrefix = isDg ? "dg_" : "";
      const customerSourceField = isDg ? "dg_customer_source" : "customer_source";
      const customerSourceOtherField = isDg ? "dg_customer_source_other" : "customer_source_other";
      const resolvedCustomerSource = values[customerSourceField] === "其他"
        ? values[customerSourceOtherField]
        : values[customerSourceField];
      const customerNickname = values[`${customerPrefix}customer_nickname`];
      if ((isRecovery || isDg) && customerNickname) {
        const existingCustomer = customers.find((customer) =>
          customer.display_name === customerNickname
          && ((values[`${customerPrefix}customer_phone`] && customer.phone === values[`${customerPrefix}customer_phone`])
            || (values[`${customerPrefix}customer_wechat`] && customer.wechat === values[`${customerPrefix}customer_wechat`])
            || (!values[`${customerPrefix}customer_phone`] && !values[`${customerPrefix}customer_wechat`])),
        );
        const customer = existingCustomer ?? (await customersApi.create({
          display_name: customerNickname as string,
          contact_name: values[`${customerPrefix}customer_contact_name`] as string,
          phone: values[`${customerPrefix}customer_phone`] as string,
          wechat: values[`${customerPrefix}customer_wechat`] as string,
          qq: values[`${customerPrefix}customer_qq`] as string,
          source: resolvedCustomerSource as string,
          note: (isDg ? values.dg_note : values.note) as string,
        })).customer;
        values.customer_id = customer.id;
      }
      const note = (isRecovery || isDg) && resolvedCustomerSource
        ? `客户来源：${String(resolvedCustomerSource)}${values[isDg ? "dg_note" : "note"] ? `｜${String(values[isDg ? "dg_note" : "note"])}` : ""}`
        : isTh
          ? [
              values.th_account_note as string,
              values.supplier_source ? `供货方来源：${String(values.supplier_source === "其他" ? values.supplier_source_other : values.supplier_source)}` : "",
              values.supplier_note as string,
              values.th_receive_amount ? `预期收买家：${String(values.th_receive_amount)}` : "",
            ].filter(Boolean).join("｜") || undefined
          : values.note as string;
      let counterpartyId = values.counterparty_id as number | undefined;
      if (isTh && values.supplier_nickname) {
        const role = "SUPPLIER";
        const existingCounterparty = counterparties.find((item) =>
          item.display_name === values.supplier_nickname && item.type === role,
        );
        const counterparty = existingCounterparty ?? await counterpartiesApi.create({
          display_name: values.supplier_nickname as string,
          type: role,
          contact_name: values.supplier_contact_name as string,
          phone: values.supplier_phone as string,
          wechat: values.supplier_wechat as string,
          qq: values.supplier_qq as string,
          source: (values.supplier_source === "其他" ? values.supplier_source_other : values.supplier_source) as string,
          note: [
            values.supplier_note as string,
          ].filter(Boolean).join("｜") || undefined,
        });
        counterpartyId = counterparty.id;
      }
      const customerRole = isRecovery ? "SELLER" : isDg ? "CONSIGNOR" : String(values.customer_role ?? "BUYER");
      const counterpartyRole = isTh ? "SUPPLIER" : String(values.counterparty_role ?? "PEER");
      const customerRoles = values.customer_id
        ? [{ customer_id: values.customer_id as number, role: customerRole }]
        : [];
      const order = await ordersApi.create({
        order_type: props.initialOrderType ?? values.order_type as string,
        trade_date: today(),
        listing_price: isDg && values.dg_listing_price != null ? String(values.dg_listing_price) : undefined,
        service_fee: isDg && values.dg_service_fee != null ? String(values.dg_service_fee) : undefined,
        commission_mode: isDg ? values.dg_commission_mode as string : undefined,
        commission_payer: isDg ? values.dg_commission_payer as string : undefined,
        expected_settlement_date: isDg && values.dg_expected_settlement_date
          ? toDateString(values.dg_expected_settlement_date)
          : undefined,
        account: accountProfile,
        note,
        customer_roles: customerRoles,
        counterparty_roles: counterpartyId
          ? [
              {
                counterparty_id: counterpartyId,
                role: counterpartyRole,
              },
            ]
          : [],
      });
      if (isRecovery) {
        await ordersApi.postEvent(order.id, {
          event_type: "BUY",
          amount: String(values.recovery_price ?? 0),
          occurred_on: today(),
          portion: "PRINCIPAL",
          pool_id: values.payment_pool_id as number,
          note: `回收价｜付款对象：${String(values.payment_recipient || "卖家")}${values.payment_note ? `｜${String(values.payment_note)}` : ""}`,
        });
        if (Number(values.intermediary_fee) > 0) {
          await ordersApi.postEvent(order.id, {
            event_type: "COST",
            amount: String(values.intermediary_fee),
            occurred_on: today(),
            portion: "PRINCIPAL",
            pool_id: values.payment_pool_id as number,
            flow_category: "FEE",
            note: `中介费｜平台：${String(values.intermediary_platform ?? "")}｜类型：${String(values.intermediary_type ?? "")}${values.compensation_type ? `｜${String(values.compensation_type)}` : ""}`,
          });
        }
        if (Number(values.other_fee_amount) > 0) {
          await ordersApi.postEvent(order.id, {
            event_type: "COST",
            amount: String(values.other_fee_amount),
            occurred_on: today(),
            portion: "PRINCIPAL",
            pool_id: values.payment_pool_id as number,
            flow_category: "OTHER",
            note: `${String(values.other_fee_name || "其他费用")}｜收款对象：${String(values.other_fee_recipient ?? "")}`,
          });
        }
      } else if (isTh) {
        await ordersApi.postEvent(order.id, {
          event_type: "BUY",
          amount: String(values.th_purchase_amount ?? 0),
          occurred_on: today(),
          portion: "PRINCIPAL",
          pool_id: values.payment_pool_id as number,
          note: `提号｜付${String(values.payment_recipient || "供货方")}${values.payment_note ? `｜${String(values.payment_note)}` : ""}`,
        });
        if (Number(values.intermediary_fee) > 0) {
          await ordersApi.postEvent(order.id, {
            event_type: "COST",
            amount: String(values.intermediary_fee),
            occurred_on: today(),
            portion: "PRINCIPAL",
            pool_id: values.payment_pool_id as number,
            flow_category: "FEE",
            note: `提号中介费｜平台：${String(values.intermediary_platform ?? "")}｜类型：${String(values.intermediary_type ?? "")}${values.compensation_type ? `｜${String(values.compensation_type)}` : ""}`,
          });
        }
        if (Number(values.other_fee_amount) > 0) {
          await ordersApi.postEvent(order.id, {
            event_type: "COST",
            amount: String(values.other_fee_amount),
            occurred_on: today(),
            portion: "PRINCIPAL",
            pool_id: values.payment_pool_id as number,
            flow_category: "OTHER",
            note: `${String(values.other_fee_name || "其他")}｜收款对象：${String(values.other_fee_recipient ?? "")}`,
          });
        }
      }
      message.success(isDg ? "代挂订单已创建，获客信息已保存" : "订单已创建");
      props.onClose();
      form.resetFields();
      await props.onCreated();
    } catch (error) {
      setLoadError(normalizeError(error));
    }
  };

  return (
    <Modal
      title={<span className="resizable-modal__drag-handle">{modalTitle}</span>}
      open={props.open}
      destroyOnHidden={isAdaptiveBusiness}
      onCancel={props.onClose}
      afterOpenChange={resetAdaptiveModalLayout}
      footer={isAdaptiveBusiness ? (
        <PermissionButton permission="order.create" type="primary" htmlType="submit" form={formId}>
          创建订单
        </PermissionButton>
      ) : null}
      width={1200}
      wrapClassName={isAdaptiveBusiness ? "adaptive-business-modal recovery-order-modal" : undefined}
      modalRender={(modal) => isAdaptiveBusiness ? <ResizableModal getLayout={getRecoveryLayout} layoutAttribute="data-recovery-layout">{modal}</ResizableModal> : modal}
    >
      <ErrorBanner error={loadError} />
      <Form
        form={form}
        id={formId}
        layout={isAdaptiveBusiness ? "horizontal" : "vertical"}
        labelCol={isAdaptiveBusiness ? { flex: "0 0 96px" } : undefined}
        wrapperCol={isAdaptiveBusiness ? { flex: "1 1 auto" } : undefined}
        onFinish={submit}
        initialValues={{
          order_type: props.initialOrderType,
          ...(isRecovery
            ? { customer_role: "SELLER", counterparty_role: "PEER" }
            : isTh
              ? { supplier_source: "氪金联盟" }
              : {}),
        }}
      >
        {businessContext ? (
          <Space className="muted" size="large">
            <span>业务：{businessContext.business}</span>
            <span>类型：{businessContext.type}</span>
            <span>产品：请在下方填写游戏类型</span>
          </Space>
        ) : null}
        {isGeneralBusiness ? <>
          <Form.Item name="order_type" label="业务类型" rules={[{ required: true }]}>
            <Select options={types.map((type) => ({ value: type.code, label: type.name }))} />
          </Form.Item>
          <Form.Item name="account_id" label="关联账号（必填）">
            <Select
              allowClear
              placeholder="请选择账号"
              notFoundContent="暂无可关联库存账号；新账号请从对应业务订单创建"
              options={accounts.map((account) => ({
                value: account.id,
                label: `${account.inventory_no} ${account.game_account ?? ""}`,
              }))}
            />
          </Form.Item>
        </> : isRecovery ? <RecoveryAccountSection>
          <RecoveryFeeSection totalRecoveryCost={totalRecoveryCost} pools={pools} />
        </RecoveryAccountSection> : isTh ? <ThOrderSection pools={pools} /> : isDg ? <DgOrderSection /> : <DfqOrderSection pools={pools} />}
        {isRecovery ? <RecoveryCustomerSection customerSource={customerSource} /> : isGeneralBusiness ? <>
          <Form.Item name="customer_id" label="客户">
            <Select
              allowClear
              placeholder="请选择客户"
              notFoundContent="暂无客户档案"
              options={customers.map((c) => ({ value: c.id, label: c.display_name }))}
            />
          </Form.Item>
        </> : null}
        {isGeneralBusiness && <Collapse
          ghost
          items={[{
            key: "more",
            label: "更多信息（可选）",
            children: (
              <>
                <Form.Item name="customer_role" label={isRecovery ? "来源方角色" : "客户角色"}>
                  <Select options={[
                    { value: "SELLER", label: "卖家" },
                    { value: "BUYER", label: "买家" },
                    { value: "CONSIGNOR", label: "委托方" },
                    { value: "INSTALLMENT_CUSTOMER", label: "分期客户" },
                  ]} />
                </Form.Item>
                <Form.Item name="counterparty_id" label="合作方（同行/供货方/平台）">
                  <Select allowClear options={counterparties.map((c) => ({
                    value: c.id,
                    label: `${c.display_name}（${COUNTERPARTY_TYPE_LABEL[c.type] ?? c.type}）`,
                  }))} />
                </Form.Item>
                <Form.Item name="counterparty_role" label="合作方角色">
                  <Select options={[
                    { value: "PEER", label: "同行" },
                    { value: "SUPPLIER", label: "供货方" },
                    { value: "PLATFORM", label: "平台" },
                  ]} />
                </Form.Item>
                <Form.Item name="note" label="备注"><Input.TextArea rows={2} /></Form.Item>
              </>
            ),
          }]}
        />}
        {isGeneralBusiness && <PermissionButton permission="order.create" type="primary" htmlType="submit">
          创建订单
        </PermissionButton>}
      </Form>
    </Modal>
  );
}
