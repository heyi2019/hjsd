import { appMessage } from "../shared/ui/appFeedback";
/** 业务创建弹窗：所有入口都明确指定业务类型，账号信息只在订单快照或库存关联中出现。 */
import { Form } from "antd";
import { useEffect, useRef, useState } from "react";
import { useOrderFormConfig, useOrderFormSectionLabels, FieldConfigContext, SectionLabelsContext, CustomFieldSection } from "./ConfigurableField";
import { ordersApi } from "../shared/api/orders.api";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { BusinessActionModal, BusinessRegistrationForm, ConfirmDialog, ErrorBanner, PermissionButton } from "../shared/ui";
import { RecoveryAccountSection } from "./recovery/RecoveryAccountSection";
import { RecoveryCustomerSection } from "./recovery/RecoveryCustomerSection";
import { RecoveryFeeSection } from "./recovery/RecoveryFeeSection";
import { ThOrderSection } from "./th/ThOrderSection";
import { DgOrderSection } from "./dg/DgOrderSection";
import "./CreateBusinessModal.css";
import {
  buildAccountSnapshot,
  buildCounterpartyInput,
  buildCustomerInput,
  buildInitialBuy,
  buildInitialCosts,
  buildOrderNote,
  resolveCustomerSource,
  splitFormExtra,
} from "./create/submit-helpers";
import { useCreateBusinessLookups } from "./create/useCreateBusinessLookups";

export type BusinessOrderType = "HS" | "TH" | "DG";

