/**
 * 新建订单（回收 HS / 提号 TH / 代挂 DG）。
 *
 * 与桌面端 `orders/CreateBusinessModal.tsx` 的口径对齐，但布局按移动端重排：
 *  - 桌面把「账号信息 / 费用明细 / 客户 / 交付」拆成四张卡横向铺开；手机上只能竖排，
 *    因此按「账号 → 费用 → 客户 → 交付 → 其他」的顺序分成可滚动的分组卡；
 *  - 字段的**标签、必填、选项**全部来自 `/order-form-fields`（后台「表单字段」里改了就生效），
 *    页面里的字面量只作为接口不可用时的兜底；
 *  - 自定义字段按 section 归位，值落 `form_extra.<key>`；ACCOUNT_PRODUCT 段的值落
 *    `account_snapshot.extra_values`（与账号一起入库）。
 *
 * 三个必须遵守的业务硬约束（写错了后端会 422/400，不是样式问题）：
 *  1) 资金账户必填：回收/提号建单即产生一笔「买入」流水，没有账户就无法入账；
 *  2) 客户按昵称+手机/微信去重，找不到才新建（否则同一客户会反复建档）；
 *  3) 同账号已售出时后端返回 REPURCHASE_CONFIRM_REQUIRED，必须由人确认后才置
 *     `confirm_repurchase=true` 重试 —— 不能自动确认。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createCounterparty,
  createCustomer,
  createOrder,
  listCounterparties,
  listCustomers,
  listEmployees,
  listFormFields,
  listGameTypes,
  listPools,
  listSectionLabels,
  type CounterpartyRow,
  type CustomerRow,
  type EmployeeOption,
  type FormFieldRow,
  type GameTypeRow,
  type OptionItem,
  type OrderDetail,
  type PoolRow,
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
  PickerField,
  SubmitBar,
  TextArea,
  TextInput,
  revealFirstError,
} from "../../forms/controls";
import { useOptionSet } from "../../forms/useOptionSets";
import { today } from "../../labels";
import { goBack, navigate } from "../../router";

type Kind = "HS" | "TH" | "DG";

const KIND_TITLE: Record<Kind, string> = {
  HS: "新建回收订单",
  TH: "新建提号订单",
  DG: "新建代挂订单",
};

const SECTION_TITLE: Record<string, string> = {
  ACCOUNT_PRODUCT: "账号补充信息",
  BUSINESS: "业务补充信息",
  DELIVER: "交付补充信息",
  OPERATION: "运营信息",
  FINANCE: "费用补充信息",
  PARTICIPANT: "客户补充信息",
  EXTRA: "其他补充信息",
};

const CUSTOMER_SOURCE_FALLBACK: OptionItem[] = ["自营", "微博", "小红书", "闲鱼", "同行推荐", "其他"].map((value) => ({
  value,
  label: value,
}));

const SUPPLIER_SOURCE_FALLBACK: OptionItem[] = ["氪金联盟", "同行", "其他"].map((value) => ({
  value,
  label: value,
}));

/** 表单值：全部按字符串保存，提交时再逐项转换，避免 number/string 混用导致 422。 */
type Values = Record<string, string>;

interface ExtraRow {
  amount: string;
  poolId: string;
  note: string;
}

