/** 表单校验规则：金额与比例。
 *
 * 背景：此前金额字段普遍是 `<Form.Item rules={[{ required: true }]}><Input /></Form.Item>`，
 * 可以填 `abc` / `-100` 直接落账，且 required 没有 message（红框出现但无文字说明）。
 */
import type { Rule } from "antd/es/form";

/** 金额：数字、最多两位小数、非负（允许负值需显式传 allowNegative）。 */
export function moneyRules(label = "金额", options?: { allowNegative?: boolean }): Rule[] {
  return [
    {
      validator: (_rule, value) => {
        if (value === undefined || value === null || value === "") return Promise.resolve();
        const text = String(value).trim();
        if (!/^-?\d+(\.\d{1,2})?$/.test(text)) {
          return Promise.reject(new Error(`${label}必须是数字，最多两位小数`));
        }
        if (!options?.allowNegative && Number(text) < 0) {
          return Promise.reject(new Error(`${label}不能为负数`));
        }
        return Promise.resolve();
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
