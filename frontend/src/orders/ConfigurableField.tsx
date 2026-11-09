/** 建单表单字段配置驱动：拉取某业务类型的 OrderFormField 配置，并提供
 *  - FieldConfigContext / useFieldConfig：CreateBusinessModal 把配置注入此 context，各 Section 默认从此读取
 *  - CfgItem：受配置驱动的 Form.Item（停用字段不渲染、必填/标签从配置读）
 *  - CfgNestedItem：同上，但渲染在 BusinessRegistrationField 布局内（name 在内层 Form.Item）
 *  - CustomFormField：渲染用户自定义字段（值归集到 form_extra.<field_key>）
 *  降级策略：配置未加载或某字段无配置时，视为「启用 + 使用原硬编码必填/标签」，
 *  保证既有表单在无配置或接口异常时与现状一致。
 */
import { DatePicker, Form, Input, InputNumber, Radio, Switch, Typography, type FormItemProps } from "antd";
import { BusinessRegistrationField, Select } from "../shared/ui";
import type { ReactElement, ReactNode } from "react";
import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useState } from "react";
import type { Rule } from "antd/es/form";
import { orderFormFieldsApi, type OrderFormField, type RequiredWhen } from "../shared/api/catalog";

export type FieldConfigMap = Record<string, OrderFormField>;

const CUSTOM_SECTION_LABEL: Record<NonNullable<OrderFormField["section"]>, string> = {
  ACCOUNT_PRODUCT: "账号 / 产品补充信息",
  BUSINESS: "业务方案补充信息",
  DELIVER: "交付补充信息",
  OPERATION: "运营信息",
  FINANCE: "费用与资金补充信息",
  PARTICIPANT: "客户 / 合作伙伴补充信息",
  EXTRA: "其他补充信息",
};
function fieldConfigFor(config: FieldConfigMap, key: string): OrderFormField | undefined {
  return config[key];
}

