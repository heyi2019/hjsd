/** 表单校验规则：金额与比例。
 *
 * 背景：此前金额字段普遍是 `<Form.Item rules={[{ required: true }]}><Input /></Form.Item>`，
 * 可以填 `abc` / `-100` 直接落账，且 required 没有 message（红框出现但无文字说明）。
 */
import type { Rule } from "antd/es/form";

/** 文本必填规则将纯空白视为未填写；其他类型及选填规则保持不变。 */
export function requiredTextRules(rules: Rule[]): Rule[] {
  return rules.map((rule) => typeof rule === "object" && rule !== null && "required" in rule && rule.required
    ? { ...rule, whitespace: true } : rule);
}

type MoneyRuleOptions = { allowNegative?: boolean; maxIntegerDigits?: number };

/** 金额格式与可选整数位数限制，空值由必填规则处理。 */
export function moneyValidationError(value: string, label = "金额", options?: MoneyRuleOptions): string | undefined {
  const text = value.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return `${label}必须是数字，最多两位小数`;
  if (!options?.allowNegative && Number(text) < 0) return `${label}不能为负数`;
  const integer = text.replace(/^-/, "").split(".")[0].replace(/^0+/, "");
  if (options?.maxIntegerDigits !== undefined && integer.length > options.maxIntegerDigits) return `${label}整数部分最多${options.maxIntegerDigits}位`;
  return undefined;
}

/** 金额：数字、最多两位小数、非负（允许负值需显式传 allowNegative）。 */
export function moneyRules(label = "金额", options?: MoneyRuleOptions): Rule[] {
  return [
    {
      validator: (_rule, value) => {
        if (value === undefined || value === null || value === "") return Promise.resolve();
        const error = moneyValidationError(String(value), label, options);
        return error ? Promise.reject(new Error(error)) : Promise.resolve();
      },
    },
  ];
}

/** 必填 + 金额格式，一步到位。 */
export function requiredMoneyRules(label = "金额", options?: { allowNegative?: boolean }): Rule[] {
  return [{ required: true, message: `请输入${label}` }, ...moneyRules(label, options)];
}

/** 比例（0–100）：适用于仍保留比例口径的业务字段。 */
export function percentRules(label = "比例"): Rule[] {
  return [
    {
      validator: (_rule, value) => {
        if (value === undefined || value === null || value === "") return Promise.resolve();
        const text = String(value).trim();
        if (!/^\d+(\.\d{1,2})?$/.test(text)) {
          return Promise.reject(new Error(`${label}必须是数字`));
        }
        const num = Number(text);
        if (num < 0 || num > 100) return Promise.reject(new Error(`${label}需在 0 到 100 之间`));
        return Promise.resolve();
      },
    },
  ];
}

/** 正整数编号：用于订单、客户、合作方等数据库 ID 输入。 */
export function positiveIntegerRules(label = "编号"): Rule[] {
  return [
    {
      validator: (_rule, value) => {
        if (value === undefined || value === null || value === "") return Promise.resolve();
        const number = Number(value);
        if (!Number.isInteger(number) || number <= 0) {
          return Promise.reject(new Error(`${label}必须是正整数`));
        }
        return Promise.resolve();
      },
    },
  ];
}
