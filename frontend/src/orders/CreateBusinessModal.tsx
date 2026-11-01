import { appMessage, appModal } from "../shared/ui/appFeedback";
/** 业务创建弹窗：所有入口都明确指定业务类型，账号信息只在订单快照或库存关联中出现。 */
import { Form } from "antd";
import dayjs from "dayjs";
import { useEffect, useRef, useState } from "react";
import { useOrderFormConfig, useOrderFormSectionLabels, FieldConfigContext, SectionLabelsContext, CustomFieldSection } from "./ConfigurableField";
import {
  counterpartiesApi,
  customersApi,
  gameTypesApi,
  ordersApi,
  poolsApi,
  employeesApi,
  stocksApi,
  type Counterparty,
  type Customer,
  type GameTypeOption,
  type Pool,
  type EmployeeOption,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { BusinessActionModal, BusinessRegistrationForm, ErrorBanner, PermissionButton } from "../shared/ui";
import { RecoveryAccountSection } from "./recovery/RecoveryAccountSection";
import { RecoveryCustomerSection } from "./recovery/RecoveryCustomerSection";
import { RecoveryFeeSection } from "./recovery/RecoveryFeeSection";
import { useRecoveryFormState } from "./recovery/useRecoveryFormState";
import { ThOrderSection } from "./th/ThOrderSection";
import { resizeInstallmentSchedule, serializeInstallmentSchedule } from "./InstallmentScheduleFields";
import { DgOrderSection } from "./dg/DgOrderSection";

export type BusinessOrderType = "HS" | "TH" | "DG";

const MODAL_TITLES: Record<string, string> = {
  HS: "新建回收订单",
  TH: "新建提号订单",
  DG: "新建代挂订单",
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
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [gameTypes, setGameTypes] = useState<GameTypeOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const repurchaseConfirmedKey = useRef<string | null>(null);
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
      repurchaseConfirmedKey.current = null;
    }
  }, [props.open, form]);

  // 基础数据随页面挂载即预热并常驻内存：后续每次打开弹窗直接读 state，不再发网络请求。
  // 仅成功初始化一次；失败不置位，下次打开可重试。
  const didInitLookup = useRef(false);
  useEffect(() => {
    if (didInitLookup.current) return;
    void (async () => {
      try {
        const [customerList, cpList, poolList, gameTypeList, employeeList] = await Promise.all([
          customersApi.list(),
          counterpartiesApi.list(),
          poolsApi.list(),
          gameTypesApi.list({ include_inactive: false }),
          employeesApi.list(),
        ]);
        setCustomers(Array.isArray(customerList) ? customerList : []);
        setCounterparties(Array.isArray(cpList) ? cpList : []);
        setPools((Array.isArray(poolList) ? poolList : []).filter((pool) => pool.status === "ACTIVE"));
        setGameTypes(Array.isArray(gameTypeList) ? gameTypeList : []);
        setEmployees((Array.isArray(employeeList) ? employeeList : []).filter((employee) => employee.is_active));
        setLoadError(null);
        didInitLookup.current = true;
      } catch (error) {
        setLoadError(normalizeError(error));
      }
    })();
  }, []);

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
      const gameType = String(values.game_type ?? "").trim();
      const duplicateKey = `${gameType}\u0000${gameAccount}`;
      if (gameAccount && gameType && repurchaseConfirmedKey.current !== duplicateKey) {
        const existingAccounts = await stocksApi.list();
        const duplicates = existingAccounts.filter((account) => (
          account.status !== "VOID"
          && String(account.game_account ?? "").trim() === gameAccount
          && String(account.game_type ?? "").trim() === gameType
        ));
        // 账号只有在历史库存已售出后才允许回流；未知状态也按未售出处理，避免重复进入库存。
        const unsoldDuplicate = duplicates.find((account) => account.status !== "SOLD");
        if (unsoldDuplicate) {
          const message = `已有未售出库存账号「${gameAccount}」，请先售出后再建单`;
          form.setFields([{ name: "game_account", errors: [message] }]);
          setLoadError({ message });
          return;
        }
        const duplicate = duplicates.find((account) => account.status === "SOLD");
        if (duplicate && repurchaseConfirmedKey.current !== duplicateKey) {
          const message = `历史库存账号「${gameAccount}」已售出，请确认是否为复购回流订单`;
          form.setFields([{ name: "game_account", errors: [message] }]);
          setLoadError({ message });
          appModal.confirm({
            title: "检测到重复游戏账号",
            content: `历史账号「${gameAccount}」已售出，可作为复购回流重新入库。请确认是否继续建单。`,
            okText: "是，继续建单",
            cancelText: "否，返回修改",
            onOk: () => {
              repurchaseConfirmedKey.current = duplicateKey;
              form.setFields([{ name: "game_account", errors: [] }]);
              setLoadError(null);
              return submit(values);
            },
          });
          return;
        }
      }
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
      const customerPrefix = isDg ? "dg_" : "";
      const customerSourceField = isDg ? "dg_customer_source" : "customer_source";
      const selectedCustomerSource = values[customerSourceField] as string | undefined;
      const customerSourceOtherField = isDg ? "dg_customer_source_other" : "customer_source_other";
      const resolvedCustomerSource = selectedCustomerSource === "其他"
        ? values[customerSourceOtherField] as string
        : selectedCustomerSource;
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
          pool_id: (values.intermediary_pool_id ?? values.payment_pool_id) as number, flow_category: "FEE",
          note: `${isTh ? "提号中介费" : "中介费"}｜平台：${String(values.intermediary_platform ?? "")}｜类型：${String(values.intermediary_type ?? "")}${values.compensation_type ? `｜${String(values.compensation_type)}` : ""}`,
        }] : []),
        ...((values.expense_items as Array<{ name?: unknown; amount?: unknown; pool_id?: unknown; note?: unknown }> | undefined) ?? [])
          .filter((item) => Number(item.amount) > 0)
          .map((item) => ({
            amount: String(item.amount), occurred_on: today(), portion: "PRINCIPAL",
            pool_id: (item.pool_id ?? values.payment_pool_id) as number, flow_category: "OTHER",
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
          wallet_realname: values.wallet_realname as string | undefined,
          note: values.game_account_note as string | undefined,
          extra_values: Object.keys(accountExtraValues).length ? accountExtraValues : undefined,
        },
        account_id: undefined,
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
      setLoadError(normalizeError(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BusinessActionModal
      title={<span className="resizable-modal__drag-handle">{modalTitle}</span>}
      fieldCount={21}
      open={props.open}
      onCancel={() => {
        const currentValues = form.getFieldsValue(true);
        const isDirty = JSON.stringify(currentValues) !== JSON.stringify(initialValuesRef.current);
        if (isDirty) {
          appModal.confirm({
            title: "放弃未保存的建单内容？",
            content: "表单已填写但未提交，关闭后将丢失本次输入。",
            className: "heijin-fast-confirm",
            okText: "放弃",
            cancelText: "继续编辑",
            okButtonProps: { danger: true },
            onOk: () => props.onClose(),
          });
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
          for (const [source, other] of [["supplier_source", "supplier_source_other"]]) {
            if (source in changed && changed[source] !== "其他") clear[other] = undefined;
          }
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
            </RecoveryAccountSection> : isTh ? <ThOrderSection pools={pools} gameTypes={gameTypes} employees={employees} /> : <DgOrderSection gameTypes={gameTypes} employees={employees} />}
            {isRecovery ? <RecoveryCustomerSection customerExtras={<CustomFieldSection section="PARTICIPANT" testIdSuffix="participant" />} /> : null}
            <CustomFieldSection section="EXTRA" testIdSuffix="extra" />
          </SectionLabelsContext.Provider>
        </FieldConfigContext.Provider>
      </BusinessRegistrationForm>
    </BusinessActionModal>
  );
}
