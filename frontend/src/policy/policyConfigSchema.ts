/** 经营规则的结构化配置 schema。
 *
 * 背景（2026-10-26 重构）：原面板把全部规则参数塞进一个裸 JSON 文本框，
 * 6 种规则形状各异却共用一个 `Input.TextArea`，用户得手敲 `{"rate":"5"}` 且无校验。
 * 这里按 `policy_code` 给出每类规则的字段定义，表单渲染对应控件、提交时序列化为
 * 原 JSON 形状——后端契约（config 为 JSON）完全不变。
 *
 * 注意：库里 config 的值都是**字符串**（seed 用 `{"rate":"5"}` / `{"periods":"3"}`），
 * 故表单值一律按字符串处理并原样提交，不做类型转换，避免与既有数据形状漂移。
 * 值为空数组的类型表示「无需配置参数」（COMMISSION / WRITE_DOWN / REFUND）。
 */
export type PolicyFieldKind = "text" | "select";

export interface PolicyFieldDef {
  key: string;
  label: string;
  kind: PolicyFieldKind;
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
}

export const POLICY_CONFIG_SCHEMA: Record<string, PolicyFieldDef[]> = {
  REBATE: [{ key: "rate", label: "返点比例", kind: "text", placeholder: "5", help: "百分比数值，例如 5 表示 5%" }],
  INSTALLMENT: [
    { key: "periods", label: "分期期数", kind: "text", placeholder: "3" },
    {
      key: "cycle",
      label: "还款节奏",
      kind: "select",
      options: [
        { value: "monthly", label: "按月" },
        { value: "weekly", label: "按周" },
        { value: "daily", label: "按日" },
      ],
    },
  ],
  DG_MIXED: [{ key: "mode", label: "默认策略", kind: "text", placeholder: "standard" }],
};

export const policyConfigFields = (code: string): PolicyFieldDef[] => POLICY_CONFIG_SCHEMA[code] ?? [];

/** 把后端 config（JSON 对象）摊平成表单字段值。 */
export function configToFields(code: string, config: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of policyConfigFields(code)) {
    const raw = config[f.key];
    out[f.key] = raw == null ? "" : String(raw);
  }
  return out;
}

/** 把表单字段值收敛回后端 config（JSON 对象）；无字段的类型返回空对象。 */
export function fieldsToConfig(code: string, fields: Record<string, string>): Record<string, unknown> {
  const schema = policyConfigFields(code);
  if (schema.length === 0) return {};
  const out: Record<string, string> = {};
  for (const f of schema) {
    const v = (fields[f.key] ?? "").trim();
    if (v) out[f.key] = v;
  }
  return out;
}
