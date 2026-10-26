/** 业务创建弹窗：所有入口都明确指定业务类型，账号信息只在订单快照或库存关联中出现。 */
import { Form, Modal, message } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useOrderFormConfig, CustomFormField, FieldConfigContext } from "./ConfigurableField";
import {
  counterpartiesApi,
  customersApi,
  gameTypesApi,
  ordersApi,
  poolsApi,
  type Counterparty,
  type Customer,
  type GameTypeOption,
  type Pool,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { ErrorBanner, PermissionButton, ResizableModal } from "../shared/ui";
import { RecoveryAccountSection } from "./recovery/RecoveryAccountSection";
import { RecoveryCustomerSection } from "./recovery/RecoveryCustomerSection";
import { RecoveryFeeSection } from "./recovery/RecoveryFeeSection";
import { getRecoveryLayout } from "./recovery/recoveryConfig";
import { useRecoveryFormState } from "./recovery/useRecoveryFormState";
import { ThOrderSection } from "./th/ThOrderSection";
import { DgOrderSection } from "./dg/DgOrderSection";
import { DfqOrderSection } from "./dfq/DfqOrderSection";

export type BusinessOrderType = "HS" | "TH" | "DG" | "DFQ";

const MODAL_TITLES: Record<string, string> = {
  HS: "新建回收订单",
  TH: "新建提号订单",
  DG: "新建代挂订单",
  DFQ: "新建代分期订单",
};

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
  /** 必须从明确业务入口打开，订单类型不再通过通用兼容表单选择。 */
  initialOrderType: BusinessOrderType;
}) {
  const orderType = props.initialOrderType;
  const modalTitle = MODAL_TITLES[orderType];
  const isRecovery = orderType === "HS";
  const isTh = orderType === "TH";
  const isDg = orderType === "DG";
  const isDfq = orderType === "DFQ";
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [gameTypes, setGameTypes] = useState<GameTypeOption[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const { customerSource, totalRecoveryCost } = useRecoveryFormState(form);
  const formId = "business-order-form";
  const { config } = useOrderFormConfig(props.open ? orderType : undefined);
  const customFields = useMemo(
    () =>
      Object.values(config)
        .filter((field) => field.is_custom && field.is_active)
        .sort((a, b) => a.sort_order - b.sort_order),
    [config],
  );

  // 关闭弹窗即清空表单：antd Form 默认 preserve=true，destroyOnHidden 只销毁 DOM 不丢表单实例值，
  // 仅成功路径显式 resetFields；取消/点遮罩关闭会残留上次输入，故在 open 变 false 时统一 reset。
  useEffect(() => {
    if (!props.open) form.resetFields();
  }, [props.open, form]);

  const resetAdaptiveModalLayout = (open: boolean) => {
    if (!open) return;
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
        const [customerList, cpList, poolList, gameTypeList] = await Promise.all([
          customersApi.list(),
          counterpartiesApi.list(),
          poolsApi.list(),
          gameTypesApi.list({ include_inactive: false }),
        ]);
        if (cancelled) return;
        setCustomers(customerList);
        setCounterparties(cpList);
        setPools(poolList.filter((pool) => pool.status === "ACTIVE"));
        setGameTypes(gameTypeList);
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
    const defaultGameType = gameTypes.find((item) => item.is_default)?.name;
    const gameTypeField = isDfq ? "dfq_game_type" : "game_type";
    if (defaultGameType && form.getFieldValue(gameTypeField) == null) {
      defaults[gameTypeField] = defaultGameType;
    }
    form.setFieldsValue(defaults);
  }, [form, gameTypes, isDfq, isRecovery, isTh, orderType, props.open]);

  const submit = async (values: Record<string, unknown>) => {
    setSubmitting(true);
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
          form_extra: (values.form_extra as Record<string, unknown> | undefined) ?? undefined,
          account_snapshot: {
            game_type: values.dfq_game_type as string,
            game_account: values.dfq_game_account as string,
            game_password: values.dfq_game_password as string,
            channel_region: values.dfq_channel_region as string,
            bound_phone: values.dfq_bound_phone as string,
            has_secondary: values.dfq_has_secondary ? values.dfq_has_secondary === "有" : undefined,
            purchase_price: values.dfq_purchase_price as string | undefined,
            note: values.dfq_account_note as string,
          },
          customer_roles: [{ customer_id: customer.customer.id, role: "INSTALLMENT_CUSTOMER" }],
          initial_buy: {
            amount: String(values.dfq_total_amount ?? 0),
            occurred_on: today(),
            portion: "PRINCIPAL",
            pool_id: values.dfq_payment_pool_id as number,
            note: `付款：剩余号款｜付款对象：${String(values.dfq_payment_recipient || "供货方")}${values.dfq_payment_note ? `｜${String(values.dfq_payment_note)}` : ""}`,
          },
          installment: {
            contract_type: "ADVANCE_PURCHASE",
            adjust_final_period: true,
            principal: String(values.dfq_purchase_price ?? 0),
            down_payment: String(values.dfq_down_payment ?? 0),
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
          contact_name: values[isDg ? "dg_customer_contact" : "customer_contact_name"] as string,
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
        // TH 的业务角色是同行（PEER）；页面仍以“供货方”展示业务称呼。
        // 后端按订单参与方契约校验 TH 只能使用 PEER。
        const role = "PEER";
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
      const counterpartyRole = isTh ? "PEER" : String(values.counterparty_role ?? "PEER");
      const customerRoles = values.customer_id
        ? [{ customer_id: values.customer_id as number, role: customerRole }]
        : [];
      const initialCosts = (isRecovery || isTh) ? [
        ...(Number(values.intermediary_fee) > 0 ? [{
          amount: String(values.intermediary_fee), occurred_on: today(), portion: "PRINCIPAL",
          pool_id: values.payment_pool_id as number, flow_category: "FEE",
          note: `${isTh ? "提号中介费" : "中介费"}｜平台：${String(values.intermediary_platform ?? "")}｜类型：${String(values.intermediary_type ?? "")}${values.compensation_type ? `｜${String(values.compensation_type)}` : ""}`,
        }] : []),
        ...(Number(values.other_fee_amount) > 0 ? [{
          amount: String(values.other_fee_amount), occurred_on: today(), portion: "PRINCIPAL",
          pool_id: values.payment_pool_id as number, flow_category: "OTHER",
          note: `${String(values.other_fee_name || (isTh ? "其他" : "其他费用"))}｜收款对象：${String(values.other_fee_recipient ?? "")}`,
        }] : []),
        ...(Number(values.design_fee) > 0 ? [{
          amount: String(values.design_fee), occurred_on: today(), portion: "PRINCIPAL",
          pool_id: values.payment_pool_id as number, flow_category: "DESIGN",
          note: "设计费",
        }] : []),
      ] : [];
      await ordersApi.create({
        order_type: props.initialOrderType,
        trade_date: today(),
        account_snapshot: undefined,
        account_id: undefined,
        note,
        game_type: values.game_type as string | undefined,
        game_account: values.game_account as string | undefined,
        game_password: values.game_password as string | undefined,
        channel_region: values.channel_region as string | undefined,
        bound_phone: values.bound_phone as string | undefined,
        has_secondary: values.has_secondary === "有" ? true : values.has_secondary === "无" ? false : undefined,
        account_note: values.game_account_note as string | undefined,
        // 佣金口径仅 DG 生效，其余业务类型一律不带这两个字段。
        commission_mode: isDg ? (values.commission_mode as string | undefined) : undefined,
        commission_payer: isDg ? (values.commission_payer as string | undefined) : undefined,
        customer_roles: customerRoles,
        counterparty_roles: counterpartyId
          ? [
              {
                counterparty_id: counterpartyId,
                role: counterpartyRole,
              },
            ]
          : [],
        initial_buy: (isRecovery || isTh) ? {
          amount: String((isRecovery ? values.recovery_price : values.th_purchase_amount) ?? 0),
          occurred_on: today(), portion: "PRINCIPAL", pool_id: values.payment_pool_id as number,
          note: isRecovery
            ? `回收价｜付款对象：${String(values.payment_recipient || "卖家")}${values.payment_note ? `｜${String(values.payment_note)}` : ""}`
            : `提号｜付${String(values.payment_recipient || "供货方")}${values.payment_note ? `｜${String(values.payment_note)}` : ""}`,
        } : undefined,
        initial_costs: initialCosts,
        form_extra: (values.form_extra as Record<string, unknown> | undefined) ?? undefined,
      });
      message.success(isDg ? "代挂订单已创建，获客信息已保存" : "订单已创建");
      props.onClose();
      form.resetFields();
      await props.onCreated();
    } catch (error) {
      setLoadError(normalizeError(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={<span className="resizable-modal__drag-handle">{modalTitle}</span>}
      open={props.open}
      destroyOnHidden
      onCancel={() => {
        if (form.isFieldsTouched()) {
          Modal.confirm({
            title: "放弃未保存的建单内容？",
            content: "表单已填写但未提交，关闭后将丢失本次输入。",
            okText: "放弃",
            cancelText: "继续编辑",
            okButtonProps: { danger: true },
            onOk: () => props.onClose(),
          });
        } else {
          props.onClose();
        }
      }}
      afterOpenChange={resetAdaptiveModalLayout}
      footer={(
        <PermissionButton permission="order.create" type="primary" htmlType="submit" form={formId} loading={submitting}>
          创建订单
        </PermissionButton>
      )}
      width={1200}
      wrapClassName="adaptive-business-modal recovery-order-modal"
      modalRender={(modal) => <ResizableModal getLayout={getRecoveryLayout} layoutAttribute="data-recovery-layout">{modal}</ResizableModal>}
    >
      <ErrorBanner error={loadError} />
      <Form
        form={form}
        id={formId}
        layout="horizontal"
        scrollToFirstError
        labelCol={{ flex: "0 0 96px" }}
        wrapperCol={{ flex: "1 1 auto" }}
        onFinish={submit}
        onValuesChange={(changed) => {
          if ("dfq_periods" in changed) {
            const count = Number(changed.dfq_periods);
            const schedule = (form.getFieldValue("dfq_schedule") ?? []) as Array<{ due_on?: unknown }>;
            if (Number.isInteger(count) && count > 0 && count <= 120 && count !== schedule.length) {
              const apply = () => form.setFieldValue("dfq_schedule", count > schedule.length
                ? [...schedule, ...Array.from({ length: count - schedule.length }, () => ({}))]
                : schedule.slice(0, count));
              if (count < schedule.length && schedule.slice(count).some((item) => item?.due_on)) {
                Modal.confirm({ title: "减少期数会删除已填写的到期日", okText: "确认删除", cancelText: "保留期次", content: "确认删除超出期数的计划吗？", onOk: apply, onCancel: () => form.setFieldValue("dfq_periods", schedule.length) });
              } else apply();
            }
          }
          const clear: Record<string, undefined> = {};
          for (const [source, other] of [["customer_source", "customer_source_other"], ["dg_customer_source", "dg_customer_source_other"], ["supplier_source", "supplier_source_other"]]) {
            if (source in changed && changed[source] !== "其他") clear[other] = undefined;
          }
          if ("intermediary_fee" in changed && !(Number(changed.intermediary_fee) > 0)) {
            clear.intermediary_platform = undefined;
            clear.intermediary_type = undefined;
            clear.compensation_type = undefined;
          } else if ("intermediary_type" in changed && changed.intermediary_type !== "包赔") {
            clear.compensation_type = undefined;
          }
          if (Object.keys(clear).length) form.setFieldsValue(clear);
        }}
        initialValues={{
          order_type: props.initialOrderType,
          ...(isRecovery
            ? { customer_role: "SELLER", counterparty_role: "PEER" }
            : isTh
              ? { supplier_source: "氪金联盟" }
              : {}),
        }}
      >
        <FieldConfigContext.Provider value={config}>
          {isRecovery ? <RecoveryAccountSection gameTypes={gameTypes}>
            <RecoveryFeeSection totalRecoveryCost={totalRecoveryCost} pools={pools} />
          </RecoveryAccountSection> : isTh ? <ThOrderSection pools={pools} gameTypes={gameTypes} /> : isDg ? <DgOrderSection gameTypes={gameTypes} /> : <DfqOrderSection pools={pools} gameTypes={gameTypes} />}
          {isRecovery ? <RecoveryCustomerSection customerSource={customerSource} /> : null}
          {customFields.length > 0 && (
            <section className="ui-stack" data-testid="custom-fields">
              {customFields.map((def) => (
                <CustomFormField key={def.id} def={def} />
              ))}
            </section>
          )}
        </FieldConfigContext.Provider>
      </Form>
    </Modal>
  );
}