export function OrderCreatePage({ kind }: { kind: Kind }) {
  const [fields, setFields] = useState<FormFieldRow[]>([]);
  const [sectionLabels, setSectionLabels] = useState<Record<string, string>>({});
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [gameTypes, setGameTypes] = useState<GameTypeRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [counterparties, setCounterparties] = useState<CounterpartyRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [repurchase, setRepurchase] = useState<string | null>(null);

  const sourceOptions = useOptionSet("CUSTOMER_SOURCE");
  const supplierSourceOptions = useOptionSet("SUPPLIER_SOURCE");
  const platformOptions = useOptionSet("INTERMEDIARY_PLATFORM");
  const intermediaryTypeOptions = useOptionSet("INTERMEDIARY_TYPE");
  const compensationOptions = useOptionSet("COMPENSATION_TYPE");

  const [values, setValues] = useState<Values>({
    trade_date: today(),
    game_type: "",
    game_account: "",
    game_password: "",
    camp_account: "",
    channel_region: "",
    has_secondary: "无",
    wallet_realname: "",
    game_account_note: "",
    bound_phone: "",
    bound_phone_owner: "",
    intermediary_platform: "",
    intermediary_type: "",
    compensation_type: "",
    business_responsible_id: "",
    delivery_responsible_id: "",
    // HS / TH
    recovery_price: "",
    th_purchase_amount: "",
    th_receive_amount: "",
    payment_pool_id: "",
    intermediary_fee: "",
    intermediary_pool_id: "",
    // 客户
    customer_nickname: "",
    customer_contact_name: "",
    customer_phone: "",
    customer_wechat: "",
    customer_qq: "",
    customer_source: "",
    customer_source_other: "",
    dg_customer_nickname: "",
    dg_customer_contact: "",
    dg_customer_phone: "",
    dg_customer_wechat: "",
    dg_customer_qq: "",
    dg_customer_source: "",
    dg_customer_source_other: "",
    dg_note: "",
    note: "",
    // 提号供货方
    supplier_nickname: "",
    supplier_source: "",
    supplier_source_other: "",
    supplier_contact_name: "",
    supplier_phone: "",
    supplier_wechat: "",
    supplier_qq: "",
    supplier_note: "",
    // 代挂
    sale_amount: "",
  });
  const [extraRows, setExtraRows] = useState<ExtraRow[]>([]);
  const [custom, setCustom] = useState<Values>({});

  const set = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // 基础数据：一次并行拉齐。任一失败只提示不阻塞（字段配置缺失时仍可用兜底标签建单）。
  useEffect(() => {
    let alive = true;
    void Promise.all([
      listFormFields(kind),
      listSectionLabels(kind),
      listPools(),
      listGameTypes(false),
      listEmployees(),
      listCustomers({ limit: 500 }),
    ])
      .then(([fieldRows, labels, poolRows, gameRows, employeeRows, customerPage]) => {
        if (!alive) return;
        setFields(fieldRows);
        setSectionLabels(labels);
        setPools(poolRows.filter((pool) => pool.status === "ACTIVE"));
        setGameTypes(gameRows);
        setEmployees(employeeRows.filter((employee) => employee.is_active));
        setCustomers(customerPage.items ?? []);
        const fallbackGameType = gameRows.find((item) => item.is_default)?.name;
        if (fallbackGameType) setValues((prev) => (prev.game_type ? prev : { ...prev, game_type: fallbackGameType }));
      })
      .catch((cause: unknown) => {
        if (alive) setLoadError(cause instanceof Error ? cause.message : "基础数据加载失败");
      });
    return () => {
      alive = false;
    };
  }, [kind]);

  // 提号需要供货方档案做去重；其它类型不必拉。
  useEffect(() => {
    if (kind !== "TH") return;
    void listCounterparties({ type: "PEER" })
      .then(setCounterparties)
      .catch(() => undefined);
  }, [kind]);

  const config = useMemo(() => {
    const map: Record<string, FormFieldRow> = {};
    for (const field of fields) map[field.field_key] = field;
    return map;
  }, [fields]);

  /** 字段元信息：配置优先，缺失时用调用方给的兜底。 */
  const meta = useCallback(
    (key: string, label: string, required = false) => {
      const def = config[key];
      return {
        label: def?.label ?? label,
        required: def ? def.required || Boolean(def.required_when) : required,
        active: def ? def.is_active : true,
        options: def?.options ?? null,
      };
    },
    [config],
  );

  const customFields = useMemo(
    () => fields.filter((field) => field.is_custom && field.is_active),
    [fields],
  );

  const customSections = useMemo(() => {
    const groups = new Map<string, FormFieldRow[]>();
    for (const field of customFields) {
      const section = field.section ?? "EXTRA";
      const list = groups.get(section) ?? [];
      list.push(field);
      groups.set(section, list);
    }
    for (const list of groups.values()) list.sort((a, b) => a.sort_order - b.sort_order);
    return [...groups.entries()];
  }, [customFields]);

  const channelRegions = useMemo(() => {
    const selected = gameTypes.find((item) => item.name === values.game_type);
    return selected?.channel_regions ?? [];
  }, [gameTypes, values.game_type]);

  const totalCost = useMemo(() => {
    const principal = Number(kind === "TH" ? values.th_purchase_amount : values.recovery_price) || 0;
    const fee = Number(values.intermediary_fee) || 0;
    const extra = extraRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    return (principal + fee + extra).toFixed(2);
  }, [extraRows, kind, values.intermediary_fee, values.recovery_price, values.th_purchase_amount]);

  const validate = useCallback((): boolean => {
    const next: Record<string, string> = {};
    const need = (key: string, label: string) => {
      if (!String(values[key] ?? "").trim()) next[key] = `${label}必填`;
    };
    need("game_account", meta("game_account", "游戏账号").label);
    need("game_password", meta("game_password", "账号密码").label);
    if (!values.channel_region.trim()) next.channel_region = "渠道／区服必填";

    if (kind !== "DG") {
      need("payment_pool_id", "资金账户");
    }
    if (kind === "HS") {
      if (!(Number(values.recovery_price) > 0)) next.recovery_price = "回收价必填且需大于 0";
    }
    if (kind === "TH") {
      if (!(Number(values.th_purchase_amount) > 0)) next.th_purchase_amount = "账号号价必填且需大于 0";
      if (!(Number(values.th_receive_amount) > 0)) next.th_receive_amount = "预计收买家必填且需大于 0";
      if (!values.supplier_nickname.trim()) next.supplier_nickname = "供货方昵称必填";
      if (!values.supplier_source.trim()) next.supplier_source = "供货方来源必填";
      if (values.supplier_source === "其他" && !values.supplier_source_other.trim()) {
        next.supplier_source_other = "请输入供货方来源";
      }
    }
    if (kind === "HS") {
      if (!values.customer_nickname.trim()) next.customer_nickname = "客户昵称必填";
    }
    if (kind === "DG") {
      if (!values.dg_customer_nickname.trim()) next.dg_customer_nickname = "客户昵称必填";
    }
    // 自定义字段的条件必填
    for (const field of customFields) {
      const required =
        field.required
        || (field.required_when
          ? conditionHit(field.required_when, { ...values, ...custom })
          : false);
      if (required && !String(custom[field.field_key] ?? "").trim()) {
        next[`custom.${field.field_key}`] = `${field.label}必填`;
      }
    }
    extraRows.forEach((row, index) => {
      if (!(Number(row.amount) > 0)) next[`extra.${index}.amount`] = "请输入支出金额";
      if (!row.poolId) next[`extra.${index}.poolId`] = "请选择资金账户";
    });

    setErrors(next);
    if (Object.keys(next).length > 0) {
      revealFirstError();
      return false;
    }
    return true;
  }, [custom, customFields, extraRows, kind, meta, values]);

  const submit = useCallback(
    async (confirmedRepurchase = false) => {
      setError(null);
      setBusy(true);
      try {
        const isRecovery = kind === "HS";
        const isTh = kind === "TH";
        const isDg = kind === "DG";
        const accountExtraKeys = new Set(
          customFields.filter((field) => field.section === "ACCOUNT_PRODUCT").map((field) => field.field_key),
        );
        const accountExtraValues = Object.fromEntries(
          Object.entries(custom).filter(([key, value]) => accountExtraKeys.has(key) && value !== ""),
        );
        const orderFormExtra: Record<string, unknown> = Object.fromEntries(
          Object.entries(custom).filter(([key, value]) => !accountExtraKeys.has(key) && value !== ""),
        );
        if (values.business_responsible_id) {
          orderFormExtra.business_responsible_ids = [Number(values.business_responsible_id)];
        }
        if (values.delivery_responsible_id) {
          orderFormExtra.delivery_responsible_ids = [Number(values.delivery_responsible_id)];
        }
        for (const key of ["intermediary_platform", "intermediary_type", "compensation_type", "bound_phone_owner"]) {
          if (values[key]) orderFormExtra[key] = values[key];
        }

        // ---- 客户：先按昵称 + 手机/微信去重，找不到才建档。
        let customerId: number | undefined;
        const prefix = isDg ? "dg_" : "";
        const nickname = values[`${prefix}customer_nickname`]?.trim();
        if ((isRecovery || isDg) && nickname) {
          const phone = values[`${prefix}customer_phone`];
          const wechat = values[`${prefix}customer_wechat`];
          const existing = customers.find(
            (customer) =>
              customer.display_name === nickname
              && ((phone && customer.phone === phone)
                || (wechat && customer.wechat === wechat)
                || (!phone && !wechat)),
          );
          if (existing) {
            customerId = existing.id;
          } else {
            const created = await createCustomer({
              display_name: nickname,
              contact_name: values[isDg ? "dg_customer_contact" : "customer_contact_name"] || null,
              phone: phone || null,
              wechat: wechat || null,
              qq: values[`${prefix}customer_qq`] || null,
              source: resolveOther(values[`${prefix}customer_source`], values[`${prefix}customer_source_other`]),
              note: (isDg ? values.dg_note : values.note) || null,
            });
            customerId = created.customer.id;
          }
        }

        const customerRole = isRecovery ? "SELLER" : isDg ? "CONSIGNOR" : "BUYER";

        // ---- 提号供货方：同行（PEER），同样按昵称去重。
        let counterpartyId: number | undefined;
        if (isTh && values.supplier_nickname.trim()) {
          const nicknameSource = values.supplier_nickname.trim();
          const existing = counterparties.find((item) => item.display_name === nicknameSource && item.type === "PEER");
          counterpartyId = existing
            ? existing.id
            : (await createCounterparty({
              display_name: nicknameSource,
              type: "PEER",
              contact_name: values.supplier_contact_name || null,
              phone: values.supplier_phone || null,
              wechat: values.supplier_wechat || null,
              qq: values.supplier_qq || null,
              source: resolveOther(values.supplier_source, values.supplier_source_other),
              note: values.supplier_note || null,
            })).id;
        }

        // ---- 备注：桌面端把客户来源拼进备注，H5 保持同一口径，避免两端详情显示不同。
        const customerSource = resolveOther(
          values[`${prefix}customer_source`],
          values[`${prefix}customer_source_other`],
        );
        let note: string | undefined;
        if ((isRecovery || isDg) && customerSource) {
          const body = isDg ? values.dg_note : values.note;
          note = `客户来源：${customerSource}${body ? `｜${body}` : ""}`;
        } else if (isTh) {
          note = [
            values.game_account_note,
            values.supplier_source
              ? `供货方来源：${resolveOther(values.supplier_source, values.supplier_source_other)}`
              : "",
            values.supplier_note,
            values.th_receive_amount ? `预期收买家：${values.th_receive_amount}` : "",
          ].filter(Boolean).join("｜") || undefined;
        } else {
          note = values.note || undefined;
        }

        const occurredOn = values.trade_date || today();
        const initialCosts: {
          amount: string;
          occurred_on: string;
          pool_id?: number;
          portion?: string;
          flow_category?: string;
          note?: string;
        }[] = [];
        if (Number(values.intermediary_fee) > 0) {
          initialCosts.push({
            amount: values.intermediary_fee,
            occurred_on: occurredOn,
            portion: "PRINCIPAL",
            pool_id: Number(values.intermediary_pool_id || values.payment_pool_id),
            flow_category: "FEE",
            note: `${isTh ? "提号中介费" : "中介费"}｜平台：${values.intermediary_platform || ""}｜类型：${values.intermediary_type || ""}${
              values.compensation_type ? `｜${values.compensation_type}` : ""
            }`,
          });
        }
        for (const row of extraRows) {
          if (!(Number(row.amount) > 0)) continue;
          initialCosts.push({
            amount: row.amount,
            occurred_on: occurredOn,
            portion: "PRINCIPAL",
            pool_id: Number(row.poolId || values.payment_pool_id),
            flow_category: "OTHER",
            note: row.note || "其他支出",
          });
        }

        const created: OrderDetail = await createOrder({
          order_type: kind,
          trade_date: occurredOn,
          account_snapshot: {
            game_account: values.game_account.trim(),
            game_type: values.game_type || undefined,
            game_password: values.game_password || undefined,
            camp_account: values.camp_account || undefined,
            channel_region: values.channel_region || undefined,
            bound_phone: values.bound_phone || undefined,
            bound_phone_owner: values.bound_phone_owner || undefined,
            has_secondary: values.has_secondary === "有" ? true : values.has_secondary === "无" ? false : undefined,
            wallet_realname: values.wallet_realname || undefined,
            note: values.game_account_note || undefined,
            extra_values: Object.keys(accountExtraValues).length ? accountExtraValues : undefined,
          },
          confirm_repurchase: confirmedRepurchase,
          note: note ?? null,
          customer_roles: customerId ? [{ customer_id: customerId, role: customerRole }] : [],
          counterparty_roles: counterpartyId ? [{ counterparty_id: counterpartyId, role: "PEER" }] : [],
          initial_buy: kind === "DG"
            ? undefined
            : {
              amount: kind === "TH" ? values.th_purchase_amount : values.recovery_price,
              occurred_on: occurredOn,
              portion: "PRINCIPAL",
              pool_id: Number(values.payment_pool_id),
              note: kind === "TH" ? "提号" : "回收价",
            },
          initial_costs: initialCosts.length ? initialCosts : undefined,
          form_extra: Object.keys(orderFormExtra).length ? orderFormExtra : undefined,
        });

        setRepurchase(null);
        navigate(`/orders/${created.id}`, true);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "建单失败";
        const code = (cause as { code?: string }).code;
        if (code === "REPURCHASE_CONFIRM_REQUIRED") {
          setRepurchase(values.game_account.trim());
          setErrors((prev) => ({ ...prev, game_account: message }));
        } else if (code === "INVENTORY_ACCOUNT_IN_STOCK") {
          setErrors((prev) => ({ ...prev, game_account: message }));
          setError(message);
          revealFirstError();
        } else {
          setError(message);
        }
      } finally {
        setBusy(false);
      }
    },
    [counterparties, custom, customFields, customers, extraRows, kind, values],
  );

  const submitHandler = useCallback(() => {
    if (!validate()) return;
    void submit(false);
  }, [submit, validate]);

  const isRecovery = kind === "HS";
  const isTh = kind === "TH";
  const isDg = kind === "DG";
  const customerPrefix = isDg ? "dg_" : "";

  return (
    <FormPage
      title={KIND_TITLE[kind]}
      subtitle={values.trade_date}
      onBack={() => goBack("/business/ledger")}
      footer={
        <SubmitBar
          label="创建订单"
          busy={busy}
          hint={isDg ? "代挂单只登记账号与委托方，售出时再结算" : `建单即登记买入，合计成本 ¥${totalCost}`}
          onClick={submitHandler}
        />
      }
    >
      <FormError error={loadError ?? error} />

      <FormSection title={sectionLabels.ACCOUNT_PRODUCT ?? "游戏账号信息"}>
        <Field label={meta("trade_date", "成交日期", true).label} required>
          <DateInput value={values.trade_date} max={today()} onChange={(next) => set("trade_date", next)} />
        </Field>

        {gameTypes.length > 0 ? (
          <PickerField
            label={meta("game_type", "游戏类型", true).label}
            required
            value={values.game_type}
            searchable
            options={gameTypes.map((item) => ({ value: item.name, label: item.name }))}
            onChange={(next) => {
              set("game_type", next);
              set("channel_region", "");
            }}
            placeholder="请选择游戏类型"
          />
        ) : (
          <Field label="游戏类型" required>
            <TextInput value={values.game_type} onChange={(next) => set("game_type", next)} placeholder="例如：王者荣耀" />
          </Field>
        )}

        <Field label={meta("game_account", "游戏账号", true).label} required error={errors.game_account}>
          <TextInput
            value={values.game_account}
            onChange={(next) => set("game_account", next)}
            placeholder="请输入游戏账号"
          />
        </Field>

        <Field label={meta("game_password", "账号密码", true).label} required error={errors.game_password}>
          <TextInput
            value={values.game_password}
            onChange={(next) => set("game_password", next)}
            placeholder="请输入账号密码"
          />
        </Field>

        <Field label={meta("camp_account", "营地账号").label}>
          <TextInput value={values.camp_account} onChange={(next) => set("camp_account", next)} placeholder="可选填" />
        </Field>

        {channelRegions.length > 0 ? (
          <PickerField
            label={meta("channel_region", "渠道／区服", true).label}
            required
            searchable
            value={values.channel_region}
            options={channelRegions.map((item) => ({ value: item, label: item }))}
            onChange={(next) => set("channel_region", next)}
            placeholder="请选择渠道／区服"
            error={errors.channel_region}
          />
        ) : (
          <Field label={meta("channel_region", "渠道／区服", true).label} required error={errors.channel_region}>
            <TextInput
              value={values.channel_region}
              onChange={(next) => set("channel_region", next)}
              placeholder="例如：安卓一区／微信"
            />
          </Field>
        )}

        <ChipField
          label={meta("has_secondary", "有无二次").label}
          value={values.has_secondary}
          options={[
            { value: "无", label: "无二次" },
            { value: "有", label: "有二次" },
          ]}
          onChange={(next) => set("has_secondary", next)}
        />

        <PickerField
          label={meta("wallet_realname", "钱包实名").label}
          value={values.wallet_realname}
          allowClear
          options={[
            { value: "未注销", label: "未注销" },
            { value: "已注销", label: "已注销" },
          ]}
          onChange={(next) => set("wallet_realname", next)}
          placeholder="请选择"
        />

        {employees.length > 0 ? (
          <PickerField
            label={isTh ? "提号负责人" : isDg ? "代挂负责人" : "回收负责人"}
            value={values.business_responsible_id}
            searchable
            allowClear
            options={employees.map((item) => ({ value: String(item.id), label: item.display_name || item.username }))}
            onChange={(next) => set("business_responsible_id", next)}
            placeholder="可选填"
          />
        ) : null}

        <Field label={meta("game_account_note", "账号备注").label}>
          <TextInput
            value={values.game_account_note}
            onChange={(next) => set("game_account_note", next)}
            placeholder="可选填"
          />
        </Field>

        <CustomFields
          fields={customFields.filter((field) => (field.section ?? "EXTRA") === "ACCOUNT_PRODUCT")}
          values={custom}
          errors={errors}
          onChange={(key, value) => setCustom((prev) => ({ ...prev, [key]: value }))}
        />
      </FormSection>

      {kind !== "DG" ? (
        <FormSection
          title={sectionLabels.FINANCE ?? "资金明细"}
          description={isTh ? "账号号价、预计收款与附加费用" : "回收价与附加费用"}
          action={
            <button
              type="button"
              className="h5-formsection__addrow"
              onClick={() => setExtraRows((prev) => [...prev, { amount: "", poolId: "", note: "" }])}
            >
              + 支出
            </button>
          }
        >
          {isRecovery ? (
            <Field
              label={meta("recovery_price", "账号号价", true).label}
              required
              error={errors.recovery_price}
              aside={`合计成本 ¥${totalCost}`}
            >
              <MoneyInput value={values.recovery_price} onChange={(next) => set("recovery_price", next)} />
            </Field>
          ) : (
            <>
              <Field label={meta("th_purchase_amount", "账号号价", true).label} required error={errors.th_purchase_amount}>
                <MoneyInput value={values.th_purchase_amount} onChange={(next) => set("th_purchase_amount", next)} />
              </Field>
              <Field label={meta("th_receive_amount", "预计收买家", true).label} required error={errors.th_receive_amount}>
                <MoneyInput value={values.th_receive_amount} onChange={(next) => set("th_receive_amount", next)} />
              </Field>
            </>
          )}

          <PickerField
            label="资金账户"
            required
            value={values.payment_pool_id}
            options={pools.map((pool) => ({ value: String(pool.id), label: `${pool.name}（${pool.code}）` }))}
            onChange={(next) => set("payment_pool_id", next)}
            placeholder="请选择资金账户"
            error={errors.payment_pool_id}
            hint="建单即登记买入流水，必须指定出账账户"
          />

          <Field label="中介费">
            <MoneyInput value={values.intermediary_fee} onChange={(next) => set("intermediary_fee", next)} />
          </Field>
          {Number(values.intermediary_fee) > 0 ? (
            <PickerField
              label="中介费出账账户"
              value={values.intermediary_pool_id}
              options={pools.map((pool) => ({ value: String(pool.id), label: `${pool.name}（${pool.code}）` }))}
              onChange={(next) => set("intermediary_pool_id", next)}
              placeholder="默认与资金账户相同"
            />
          ) : null}

          {extraRows.map((row, index) => (
            <div className="h5-repeatrow" key={`extra-${index}`}>
              <div className="h5-repeatrow__head">
                <span>附加支出 {index + 1}</span>
                <button
                  type="button"
                  className="h5-repeatrow__remove"
                  onClick={() => setExtraRows((prev) => prev.filter((_, i) => i !== index))}
                >
                  删除
                </button>
              </div>
              <Field label="金额" required error={errors[`extra.${index}.amount`]}>
                <MoneyInput
                  value={row.amount}
                  onChange={(next) =>
                    setExtraRows((prev) => prev.map((item, i) => (i === index ? { ...item, amount: next } : item)))
                  }
                />
              </Field>
              <PickerField
                label="资金账户"
                required
                value={row.poolId}
                options={pools.map((pool) => ({ value: String(pool.id), label: `${pool.name}（${pool.code}）` }))}
                onChange={(next) =>
                  setExtraRows((prev) => prev.map((item, i) => (i === index ? { ...item, poolId: next } : item)))
                }
                placeholder="默认与资金账户相同"
                error={errors[`extra.${index}.poolId`]}
              />
              <Field label="支出备注">
                <TextInput
                  value={row.note}
                  onChange={(next) =>
                    setExtraRows((prev) => prev.map((item, i) => (i === index ? { ...item, note: next } : item)))
                  }
                  placeholder="可选填"
                />
              </Field>
            </div>
          ))}

          <CustomFields
            fields={customFields.filter((field) => (field.section ?? "EXTRA") === "FINANCE")}
            values={custom}
            errors={errors}
            onChange={(key, value) => setCustom((prev) => ({ ...prev, [key]: value }))}
          />
        </FormSection>
      ) : null}

      {isRecovery ? (
        <FormSection title={sectionLabels.PARTICIPANT ?? "客户信息"} description="客户按昵称 + 手机/微信自动去重">
          <Field label="客户昵称" required error={errors.customer_nickname}>
            <TextInput
              value={values.customer_nickname}
              onChange={(next) => set("customer_nickname", next)}
              placeholder="请输入客户昵称"
            />
          </Field>
          <Field label="姓名">
            <TextInput
              value={values.customer_contact_name}
              onChange={(next) => set("customer_contact_name", next)}
              placeholder="可选填"
            />
          </Field>
          <Field label="手机号">
            <TextInput
              value={values.customer_phone}
              onChange={(next) => set("customer_phone", next)}
              inputMode="tel"
              placeholder="可选填"
            />
          </Field>
          <Field label="微信号">
            <TextInput
              value={values.customer_wechat}
              onChange={(next) => set("customer_wechat", next)}
              placeholder="可选填"
            />
          </Field>
          <Field label="QQ">
            <TextInput value={values.customer_qq} onChange={(next) => set("customer_qq", next)} placeholder="可选填" />
          </Field>
          <PickerField
            label="客户来源"
            value={values.customer_source}
            options={sourceOptions.length ? sourceOptions : CUSTOMER_SOURCE_FALLBACK}
            onChange={(next) => {
              set("customer_source", next);
              if (next !== "其他") set("customer_source_other", "");
            }}
            placeholder="请选择客户来源"
            allowClear
          />
          {values.customer_source === "其他" ? (
            <Field label="其他来源" required error={errors.customer_source_other}>
              <TextInput
                value={values.customer_source_other}
                onChange={(next) => set("customer_source_other", next)}
                placeholder="请输入来源名称"
              />
            </Field>
          ) : null}
          <Field label="客户备注">
            <TextArea value={values.note} onChange={(next) => set("note", next)} placeholder="可选填" rows={2} />
          </Field>
          <CustomFields
            fields={customFields.filter((field) => (field.section ?? "EXTRA") === "PARTICIPANT")}
            values={custom}
            errors={errors}
            onChange={(key, value) => setCustom((prev) => ({ ...prev, [key]: value }))}
          />
        </FormSection>
      ) : null}

      {isTh ? (
        <FormSection title={sectionLabels.PARTICIPANT ?? "供货方信息"} description="供货方按同行（PEER）建档">
          <Field label="供货方昵称" required error={errors.supplier_nickname}>
            <TextInput
              value={values.supplier_nickname}
              onChange={(next) => set("supplier_nickname", next)}
              placeholder="请输入供货方昵称"
            />
          </Field>
          <PickerField
            label="供货方来源"
            required
            value={values.supplier_source}
            options={supplierSourceOptions.length ? supplierSourceOptions : SUPPLIER_SOURCE_FALLBACK}
            onChange={(next) => {
              set("supplier_source", next);
              if (next !== "其他") set("supplier_source_other", "");
            }}
            placeholder="请选择供货方来源"
            error={errors.supplier_source}
          />
          {values.supplier_source === "其他" ? (
            <Field label="其他来源" required error={errors.supplier_source_other}>
              <TextInput
                value={values.supplier_source_other}
                onChange={(next) => set("supplier_source_other", next)}
                placeholder="请输入来源名称"
              />
            </Field>
          ) : null}
          <Field label="公司名">
            <TextInput
              value={values.supplier_contact_name}
              onChange={(next) => set("supplier_contact_name", next)}
              placeholder="可选填"
            />
          </Field>
          <Field label="手机号">
            <TextInput
              value={values.supplier_phone}
              onChange={(next) => set("supplier_phone", next)}
              inputMode="tel"
              placeholder="可选填"
            />
          </Field>
          <Field label="微信号">
            <TextInput
              value={values.supplier_wechat}
              onChange={(next) => set("supplier_wechat", next)}
              placeholder="可选填"
            />
          </Field>
          <Field label="供货方备注">
            <TextArea
              value={values.supplier_note}
              onChange={(next) => set("supplier_note", next)}
              placeholder="可选填"
              rows={2}
            />
          </Field>
        </FormSection>
      ) : null}

      {isDg ? (
        <FormSection title={sectionLabels.PARTICIPANT ?? "委托客户"}>
          <Field label="客户昵称" required error={errors.dg_customer_nickname}>
            <TextInput
              value={values.dg_customer_nickname}
              onChange={(next) => set("dg_customer_nickname", next)}
              placeholder="请输入客户昵称"
            />
          </Field>
          <Field label="姓名">
            <TextInput
              value={values.dg_customer_contact}
              onChange={(next) => set("dg_customer_contact", next)}
              placeholder="可选填"
            />
          </Field>
          <Field label="手机号">
            <TextInput
              value={values.dg_customer_phone}
              onChange={(next) => set("dg_customer_phone", next)}
              inputMode="tel"
              placeholder="可选填"
            />
          </Field>
          <Field label="微信号">
            <TextInput
              value={values.dg_customer_wechat}
              onChange={(next) => set("dg_customer_wechat", next)}
              placeholder="可选填"
            />
          </Field>
          <Field label="QQ">
            <TextInput
              value={values.dg_customer_qq}
              onChange={(next) => set("dg_customer_qq", next)}
              placeholder="可选填"
            />
          </Field>
          <PickerField
            label="客户来源"
            value={values.dg_customer_source}
            options={sourceOptions.length ? sourceOptions : CUSTOMER_SOURCE_FALLBACK}
            onChange={(next) => {
              set("dg_customer_source", next);
              if (next !== "其他") set("dg_customer_source_other", "");
            }}
            placeholder="请选择客户来源"
            allowClear
          />
          {values.dg_customer_source === "其他" ? (
            <Field label="其他来源" required error={errors.dg_customer_source_other}>
              <TextInput
                value={values.dg_customer_source_other}
                onChange={(next) => set("dg_customer_source_other", next)}
                placeholder="请输入来源名称"
              />
            </Field>
          ) : null}
          <Field label="代挂备注">
            <TextArea value={values.dg_note} onChange={(next) => set("dg_note", next)} placeholder="可选填" rows={2} />
          </Field>
          <CustomFields
            fields={customFields.filter((field) => (field.section ?? "EXTRA") === "PARTICIPANT")}
            values={custom}
            errors={errors}
            onChange={(key, value) => setCustom((prev) => ({ ...prev, [key]: value }))}
          />
        </FormSection>
      ) : null}

      <FormSection title={sectionLabels.DELIVER ?? "交付信息"} description="建单时已知的交接条件，实际交付在订单详情登记">
        <Field label={meta("bound_phone", "换绑手机号").label}>
          <TextInput
            value={values.bound_phone}
            onChange={(next) => set("bound_phone", next)}
            inputMode="tel"
            placeholder="可选填"
          />
        </Field>
        <Field label={meta("bound_phone_owner", "手机号绑定人").label}>
          <TextInput
            value={values.bound_phone_owner}
            onChange={(next) => set("bound_phone_owner", next)}
            placeholder="可选填"
          />
        </Field>
        {kind !== "DG" ? (
          <>
            <PickerField
              label={meta("intermediary_platform", "交易平台").label}
              value={values.intermediary_platform}
              options={platformOptions}
              onChange={(next) => set("intermediary_platform", next)}
              placeholder="可选填"
              allowClear
            />
            <PickerField
              label={meta("intermediary_type", "中介类型").label}
              value={values.intermediary_type}
              options={intermediaryTypeOptions}
              onChange={(next) => {
                set("intermediary_type", next);
                if (next !== "包赔") set("compensation_type", "");
              }}
              placeholder="可选填"
              allowClear
            />
            <PickerField
              label={meta("compensation_type", "包赔类型").label}
              value={values.compensation_type}
              options={compensationOptions}
              onChange={(next) => set("compensation_type", next)}
              placeholder={values.intermediary_type === "包赔" ? "请选择" : "选择包赔后可选"}
              disabled={values.intermediary_type !== "包赔"}
            />
          </>
        ) : null}
        {employees.length > 0 ? (
          <PickerField
            label="交付负责人"
            value={values.delivery_responsible_id}
            searchable
            allowClear
            options={employees.map((item) => ({ value: String(item.id), label: item.display_name || item.username }))}
            onChange={(next) => set("delivery_responsible_id", next)}
            placeholder="可选填"
          />
        ) : null}
        <CustomFields
          fields={customFields.filter((field) => (field.section ?? "EXTRA") === "DELIVER")}
          values={custom}
          errors={errors}
          onChange={(key, value) => setCustom((prev) => ({ ...prev, [key]: value }))}
        />
      </FormSection>

      {customSections
        .filter(([section]) => !["ACCOUNT_PRODUCT", "FINANCE", "PARTICIPANT", "DELIVER"].includes(section))
        .map(([section, list]) => (
          <FormSection key={section} title={sectionLabels[section] ?? SECTION_TITLE[section] ?? "补充信息"}>
            <CustomFields
              fields={list}
              values={custom}
              errors={errors}
              onChange={(key, value) => setCustom((prev) => ({ ...prev, [key]: value }))}
            />
          </FormSection>
        ))}

      <p className="h5-footnote">
        提交后订单号由系统按 {kind} 前缀生成，不可修改；客户与供货方档案会自动去重。
      </p>

      <ConfirmSheet
        open={Boolean(repurchase)}
        title="该账号已售出过"
        description={`账号「${repurchase ?? ""}」历史上已售出。确认按「复购回流」继续建单？`}
        okText="是，继续建单"
        cancelText="返回修改"
        busy={busy}
        onConfirm={() => void submit(true)}
        onCancel={() => setRepurchase(null)}
      />
    </FormPage>
  );
}

