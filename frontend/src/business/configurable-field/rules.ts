/** 配置驱动的标签 / 必填 / 条件校验规则；拆分自 ConfigurableField.tsx。 */
import { Form } from "antd";
import type { Rule } from "antd/es/form";
import type { RequiredWhen } from "../../shared/api/types/forms";
import { fieldConfigFor, useFieldConfig } from "./context";
import type { FieldConfigMap } from "./context";

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
  const current = (Array.isArray(raw) ? raw : [raw]).map((item) => String(item ?? ""));
  const hit = current.some((item) => triggers.includes(item));
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
  // 金额类字段（NUMBER/MONEY）在「必填」语义下不允许为 0 / 负数；排序允许 0。
  // 选填（含条件必填未命中）时本规则不挂载，留空传 0 由后端按选填口径放行。
  const isMoney = def.field_type === "MONEY" || (def.field_type === "NUMBER" && def.field_key !== "sort_order");
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

/** 条件可以依赖普通字段，也可以依赖 form_extra 中的自定义字段。 */
export function useConditionFieldValue(condField: string | undefined): unknown {
  const form = Form.useFormInstance();
  const field = condField ?? "__no_required_when__";
  const directValue = Form.useWatch(field, form);
  const customValue = Form.useWatch(["form_extra", field], form);
  return directValue === undefined ? customValue : directValue;
}

/** 订阅条件依赖字段的当前值；无条件时不订阅（用占位键，antd useWatch 对未知字段返回 undefined）。 */
export function useConditionValues(cfg: FieldConfigMap, key: string): Record<string, unknown> | undefined {
  const condField = fieldConfigFor(cfg, key)?.required_when?.field;
  const depValue = useConditionFieldValue(condField);
  return condField ? { [condField]: depValue } : undefined;
}
