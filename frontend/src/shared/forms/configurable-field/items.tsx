/** 受配置驱动的 Form.Item 与 BusinessRegistrationField 布局项；拆分自 ConfigurableField.tsx。 */
import { Form, Radio } from "antd";
import type { FormItemProps, Rule } from "antd/es/form";
import { Children, cloneElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { BusinessRegistrationField, Select } from "../../ui";
import type { OrderFormField } from "../../api/types/forms";
import { fieldConfigFor, useFieldConfig } from "./context";
import type { FieldConfigMap } from "./context";
import { isFieldActive, fieldLabel, resolveRules, useConditionValues } from "./rules";
import { resolveOptionItems } from "./custom-fields";

export function CfgItem(props: {
  cfg?: FieldConfigMap;
  name: string;
  label?: string;
  /** 卡片式标题字段（如「账号号价」由外部卡片 div 展示）不渲染 antd 自带 label。 */
  hideLabel?: boolean;
  /** 核心业务字段即使被旧配置误停用也必须保留，避免表单出现只有标题没有输入控件。 */
  alwaysActive?: boolean;
  /** 后端固定要求的字段不允许被历史配置改成选填。 */
  alwaysRequired?: boolean;
  rules?: Rule[];
  valuePropName?: string;
  tooltip?: ReactNode;
  /** 固定展示名称：字段键与配置仍保留，避免历史配置的旧文案影响统一业务术语。 */
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
  const resolvedRules = resolveRules(cfg, props.name, props.rules, condValues);
  const baseRequired = (props.rules ?? []).filter((rule) => Boolean((rule as { required?: boolean }).required));
  const rules = props.alwaysRequired && !resolvedRules.some((rule) => Boolean((rule as { required?: boolean }).required))
    ? [...resolvedRules, ...(baseRequired.length ? baseRequired : [{ required: true } as Rule])]
    : resolvedRules;
  return (
    <Form.Item
      name={props.name}
      label={props.hideLabel ? undefined : props.fixedLabel ?? fieldLabel(cfg, props.name, props.label ?? "")}
      rules={rules}
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

/** 为 Form.List 等自己管理字段名的组合控件提供配置驱动的显示与标签。 */
export function CfgGroup(props: { name: string; label: string; children: ReactNode }): ReactElement | null {
  const cfg = useFieldConfig();
  if (!isFieldActive(cfg, props.name)) return null;
  return <Form.Item label={fieldLabel(cfg, props.name, props.label)}>{props.children}</Form.Item>;
}

/** 若 children 内的 Select / Select 未显式传 options，且字段配置带有选项集，则注入。
 *  动态数据源下拉（options 由 pools.map 等运行时计算）因显式传了 options 不会被覆盖。 */
export function injectOptionsIfMissing(
  children: ReactNode,
  def?: OrderFormField,
): ReactNode {
  const items = def ? resolveOptionItems(def.options) : [];
  const mapped = Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const childProps = child.props as { options?: unknown };
    // 共享 Select 与 Radio.Group 均接受 options 数组；动态数据源因显式传 options 不被覆盖。
    const isOptionControl = child.type === Select || child.type === Radio.Group;
    if (items.length > 0 && isOptionControl && childProps.options === undefined) {
      return cloneElement(child as ReactElement, { options: items } as never);
    }
    return child;
  });
  // Form.Item(name) 必须接收单一控件。JSX 中控件前后的格式空白也可能被保留为
  // 非元素 child；按可渲染元素归一化，保证单控件场景还原为元素本身。
  const elements = Children.toArray(mapped).filter(isValidElement);
  return elements.length === 1 ? elements[0] : mapped;
}

/** 受配置驱动的 BusinessRegistrationField 布局项（name 在内层 Form.Item，如「联系方式」网格内的子字段）。 */
export function CfgNestedItem(props: {
  cfg?: FieldConfigMap;
  name: string;
  /** 无配置时的兜底名称；统一术语字段应改用 fixedLabel。 */
  label?: string;
  /** 固定展示名称：字段键与配置仍保留，避免历史配置的旧文案影响统一业务术语。 */
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
  return (
    <BusinessRegistrationField className={props.className} label={props.fixedLabel ?? fieldLabel(cfg, props.name, props.label ?? "")} required={resolvedRules.some((rule) => Boolean((rule as { required?: boolean }).required))}>
      <Form.Item
        noStyle={props.noStyle ?? true}
        name={props.name}
        rules={resolvedRules}
        initialValue={props.initialValue}
      >
        {injectOptionsIfMissing(props.children, fieldConfigFor(cfg, props.name))}
      </Form.Item>
    </BusinessRegistrationField>
  );
}