/** 条件必填判定：与桌面端 `isConditionActive` 同语义。 */
function conditionHit(
  condition: { field: string; op: "eq" | "ne" | "filled"; values?: string[] },
  values: Record<string, unknown>,
): boolean {
  const raw = values[condition.field];
  if (condition.op === "filled") {
    return raw !== undefined && raw !== null && String(raw).trim() !== "";
  }
  const triggers = condition.values ?? [];
  const current = (Array.isArray(raw) ? raw : [raw]).map((item) => String(item ?? ""));
  const hit = current.some((item) => triggers.includes(item));
  return condition.op === "ne" ? !hit : hit;
}

/** 「其他」联动：选了「其他」时用自填值，否则用选项值。 */
function resolveOther(selected: string, other: string): string | null {
  if (!selected) return null;
  return selected === "其他" ? (other || null) : selected;
}

/** 自定义字段渲染：按 field_type 分派，值统一挂在 form_extra / extra_values。 */
function CustomFields(props: {
  fields: FormFieldRow[];
  values: Record<string, string>;
  errors: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  if (props.fields.length === 0) return null;
  return (
    <>
      {props.fields.map((field) => {
        const error = props.errors[`custom.${field.field_key}`];
        const required = field.required || Boolean(field.required_when);
        const value = props.values[field.field_key] ?? "";
        const options = field.options ?? [];
        if (field.field_type === "BOOLEAN") {
          return (
            <ChipField
              key={field.id}
              label={field.label}
              value={value || "否"}
              options={[
                { value: "否", label: "否" },
                { value: "是", label: "是" },
              ]}
              onChange={(next) => props.onChange(field.field_key, next === "是" ? "true" : "")}
              error={error}
            />
          );
        }
        if (field.field_type === "DATE") {
          return (
            <Field key={field.id} label={field.label} required={required} error={error}>
              <DateInput value={value} onChange={(next) => props.onChange(field.field_key, next)} />
            </Field>
          );
        }
        if ((field.field_type === "SELECT" || field.field_type === "MULTI_SELECT") && options.length) {
          return (
            <PickerField
              key={field.id}
              label={field.label}
              required={required}
              value={value}
              options={options}
              onChange={(next) => props.onChange(field.field_key, next)}
              error={error}
              allowClear
            />
          );
        }
        if (field.field_type === "NUMBER" || field.field_type === "MONEY") {
          return (
            <Field key={field.id} label={field.label} required={required} error={error}>
              <MoneyInput value={value} onChange={(next) => props.onChange(field.field_key, next)} />
            </Field>
          );
        }
        return (
          <Field key={field.id} label={field.label} required={required} error={error} hint={field.note ?? undefined}>
            <TextInput value={value} onChange={(next) => props.onChange(field.field_key, next)} />
          </Field>
        );
      })}
    </>
  );
}