const MODAL_TITLES: Record<string, string> = {
  HS: "新建回收订单",
  TH: "新建提号订单",
  DG: "新建代挂订单",
};

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
  const {
    pools,
    gameTypes,
    employees,
    loadError,
    setLoadError,
  } = useCreateBusinessLookups();
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const repurchaseConfirmedFor = useRef<string | null>(null);
  const submitErrorVisible = useRef(false);
  const [repurchasePrompt, setRepurchasePrompt] = useState<{ values: Record<string, unknown>; gameAccount: string } | null>(null);
  const [abandonConfirmOpen, setAbandonConfirmOpen] = useState(false);
  const initialValuesRef = useRef<Record<string, unknown>>({});
  const formId = "business-order-form";
  // 表单字段配置改为常驻预热：弹窗随页面挂载即加载，不再等 open 才拉取。
  // 不同业务类型通过 orderType 变化自动切换配置（get/post 走已落地的 GET 缓存层）。
  const { config } = useOrderFormConfig(orderType);
  const { labels } = useOrderFormSectionLabels(orderType);
  // 关闭弹窗即清空表单：antd Form 默认 preserve=true，destroyOnHidden 只销毁 DOM 不丢表单实例值，
  // 仅成功路径显式 resetFields；取消/点遮罩关闭会残留上次输入，故在 open 变 false 时统一 reset。
  useEffect(() => {
    if (!props.open) {
      form.resetFields();
      repurchaseConfirmedFor.current = null;
    }
  }, [props.open, form]);

  useEffect(() => {
    if (!props.open || !orderType) return;
    const defaults: Record<string, unknown> = {
      order_type: orderType,
    };
    if (isRecovery) {
      defaults.customer_role = "SELLER";
      defaults.counterparty_role = "PEER";
    }
    const defaultGameType = gameTypes.find((item) => item.is_default)?.name;
    const gameTypeField = "game_type";
    if (defaultGameType && form.getFieldValue(gameTypeField) == null) {
      defaults[gameTypeField] = defaultGameType;
    }
    form.setFieldsValue(defaults);
    // 以「打开瞬间」的表单值为脏判定基线：仅打开下拉再收起不算脏（P2-198）。
    initialValuesRef.current = form.getFieldsValue(true);
  }, [form, gameTypes, isRecovery, isTh, orderType, props.open]);

  const submit = async (values: Record<string, unknown>) => {
    setSubmitting(true);
    try {
      const gameAccount = String(values.game_account ?? "").trim();
      // 判重已后移到后端（POST /orders）：未售出重复由后端返回 INVENTORY_ACCOUNT_IN_STOCK
      // 并在 game_account 字段上提示；已售出重复返回 REPURCHASE_CONFIRM_REQUIRED，
      // 由确认弹窗决定是否按复购回流继续。前端不再拉库存台账自行比对。
      const { accountExtraValues, orderFormExtra } = splitFormExtra(values, config);
      const resolvedCustomerSource = resolveCustomerSource(values, isDg);
      const note = buildOrderNote(values, { isRecovery, isTh, isDg }, resolvedCustomerSource);
      const initialCosts = buildInitialCosts(values, isRecovery, isTh);
      await ordersApi.create({
        order_type: props.initialOrderType,
        trade_date: today(),
        // 2026-10-28 口径：账号资料统一走 account_snapshot（与建单一致），
        // 后端据此内联建库存账号并发放 KU_ 编号；与单独账号字段互斥。
        account_snapshot: buildAccountSnapshot(values, accountExtraValues),
        account_id: undefined,
        // 后端判重：仅当用户已确认复购回流时，同一「已售出」账号才放行。
        confirm_repurchase: repurchaseConfirmedFor.current === gameAccount,
        note,
        customer_input: buildCustomerInput({ values, isRecovery, isDg, resolvedCustomerSource }),
        counterparty_input: buildCounterpartyInput({ values, isTh }),
        initial_buy: buildInitialBuy(values, isRecovery, isTh),
        initial_costs: initialCosts,
        form_extra: Object.keys(orderFormExtra).length ? orderFormExtra : undefined,
      });
      appMessage.success(isDg ? "代挂订单已创建，获客信息已保存" : "订单已创建");
      props.onClose();
      form.resetFields();
      void Promise.resolve(props.onCreated()).catch(() => undefined);
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === "INVENTORY_ACCOUNT_IN_STOCK") {
        // 未售出重复属硬阻止：字段标红 + 页面级提示，不提供复购确认入口。
        submitErrorVisible.current = true;
        form.setFields([{ name: "game_account", errors: [normalized.message] }]);
        setLoadError(normalized);
        return;
      }
      if (normalized.code === "REPURCHASE_CONFIRM_REQUIRED") {
        submitErrorVisible.current = true;
        form.setFields([{ name: "game_account", errors: [normalized.message] }]);
        setRepurchasePrompt({ values, gameAccount: String(values.game_account ?? "").trim() });
        return;
      }
      submitErrorVisible.current = true;
      setLoadError(normalized);
    } finally {
      setSubmitting(false);
    }
  };

  // Keep the form instance connected while the modal is closed.  The controller
  // pre-creates this form so it can reset values and preload defaults; returning
  // null here left the instance unattached for one tick and rc-field-form logged
  // a misleading warning in development/tests.  The hidden form has no fields
  // and is replaced by the real modal form as soon as the modal opens.
  if (!props.open) return <Form form={form} className="orders-hidden-form" />;

  return (
    <>
    <BusinessActionModal
      title={<span className="resizable-modal__drag-handle">{modalTitle}</span>}
      fieldCount={21}
      open={props.open}
      onCancel={() => {
        const currentValues = form.getFieldsValue(true);
        const isDirty = JSON.stringify(currentValues) !== JSON.stringify(initialValuesRef.current);
        if (isDirty) {
          setAbandonConfirmOpen(true);
        } else {
          props.onClose();
        }
      }}
      footer={(
        <PermissionButton permission="order.create" type="primary" htmlType="submit" form={formId} loading={submitting}>
          创建订单
        </PermissionButton>
      )}
      width={1200}
    >
      <ErrorBanner error={loadError} />
      <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
        scope={orderType}
        form={form}
        id={formId}
        scrollToFirstError
        onFinish={submit}
        onFinishFailed={() => {
          submitErrorVisible.current = true;
          setLoadError({ code: "FORM_VALIDATION", message: "请补齐必填项后再创建订单" });
        }}
        onValuesChange={(changed) => {
          if (submitErrorVisible.current) {
            submitErrorVisible.current = false;
            setLoadError(null);
          }
          const clear: Record<string, undefined> = {};
          if ("intermediary_type" in changed && changed.intermediary_type !== "包赔") {
            clear.compensation_type = undefined;
          }
          if (Object.keys(clear).length) form.setFieldsValue(clear);
        }}
        initialValues={{
          order_type: props.initialOrderType,
          ...(isRecovery
            ? { customer_role: "SELLER", counterparty_role: "PEER" }
            : {}),
        }}
      >
        <FieldConfigContext.Provider value={config}>
          <SectionLabelsContext.Provider value={labels}>
            {isRecovery ? <RecoveryAccountSection gameTypes={gameTypes} employees={employees} businessResponsibleLabel="回收负责人" showIntermediaryDelivery accountExtras={<CustomFieldSection section="ACCOUNT_PRODUCT" testIdSuffix="account" />}>
              <RecoveryFeeSection pools={pools} financeExtras={<CustomFieldSection section="FINANCE" testIdSuffix="finance" />} />
            </RecoveryAccountSection> : isTh ? <ThOrderSection pools={pools} gameTypes={gameTypes} employees={employees} /> : <DgOrderSection gameTypes={gameTypes} employees={employees} />}
            {isRecovery ? <RecoveryCustomerSection customerExtras={<CustomFieldSection section="PARTICIPANT" testIdSuffix="participant" />} /> : null}
            <CustomFieldSection section="EXTRA" testIdSuffix="extra" />
          </SectionLabelsContext.Provider>
        </FieldConfigContext.Provider>
      </BusinessRegistrationForm>
    </BusinessActionModal>
    {/* 确认框必须渲染在业务弹窗「外侧」（与它同级），不能作为其 children。
        嵌在 children 里时，主弹窗一旦 open=false，嵌套 Modal 的关闭渲染会被跳过：
        DOM 卡在可见状态，而 state 已是 false —— 之后点 X / 取消 都是幂等 setState，
        React 直接 bail out 不重渲染，表现为「弹窗看得见但怎么都关不掉」。 */}
    <ConfirmDialog
      open={Boolean(repurchasePrompt)}
      title="检测到重复游戏账号"
      description={`历史账号「${repurchasePrompt?.gameAccount ?? ""}」已售出，可作为复购回流重新入库。请确认是否继续建单。`}
      okText="是，继续建单"
      cancelText="否，返回修改"
      onConfirm={async () => {
        const prompt = repurchasePrompt;
        if (!prompt) return;
        repurchaseConfirmedFor.current = prompt.gameAccount;
        form.setFields([{ name: "game_account", errors: [] }]);
        setLoadError(null);
        setRepurchasePrompt(null);
        await submit(prompt.values);
      }}
      onCancel={() => setRepurchasePrompt(null)}
    />
    <ConfirmDialog
      open={abandonConfirmOpen}
      title="放弃未保存的建单内容？"
      description="表单已填写但未提交，关闭后将丢失本次输入。"
      okText="放弃"
      cancelText="继续编辑"
      danger
      onConfirm={async () => { setAbandonConfirmOpen(false); props.onClose(); }}
      onCancel={() => setAbandonConfirmOpen(false)}
    />
    </>
  );
}