export function useOrderFormConfig(orderType: string | undefined): {
  config: FieldConfigMap;
  loading: boolean;
} {
  const [config, setConfig] = useState<FieldConfigMap>({});
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!orderType) {
      setConfig({});
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    Promise.resolve(orderFormFieldsApi.list(orderType, true))
      .then((rows) => {
        if (cancelled) return;
        const map: FieldConfigMap = {};
        for (const row of rows ?? []) map[row.field_key] = row;
        setConfig(map);
      })
      .catch(() => {
        if (!cancelled) setConfig({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderType]);
  return { config, loading };
}

/** 按业务类型拉取板块标题覆盖映射（section_key -> 显示标题）。
 *  仅在 orderType 有效时请求；无配置或请求失败时降级为空映射，各板块保持原硬编码标题。 */
export function useOrderFormSectionLabels(orderType: string | undefined): {
  labels: Record<string, string>;
  loading: boolean;
} {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!orderType) {
      setLabels({});
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    Promise.resolve(orderFormFieldsApi.listSectionLabels(orderType))
      .then((rows) => {
        if (cancelled) return;
        setLabels(rows ?? {});
      })
      .catch(() => {
        if (!cancelled) setLabels({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderType]);
  return { labels, loading };
}

/** 配置上下文：CreateBusinessModal 注入当前业务类型的字段配置，各 Section 默认从此读取。 */
export const FieldConfigContext = createContext<FieldConfigMap>({});

export function useFieldConfig(): FieldConfigMap {
  return useContext(FieldConfigContext);
}

/** 板块标题配置上下文：CreateBusinessModal / FieldConfigScope 把当前业务类型的板块标题映射注入此处，
 * 各 Section 的硬编码标题改用 ``sectionLabel(key, fallback)`` 读取，实现「设置里改板块名 → 建单同步显示」。 */
export const SectionLabelsContext = createContext<Record<string, string>>({});

export function useSectionLabels(): Record<string, string> {
  return useContext(SectionLabelsContext);
}

/** 读取板块显示标题：优先用配置覆盖值，无配置时回退硬编码 fallback（与 fieldLabel 同机制）。 */
export function sectionLabel(key: string, fallback: string): string {
  const labels = useSectionLabels();
  return labels[key] ?? fallback;
}

/** 按「表单作用域」按需拉取配置并注入上下文。
 *  仅在 active 为 true 时请求，避免多弹窗面板挂载时一次性拉取全部作用域配置；
 *  无配置或请求失败时降级为空配置，各字段保持原硬编码标签/必填态。 */
export function FieldConfigScope(props: {
  scope: string;
  active: boolean;
  children: ReactNode;
}): ReactElement {
  const { config } = useOrderFormConfig(props.active ? props.scope : undefined);
  const { labels } = useOrderFormSectionLabels(props.active ? props.scope : undefined);
  return (
    <FieldConfigContext.Provider value={config}>
      <SectionLabelsContext.Provider value={labels}>{props.children}</SectionLabelsContext.Provider>
    </FieldConfigContext.Provider>
  );
}

export function isFieldActive(config: FieldConfigMap, key: string): boolean {
  const def = fieldConfigFor(config, key);
  return def ? def.is_active : true;
}

export function fieldLabel(config: FieldConfigMap, key: string, fallback: string): string {
  return fieldConfigFor(config, key)?.label ?? fallback;
}

/** 判断条件必填是否命中：values 为当前表单值（至少含依赖字段）。
 *  - filled：依赖字段有值（数组非空 / 非空字符串 / 非 null）→ 命中；
 *  - eq：依赖字段值属于触发值 → 命中；
 *  - ne：依赖字段值不属于触发值 → 命中。
 *  依赖值可能来自多选（数组），按任一值命中处理。
 */
export function isConditionActive(
  cond: RequiredWhen | null | undefined,
  values?: Record<string, unknown>,
): boolean {
  if (!cond) return false;
  const raw = values?.[cond.field];
  if (cond.op === "filled") {
    if (Array.isArray(raw)) return raw.length > 0;
    return raw !== undefined && raw !== null && String(raw).trim() !== "";
  }
  const triggers = cond.values ?? [];
  const triggerSet = new Set(triggers);
  const current = (Array.isArray(raw) ? raw : [raw]).map((item) => String(item ?? ""));
  const hit = current.some((item) => triggerSet.has(item));
  return cond.op === "ne" ? !hit : hit;
}

/** 合并必填（配置为最终口径）：
 *  - 配置条件必填（required_when 非空）→ 条件命中时必填，否则选填（剥离基础规则中的必填项）；
 *  - 配置 required=true → 强制必填（保留基础与条件校验规则，基础无必填时追加）；
 *  - 配置 required=false 且无条件 → 剥离基础规则中的必填项（保留金额格式等校验器），即纯选填；
 *  - 无配置 → 原 rules（降级保持既有行为）。
 */
export function resolveRules(
  config: FieldConfigMap,
  key: string,
  baseRules?: Rule[],
  values?: Record<string, unknown>,
): Rule[] {
  const def = fieldConfigFor(config, key);
  const base = (baseRules ?? []).filter(Boolean) as Rule[];
  if (!def) return base;
  // 金额类字段（NUMBER/MONEY）在「必填」语义下不允许为 0 / 负数：
  // 选填（含条件必填未命中）时本规则不挂载，留空传 0 由后端按选填口径放行。
  const isMoney = def.field_type === "NUMBER" || def.field_type === "MONEY";
  const moneyPositiveRule: Rule = {
    validator(_rule, value) {
      if (value === undefined || value === null || value === "") return Promise.resolve();
      const n = typeof value === "number" ? value : Number(value);
      if (Number.isNaN(n)) return Promise.resolve();
      return n > 0 ? Promise.resolve() : Promise.reject(new Error(`${def.label}必须大于 0`));
    },
  };
  if (def.required) {
    const hasRequired = base.some((rule) => rule && (rule as { required?: boolean }).required);
    const rules = hasRequired ? [...base] : [...base, { required: true, message: `${def.label}必填` } as Rule];
    if (isMoney) rules.push(moneyPositiveRule);
    return rules;
  }
  const stripped = base.filter((rule) => !(rule as { required?: boolean }).required);
  if (def.required_when) {
    if (isConditionActive(def.required_when, values)) {
      const rules = [...stripped, { required: true, message: `${def.label}必填` } as Rule];
      if (isMoney) rules.push(moneyPositiveRule);
      return rules;
    }
    return stripped;
  }
  return stripped;
}

/** 订阅条件依赖字段的当前值；无条件时不订阅（用占位键，antd useWatch 对未知字段返回 undefined）。 */
function useConditionValues(cfg: FieldConfigMap, key: string): Record<string, unknown> | undefined {
  const form = Form.useFormInstance();
  const condField = fieldConfigFor(cfg, key)?.required_when?.field;
  const depValue = Form.useWatch(condField ?? "__no_required_when__", form);
  return condField ? { [condField]: depValue } : undefined;
}

export function CfgItem(props: {
  cfg?: FieldConfigMap;
  name: string;
  label?: string;
  /** 卡片式标题字段（如「账号号价」由外部卡片 div 展示）不渲染 antd 自带 label。 */
  hideLabel?: boolean;
  /** 核心业务字段即使被旧配置误停用也必须保留，避免表单出现只有标题没有输入控件。 */
  alwaysActive?: boolean;
  rules?: Rule[];
  valuePropName?: string;
  tooltip?: ReactNode;
  /** 固定展示名称，统一业务术语。 */
  fixedLabel?: string;
  /** 字段下方的补充说明文案（antd Form.Item.extra）。 */
  extra?: ReactNode;
  /** 字段下方的校验/提示信息（antd Form.Item.help）。 */
  help?: ReactNode;
  /** 受控值转换：例如日期控件展示 Dayjs、提交仍保留后端日期字符串。 */
  getValueFromEvent?: FormItemProps["getValueFromEvent"];
  getValueProps?: FormItemProps["getValueProps"];
  className?: string;
  initialValue?: unknown;
  children: ReactNode;
}): ReactElement | null {
  const cfg = props.cfg ?? useFieldConfig();
  const condValues = useConditionValues(cfg, props.name);
  if (!props.alwaysActive && !isFieldActive(cfg, props.name)) return null;
  return (
    <Form.Item
      name={props.name}
      label={props.hideLabel ? undefined : props.fixedLabel ?? fieldLabel(cfg, props.name, props.label ?? "")}
      rules={resolveRules(cfg, props.name, props.rules, condValues)}
      valuePropName={props.valuePropName}
      tooltip={props.tooltip}
      extra={props.extra}
      help={props.help}
      getValueFromEvent={props.getValueFromEvent}
      getValueProps={props.getValueProps}
      className={props.className}
      initialValue={props.initialValue}
    >
      {injectOptionsIfMissing(props.children, fieldConfigFor(cfg, props.name))}
    </Form.Item>
  );
}

/** 若 children 内的 Select / Select 未显式传 options，且字段配置带有选项集，则注入。
 *  动态数据源下拉（options 由 pools.map 等运行时计算）因显式传了 options 不会被覆盖。 */
export function injectOptionsIfMissing(
  children: ReactNode,
  def?: OrderFormField,
): ReactNode {
  if (!def) return children;
  const items = resolveOptionItems(def.options);
  if (items.length === 0) return children;
  const mapped = Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const childProps = child.props as { options?: unknown };
    // 共享 Select 与 Radio.Group 均接受 options 数组；动态数据源因显式传 options 不被覆盖。
    const isOptionControl = child.type === Select || child.type === Radio.Group;
    if (isOptionControl && childProps.options === undefined) {
      return cloneElement(child as ReactElement, { options: items } as never);
    }
    return child;
  });
  // Form.Item(name) 必须接收单一控件。Children.map 即使只有一个 child 也会返回数组，
  // 会让 antd 放弃控件绑定并持续报警；单控件场景还原为元素本身。
  return mapped?.length === 1 ? mapped[0] : mapped;
}

/** 受配置驱动的 BusinessRegistrationField 布局项（name 在内层 Form.Item，如「联系方式」网格内的子字段）。 */
export function CfgNestedItem(props: {
  cfg?: FieldConfigMap;
  name: string;
  /** 无配置时的兜底名称；统一术语字段应改用 fixedLabel。 */
  label?: string;
  /** 固定展示名称，统一业务术语。 */
  fixedLabel?: string;
  rules?: Rule[];
  initialValue?: unknown;
  className?: string;
  /** 保留校验提示时关闭 noStyle；嵌套的紧凑字段默认不额外占位。 */
  noStyle?: boolean;
  children: ReactNode;
}): ReactElement | null {
  const cfg = props.cfg ?? useFieldConfig();
  const condValues = useConditionValues(cfg, props.name);
  const resolvedRules = resolveRules(cfg, props.name, props.rules, condValues);
  if (!isFieldActive(cfg, props.name)) return null;
  const resolvedLabel = props.fixedLabel ?? fieldLabel(cfg, props.name, props.label ?? "");
  const child = injectOptionsIfMissing(props.children, fieldConfigFor(cfg, props.name));
  const labelledChild = Children.map(child, (item) => {
    if (!isValidElement(item)) return item;
    const existing = (item.props as { "aria-label"?: string })["aria-label"];
    return cloneElement(item as ReactElement, { "aria-label": existing ?? resolvedLabel } as never);
  });
  const normalizedChild = labelledChild?.length === 1 ? labelledChild[0] : labelledChild;
  return (
    <BusinessRegistrationField className={props.className} label={resolvedLabel} required={resolvedRules.some((rule) => Boolean((rule as { required?: boolean }).required))}>
      <Form.Item
        noStyle={props.noStyle ?? true}
        name={props.name}
        rules={resolvedRules}
        initialValue={props.initialValue}
      >
        {normalizedChild}
      </Form.Item>
    </BusinessRegistrationField>
  );
}

/** 渲染当前作用域（FieldConfigContext）下的自定义字段区块；无自定义字段时不渲染。
 *  值通过 CustomFormField 归集到 form_extra.<field_key>，随表单提交上报。 */
export function CustomFieldSection(props: { testIdSuffix?: string; section?: OrderFormField["section"] } = {}): ReactElement | null {
  const cfg = useFieldConfig();
  const defs = Object.values(cfg)
    .filter((field) => field.is_custom && field.is_active && (field.section ?? "EXTRA") === (props.section ?? "EXTRA"))
    .sort((a, b) => a.sort_order - b.sort_order);
  if (defs.length === 0) return null;
  return (
    <section className="ui-stack custom-field-section" data-testid={`custom-fields${props.testIdSuffix ? `-${props.testIdSuffix}` : ""}`}>
      <Typography.Text type="secondary" strong>{sectionLabel(props.section ?? "EXTRA", CUSTOM_SECTION_LABEL[props.section ?? "EXTRA"])}</Typography.Text>
      {defs.map((def) => (
        <CustomFormField key={def.id} def={def} />
      ))}
    </section>
  );
}

/** 解析配置选项：后端只返回 {value,label} 对象。 */
export function resolveOptionItems(
  options: Array<{ value: string; label: string }> | null | undefined,
): Array<{ value: string; label: string }> {
  return (options ?? []).map((item) => {
    if (!item || typeof item !== "object" || typeof item.value !== "string" || typeof item.label !== "string") {
      throw new Error("选项必须使用 value/label 对象");
    }
    return item;
  });
}

export type FormExtraStatus = "active" | "inactive" | "deleted";

export type FormExtraDisplayItem = {
  key: string;
  label: string;
  value: unknown;
  status: FormExtraStatus;
};

/** 把 form_extra 原始值展开为展示列表，统一「定义缺失/停用」的兜底口径：
 *  - 有定义：label 取配置名，status 按 is_active 区分 active / inactive；
 *  - 无定义（字段已删除）：label 回退裸 key，status = deleted。
 * 空值（null / "" / 空数组）过滤。客户列表、客户详情、订单详情共用本函数，
 * 确保删除/停用字段的值始终可见且口径一致。 */
export function buildFormExtraDisplay(
  extra: Record<string, unknown> | null | undefined,
  fieldDefs?: Array<Pick<OrderFormField, "field_key" | "label" | "is_active">>,
): FormExtraDisplayItem[] {
  if (!extra) return [];
  const defMap = new Map((fieldDefs ?? []).map((d) => [d.field_key, d]));
  const items: FormExtraDisplayItem[] = [];
  for (const [key, value] of Object.entries(extra)) {
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      continue;
    }
    const def = defMap.get(key);
    items.push({
      key,
      label: def ? def.label : key,
      value,
      status: def ? (def.is_active ? "active" : "inactive") : "deleted",
    });
  }
  return items;
}

/** 扩展字段值的通用格式化。 */
export function formatExtraDisplayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

/** 渲染用户自定义字段；值通过 name=['form_extra', field_key] 归集到 form_extra 对象。 */
export function CustomFormField({ def }: { def: OrderFormField }): ReactElement {
  const name = ["form_extra", def.field_key] as [string, string];
  const condField = def.required_when?.field;
  const depValue = Form.useWatch(condField ?? "__no_required_when__", Form.useFormInstance());
  const required =
    def.required ||
    isConditionActive(def.required_when, condField ? { [condField]: depValue } : undefined);
  const rules = required ? [{ required: true, message: `${def.label}必填` }] : [];
  const options = resolveOptionItems(def.options);
  switch (def.field_type) {
    case "NUMBER":
      return (
        <Form.Item name={name} label={def.label} rules={rules}>
          <InputNumber className="ui-control-full" />
        </Form.Item>
      );
    case "DATE":
      return (
        <Form.Item name={name} label={def.label} rules={rules}>
          <DatePicker className="ui-control-full" />
        </Form.Item>
      );
    case "BOOLEAN":
      return (
        <Form.Item name={name} label={def.label} valuePropName="checked" rules={rules}>
          <Switch />
        </Form.Item>
      );
    case "SELECT":
      return (
        <Form.Item name={name} label={def.label} rules={rules}>
          <Select options={options} allowClear />
        </Form.Item>
      );
    case "MULTI_SELECT":
      return (
        <Form.Item name={name} label={def.label} rules={rules}>
          <Select mode="multiple" options={options} allowClear />
        </Form.Item>
      );
    default:
      return (
        <Form.Item name={name} label={def.label} rules={rules}>
          <Input />
        </Form.Item>
      );
  }
}
