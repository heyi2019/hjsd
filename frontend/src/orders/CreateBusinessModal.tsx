import { appMessage } from "../shared/ui/appFeedback";
/** 业务创建弹窗：所有入口都明确指定业务类型，账号信息只在订单快照或库存关联中出现。 */
import { Form, Input, Modal } from "antd";
import { useEffect, useRef, useState } from "react";
import { useOrderFormConfig, useOrderFormSectionLabels, FieldConfigContext, SectionLabelsContext, CustomFieldSection } from "./ConfigurableField";
import {
  counterpartiesApi,
  customersApi,
  gameTypesApi,
  ordersApi,
  poolsApi,
  employeesApi,
  type Counterparty,
  type Customer,
  type GameTypeOption,
  type Pool,
  type EmployeeOption,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { BusinessActionModal, BusinessRegistrationForm, ConfirmDialog, ErrorBanner, PermissionButton, Select } from "../shared/ui";
import { RecoveryAccountSection } from "./recovery/RecoveryAccountSection";
import { RecoveryCustomerSection } from "./recovery/RecoveryCustomerSection";
import { RecoveryFeeSection } from "./recovery/RecoveryFeeSection";
import { useRecoveryFormState } from "./recovery/useRecoveryFormState";
import { ThOrderSection } from "./th/ThOrderSection";
import { DgOrderSection } from "./dg/DgOrderSection";
import { PARTY_SOURCE_FALLBACK_OPTIONS } from "./CustomerSourceInput";
import {
  buildCounterpartyRoles,
  buildCustomerRoles,
  TH_COUNTERPARTY_ROLE,
  type BusinessOrderType,
} from "./participantRoles";

export type { BusinessOrderType } from "./participantRoles";

const MODAL_TITLES: Record<string, string> = {
  HS: "新建回收订单",
  TH: "新建提号订单",
  DG: "新建代挂订单",
};

function positiveId(value: unknown): number | undefined {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export function CreateBusinessModal(props: {
  open: boolean;
  onClose: () => void;
  /** 建单成功后的刷新回调（页面重新拉列表）。 */
  onCreated: () => void | Promise<void>;
  /** 由明确业务入口传入订单类型。 */
  initialOrderType: BusinessOrderType;
}) {
  const orderType = props.initialOrderType;
  const modalTitle = MODAL_TITLES[orderType];
  const isRecovery = orderType === "HS";
  const isTh = orderType === "TH";
  const isDg = orderType === "DG";
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [gameTypes, setGameTypes] = useState<GameTypeOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const repurchaseConfirmedFor = useRef<string | null>(null);
  const [repurchasePrompt, setRepurchasePrompt] = useState<{ values: Record<string, unknown>; gameAccount: string } | null>(null);
  const [abandonConfirmOpen, setAbandonConfirmOpen] = useState(false);
  const [customerCreateOpen, setCustomerCreateOpen] = useState(false);
  const [customerSubmitting, setCustomerSubmitting] = useState(false);
  const [customerForm] = Form.useForm();
  const [supplierCreateOpen, setSupplierCreateOpen] = useState(false);
  const [supplierSubmitting, setSupplierSubmitting] = useState(false);
  const [supplierForm] = Form.useForm();
  const initialValuesRef = useRef<Record<string, unknown>>({});
  const { totalRecoveryCost } = useRecoveryFormState(form);
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

  // 基础数据随页面挂载即预热并常驻内存：后续每次打开弹窗直接读 state，不再发网络请求。
  // 仅成功初始化一次；失败不置位，下次打开可重试。
  const didInitCommonLookup = useRef(false);
  useEffect(() => {
    if (didInitCommonLookup.current) return;
    void (async () => {
      try {
        const [cpList, poolList, gameTypeList, employeeList] = await Promise.all([
          counterpartiesApi.list({ type: TH_COUNTERPARTY_ROLE, status: "ACTIVE" }),
          poolsApi.list(),
          gameTypesApi.list({ include_inactive: false }),
          employeesApi.list(),
        ]);
        setCounterparties(Array.isArray(cpList) ? cpList : []);
        setPools((Array.isArray(poolList) ? poolList : []).filter((pool) => pool.status === "ACTIVE"));
        setGameTypes(Array.isArray(gameTypeList) ? gameTypeList : []);
        setEmployees((Array.isArray(employeeList) ? employeeList : []).filter((employee) => employee.is_active));
        setLoadError(null);
        didInitCommonLookup.current = true;
      } catch (error) {
        setLoadError(normalizeError(error));
      }
    })();
  }, []);

  const didInitCustomerLookup = useRef(false);
  useEffect(() => {
    if (isTh || didInitCustomerLookup.current) return;
    void Promise.resolve(customersApi.list())
      .then((customerList) => {
        setCustomers(Array.isArray(customerList) ? customerList : []);
        setLoadError(null);
        didInitCustomerLookup.current = true;
      })
      .catch((error) => {
        setLoadError(normalizeError(error));
      });
  }, [isTh]);

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
  }, [form, gameTypes, isRecovery, orderType, props.open]);

  const submit = async (values: Record<string, unknown>) => {
    setSubmitting(true);
    try {
      const gameAccount = String(values.game_account ?? "").trim();
      // 判重已后移到后端（POST /orders）：未售出重复由后端返回 INVENTORY_ACCOUNT_IN_STOCK
      // 并在 game_account 字段上提示；已售出重复返回 REPURCHASE_CONFIRM_REQUIRED，
      // 由确认弹窗决定是否按复购回流继续。前端不再拉库存台账自行比对。
      const formExtra = (values.form_extra as Record<string, unknown> | undefined) ?? {};
      const accountExtraKeys = new Set(
        Object.values(config)
          .filter((field) => field.is_custom && field.is_active && field.section === "ACCOUNT_PRODUCT")
          .map((field) => field.field_key),
      );
      const accountExtraValues = Object.fromEntries(
        Object.entries(formExtra).filter(([key, value]) => accountExtraKeys.has(key) && value !== undefined && value !== ""),
      );
      const orderFormExtra = Object.fromEntries(
        Object.entries(formExtra).filter(([key]) => !accountExtraKeys.has(key)),
      );
      for (const key of ["business_responsible_ids", "delivery_responsible_ids"]) {
        const responsibleIds = Array.isArray(values[key])
          ? values[key].filter((id): id is number => typeof id === "number")
          : [];
        if (responsibleIds.length > 0) orderFormExtra[key] = responsibleIds;
      }
      // 交付信息随订单持久化：交易平台 / 中介类型 / 包赔类型 / 手机号绑定人。
      // 与 delivery_responsible_ids 同口径写入 form_extra，供订单详情回显
      // （账号实体与 account_snapshot 均未回传 bound_phone_owner，详情改读 extra_values）。
      for (const key of ["intermediary_platform", "intermediary_type", "compensation_type", "bound_phone_owner"]) {
        const v = values[key];
        if (v !== undefined && v !== null && v !== "") orderFormExtra[key] = v;
      }
      let resolvedCustomerSource: string | undefined;
      if (isRecovery || isDg) {
        const customerSourceField = isDg ? "dg_customer_source" : "customer_source";
        const selectedCustomerSource = values[customerSourceField] as string | undefined;
        const customerSourceOtherField = isDg ? "dg_customer_source_other" : "customer_source_other";
        resolvedCustomerSource = selectedCustomerSource === "其他"
          ? values[customerSourceOtherField] as string
          : selectedCustomerSource;
      }
      let customerId = positiveId(values.customer_id);
      if ((isRecovery || isDg) && customerId == null) {
        const displayName = String(values.customer_lookup ?? "").trim();
        if (displayName) {
          const created = await customersApi.create({
            display_name: displayName,
            contact_name: (isDg ? values.dg_customer_contact : values.customer_contact_name) as string,
            phone: (isDg ? values.dg_customer_phone : values.customer_phone) as string,
            wechat: (isDg ? values.dg_customer_wechat : values.customer_wechat) as string,
            qq: (isDg ? values.dg_customer_qq : values.customer_qq) as string,
            source: resolvedCustomerSource,
            note: (isDg ? values.dg_note : values.note) as string,
          });
          customerId = created.customer.id;
          setCustomers((items) => [...items, created.customer]);
        }
      }
      const note = (isRecovery || isDg) && resolvedCustomerSource
        ? `客户来源：${String(resolvedCustomerSource)}${values[isDg ? "dg_note" : "note"] ? `｜${String(values[isDg ? "dg_note" : "note"])}` : ""}`
        : isTh
          ? [
              values.th_account_note as string,
              values.supplier_note as string,
              values.th_receive_amount ? `预期收买家：${String(values.th_receive_amount)}` : "",
            ].filter(Boolean).join("｜") || undefined
          : values.note as string;
      let counterpartyId = isTh
        ? positiveId(values.supplier_counterparty_id)
        : positiveId(values.counterparty_id);
      if (isTh && counterpartyId == null) {
        const displayName = String(values.supplier_lookup ?? "").trim();
        if (displayName) {
          const created = await counterpartiesApi.create({
            display_name: displayName,
            type: "SUPPLIER",
            contact_name: values.supplier_contact_name as string,
            phone: values.supplier_phone as string,
            wechat: values.supplier_wechat as string,
            qq: values.supplier_qq as string,
            note: values.supplier_note as string,
          });
          counterpartyId = created.id;
          setCounterparties((items) => [...items, created]);
        }
      }
      const customerRoles = buildCustomerRoles(orderType, customerId);
      const counterpartyRoles = buildCounterpartyRoles(
        orderType,
        counterpartyId,
        values.counterparty_role as string | undefined,
      );
      const initialCosts = (isRecovery || isTh) ? [
        ...((values.expense_items as Array<{ name?: unknown; amount?: unknown; note?: unknown }> | undefined) ?? [])
          .filter((item) => Number(item.amount) > 0)
          .map((item) => ({
            amount: String(item.amount), occurred_on: today(), portion: "PRINCIPAL",
            pool_id: values.payment_pool_id as number, flow_category: "OTHER",
            note: [String(item.name || "其他支出"), item.note ? String(item.note) : ""].filter(Boolean).join("｜"),
          })),
      ] : [];
      await ordersApi.create({
        order_type: props.initialOrderType,
        trade_date: today(),
        // 2026-10-28 口径：账号资料统一走 account_snapshot（与建单一致），
        // 后端据此内联建库存账号并发放 KU_ 编号；与单独账号字段互斥。
        account_snapshot: {
          game_account: values.game_account as string,
          game_type: values.game_type as string | undefined,
          game_password: values.game_password as string | undefined,
          channel_region: values.channel_region as string | undefined,
          bound_phone: values.bound_phone as string | undefined,
          bound_phone_owner: values.bound_phone_owner as string | undefined,
          has_secondary: values.has_secondary === "有" ? true : values.has_secondary === "无" ? false : undefined,
          // 二次图片只在「有二次」时随号入库；无二次时表单残留不提交。
          secondary_images: values.has_secondary === "有"
            ? ((values.secondary_images as string[] | undefined)?.length ? values.secondary_images as string[] : undefined)
            : undefined,
          wallet_realname: values.wallet_realname as string | undefined,
          // 钱包实名注销佐证图：仅「已注销」时随号入库。
          wallet_realname_images: values.wallet_realname === "已注销"
            ? ((values.wallet_realname_images as string[] | undefined)?.length ? values.wallet_realname_images as string[] : undefined)
            : undefined,
          camp_account: values.camp_account as string | undefined,
          note: values.game_account_note as string | undefined,
          extra_values: Object.keys(accountExtraValues).length ? accountExtraValues : undefined,
        },
        account_id: undefined,
        // 后端判重：仅当用户已确认复购回流时，同一「已售出」账号才放行。
        confirm_repurchase: repurchaseConfirmedFor.current === gameAccount,
        note,
        customer_roles: customerRoles,
        counterparty_roles: counterpartyRoles,
        initial_buy: (isRecovery || isTh) ? {
          amount: String((isRecovery ? values.recovery_price : values.th_purchase_amount) ?? 0),
          occurred_on: today(), portion: "PRINCIPAL", pool_id: values.payment_pool_id as number,
          note: isRecovery ? "回收价" : "提号",
        } : undefined,
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
        form.setFields([{ name: "game_account", errors: [normalized.message] }]);
        setLoadError(normalized);
        return;
      }
      if (normalized.code === "REPURCHASE_CONFIRM_REQUIRED") {
        form.setFields([{ name: "game_account", errors: [normalized.message] }]);
        setRepurchasePrompt({ values, gameAccount: String(values.game_account ?? "").trim() });
        return;
      }
      setLoadError(normalized);
    } finally {
      setSubmitting(false);
    }
  };

  const createCustomer = async (values: Record<string, unknown>) => {
    setCustomerSubmitting(true);
    try {
      const customer = await customersApi.create({
        display_name: String(values.display_name ?? "").trim(),
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
        source: values.source as string,
        note: values.note as string,
      });
      setCustomers((items) => [...items, customer.customer]);
      form.setFieldValue("customer_id", customer.customer.id);
      customerForm.resetFields();
      setCustomerCreateOpen(false);
      appMessage.success("客户已建档");
    } catch (error) {
      setLoadError(normalizeError(error));
    } finally {
      setCustomerSubmitting(false);
    }
  };

  const createSupplier = async (values: Record<string, unknown>) => {
    setSupplierSubmitting(true);
    try {
      const supplier = await counterpartiesApi.create({
        display_name: String(values.display_name ?? "").trim(),
        type: "SUPPLIER",
        contact_name: values.contact_name as string,
        phone: values.phone as string,
      });
      setCounterparties((items) => [...items, supplier]);
      form.setFieldValue("supplier_counterparty_id", supplier.id);
      supplierForm.resetFields();
      setSupplierCreateOpen(false);
      appMessage.success("合作伙伴已建档");
    } catch (error) {
      setLoadError(normalizeError(error));
    } finally {
      setSupplierSubmitting(false);
    }
  };

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
        onValuesChange={(changed) => {
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
              <RecoveryFeeSection totalRecoveryCost={totalRecoveryCost} pools={pools} financeExtras={<CustomFieldSection section="FINANCE" testIdSuffix="finance" />} />
            </RecoveryAccountSection> : isTh ? <ThOrderSection pools={pools} counterparties={counterparties} gameTypes={gameTypes} employees={employees} onCreateSupplier={() => setSupplierCreateOpen(true)} /> : <DgOrderSection customers={customers} onCreateCustomer={() => setCustomerCreateOpen(true)} gameTypes={gameTypes} employees={employees} />}
            {isRecovery ? <RecoveryCustomerSection customers={customers} onCreateCustomer={() => setCustomerCreateOpen(true)} customerExtras={<CustomFieldSection section="PARTICIPANT" testIdSuffix="participant" />} /> : null}
            <CustomFieldSection section="EXTRA" testIdSuffix="extra" />
          </SectionLabelsContext.Provider>
        </FieldConfigContext.Provider>
      </BusinessRegistrationForm>
    </BusinessActionModal>
    <Modal
      title="新建客户"
      open={customerCreateOpen}
      destroyOnHidden
      onCancel={() => {
        setCustomerCreateOpen(false);
        customerForm.resetFields();
      }}
      onOk={() => customerForm.submit()}
      okText="建档"
      cancelText="取消"
      confirmLoading={customerSubmitting}
    >
      <BusinessRegistrationForm
        layout="horizontal"
        labelAlign="left"
        labelCol={{ flex: "88px" }}
        wrapperCol={{ flex: "auto" }}
        form={customerForm}
        onFinish={createCustomer}
      >
        <Form.Item name="display_name" label="名字" rules={[{ required: true, message: "请输入客户名字" }]}>
          <Input />
        </Form.Item>
        <Form.Item name="contact_name" label="联系人"><Input /></Form.Item>
        <Form.Item name="phone" label="手机号"><Input /></Form.Item>
        <Form.Item name="wechat" label="微信号"><Input /></Form.Item>
        <Form.Item name="qq" label="QQ"><Input /></Form.Item>
        <Form.Item name="source" label="客户来源">
          <Select options={PARTY_SOURCE_FALLBACK_OPTIONS} placeholder="可选填" />
        </Form.Item>
        <Form.Item name="note" label="备注"><Input placeholder="可选填" /></Form.Item>
      </BusinessRegistrationForm>
    </Modal>
    <Modal
      title="新建合作伙伴"
      open={supplierCreateOpen}
      destroyOnHidden
      onCancel={() => {
        setSupplierCreateOpen(false);
        supplierForm.resetFields();
      }}
      onOk={() => supplierForm.submit()}
      okText="建档"
      cancelText="取消"
      confirmLoading={supplierSubmitting}
    >
      <BusinessRegistrationForm
        layout="horizontal"
        labelAlign="left"
        labelCol={{ flex: "88px" }}
        wrapperCol={{ flex: "auto" }}
        form={supplierForm}
        onFinish={createSupplier}
      >
        <Form.Item name="display_name" label="名称" rules={[{ required: true, message: "请输入合作伙伴名称" }]}>
          <Input />
        </Form.Item>
        <Form.Item name="contact_name" label="联系人">
          <Input />
        </Form.Item>
        <Form.Item name="phone" label="手机号">
          <Input />
        </Form.Item>
      </BusinessRegistrationForm>
    </Modal>
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
