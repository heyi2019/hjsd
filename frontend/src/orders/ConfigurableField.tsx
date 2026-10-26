/** 建单表单字段配置驱动：拉取某业务类型的 OrderFormField 配置，并提供
 *  - FieldConfigContext / useFieldConfig：CreateBusinessModal 把配置注入此 context，各 Section 默认从此读取
 *  - CfgItem：受配置驱动的 Form.Item（停用字段不渲染、必填/标签从配置读）
 *  - CfgNestedItem：同上，但渲染在 NestedFormField 布局内（name 在内层 Form.Item）
 *  - CustomFormField：渲染用户自定义字段（值归集到 form_extra.<field_key>）
 *  降级策略：配置未加载或某字段无配置时，视为「启用 + 使用原硬编码必填/标签」，
 *  保证既有表单在无配置或接口异常时与现状一致。
 */
import { DatePicker, Form, Input, InputNumber, Radio, Select, Switch } from "antd";
import { Select as UiSelect } from "../shared/ui";
import type { ReactElement, ReactNode } from "react";
import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useState } from "react";
import type { Rule } from "antd/es/form";
import { NestedFormField } from "../shared/ui";
import { orderFormFieldsApi, type OrderFormField } from "../shared/api/catalog";

export type FieldConfigMap = Record<string, OrderFormField>;

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

/** 配置上下文：CreateBusinessModal 注入当前业务类型的字段配置，各 Section 默认从此读取。 */
export const FieldConfigContext = createContext<FieldConfigMap>({});

export function useFieldConfig(): FieldConfigMap {
  return useContext(FieldConfigContext);
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
  return <FieldConfigContext.Provider value={config}>{props.children}</FieldConfigContext.Provider>;
}

export function isFieldActive(config: FieldConfigMap, key: string): boolean {
  const def = config[key];
  return def ? def.is_active : true;
}

export function fieldLabel(config: FieldConfigMap, key: string, fallback: string): string {
  return config[key]?.label ?? fallback;
}

/** 合并必填（必填下限语义）：
 *  - 配置 required=true → 强制必填（保留基础与条件校验规则）；
 *  - 配置 required=false → 保留基础规则（含条件必填，如「其他来源」），不强行剥离；
 *  - 无配置 → 原 rules。
 * 这样种子默认值与表单当前必填态一致时开启功能零行为变化，用户改配置后才生效。
 */
export function resolveRules(config: FieldConfigMap, key: string, baseRules?: Rule[]): Rule[] {
  const def = config[key];
  const base = (baseRules ?? []).filter(Boolean) as Rule[];
  if (!def) return base;
  if (def.required) {
    const hasRequired = base.some((rule) => rule && (rule as { required?: boolean }).required);
    return hasRequired ? base : [...base, { required: true, message: `${def.label}必填` } as Rule];
  }
  return base;
}

export function CfgItem(props: {
  cfg?: FieldConfigMap;
  name: string;
  label?: string;
  /** 卡片式标题字段（如「账号号价」由外部卡片 div 展示）不渲染 antd 自带 label。 */
  hideLabel?: boolean;
  rules?: Rule[];
  valuePropName?: string;
  tooltip?: ReactNode;
  /** 字段下方的补充说明文案（antd Form.Item.extra）。 */
  extra?: ReactNode;
  /** 字段下方的校验/提示信息（antd Form.Item.help）。 */
  help?: ReactNode;
  className?: string;
  initialValue?: unknown;
  children: ReactNode;
}): ReactElement | null {
  const cfg = props.cfg ?? useFieldConfig();
  if (!isFieldActive(cfg, props.name)) return null;
  return (
    <Form.Item
      name={props.name}
      label={props.hideLabel ? undefined : fieldLabel(cfg, props.name, props.label ?? "")}
      rules={resolveRules(cfg, props.name, props.rules)}
      valuePropName={props.valuePropName}
      tooltip={props.tooltip}
      extra={props.extra}
      help={props.help}
      className={props.className}
      initialValue={props.initialValue}
    >
      {injectOptionsIfMissing(props.children, cfg[props.name])}
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
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const childProps = child.props as { options?: unknown };
    // 同时兼容 antd Select、shared/ui 的 Select 封装（forwardRef 封装组件，类型与裸 antd Select 不同）、
    // 以及 Radio.Group（三者均接受 options 数组）；动态数据源因显式传 options 不被覆盖。
    const isOptionControl =
      child.type === Select || child.type === UiSelect || child.type === Radio.Group;
    if (isOptionControl && childProps.options === undefined) {
      return cloneElement(child as ReactElement, { options: items } as never);
    }
    return child;
  });
}

/** 受配置驱动的 NestedFormField 布局项（name 在内层 Form.Item，如「联系方式」网格内的子字段）。 */
export function CfgNestedItem(props: {
  cfg?: FieldConfigMap;
  name: string;
  label: string;
  rules?: Rule[];
  initialValue?: unknown;
  className?: string;
  children: ReactNode;
}): ReactElement | null {
  const cfg = props.cfg ?? useFieldConfig();
  if (!isFieldActive(cfg, props.name)) return null;
  return (
    <NestedFormField className={props.className} label={fieldLabel(cfg, props.name, props.label)}>
      <Form.Item
        noStyle
        name={props.name}
        rules={resolveRules(cfg, props.name, props.rules)}
        initialValue={props.initialValue}
      >
        {injectOptionsIfMissing(props.children, cfg[props.name])}
      </Form.Item>
    </NestedFormField>
  );
}

/** 解析配置选项：兼容纯字符串数组（value=label）与 {value,label} 对象数组。 */
export function resolveOptionItems(
  options: Array<string | { value: string; label: string }> | null | undefined,
): Array<{ value: string; label: string }> {
  return (options ?? []).map((item) =>
    typeof item === "string" ? { value: item, label: item } : { value: item.value, label: item.label },
  );
}

/** 渲染用户自定义字段；值通过 name=['form_extra', field_key] 归集到 form_extra 对象。 */
export function CustomFormField({ def }: { def: OrderFormField }): ReactElement {
  const name = ["form_extra", def.field_key] as [string, string];
  const rules = def.required ? [{ required: true, message: `${def.label}必填` }] : [];
  const options = resolveOptionItems(def.options);
  switch (def.field_type) {
    case "NUMBER":
      return (
        <Form.Item name={name} label={def.label} rules={rules}>
          <InputNumber style={{ width: "100%" }} />
        </Form.Item>
      );
    case "DATE":
      return (
        <Form.Item name={name} label={def.label} rules={rules}>
          <DatePicker style={{ width: "100%" }} />
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
