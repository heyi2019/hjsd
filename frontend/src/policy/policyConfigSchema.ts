/** 经营规则的结构化配置 schema（声明式，数据驱动渲染）。
 *
 * 背景：
 * - 2026-10-26 首次重构把裸 JSON 文本框换成按 policy_code 渲染的固定表单；
 * - 本次再进一步：字段定义升级为声明式描述（控件类型 / 单位 / 必填 / 上下限 /
 *   多行费率表），表单完全由 schema 驱动，新增规则参数只改本文件，不碰 UI 代码。
 *
 * 关键事实（勿凭直觉改）：
 * - 后端只校验 config 是**非空对象**（app/policy/service.py:86，契约测试
 *   test_create_version_notfound_and_empty_config 锁死），不校验 key 集合。
 * - 后端引擎消费规则的是 COMMISSION：不是「分润率」而是**按动作拆分的分润模板**
 *      （买入动作 / 卖出动作 / 运营动作 / 公司），当前仅作口径留痕；
 *      订单分润弹窗仍手工录入，未取此模板（2026-10-26 用户口径：暂时都填 0）。
 *   其余四类（分期 service_fee_rate / 跌价 / 退款 / DG）后端取接口入参或专用字段，
 *   **不读规则快照**，故只作版本留痕。
 * - 每个字段用 `effective` 声明消费状态（calc / snapshot），编辑器据此在
 *   label 上打标，避免使用者误以为「配了就改金额」。
 * - 库里 config 的值都是**字符串**（例如 {"periods":"3"}），
 *   表单提交时统一 String 化，避免数据形状漂移。
 */
export type PolicyFieldKind = "text" | "number" | "percent" | "select" | "rate-table";

/** 字段的后端消费状态：calc = 引擎真读并影响计算；snapshot = 仅随版本固化留痕。
 *  取证依据（勿凭直觉改）：订单分润模板当前只作版本留痕，
 * 其余规则参数也由各自业务接口接收，不从返点规则配置读取。
 */
export type PolicyFieldEffective = "calc" | "snapshot";

export interface PolicyFieldDef {
  /** config 中的键；rate-table 时是子对象键（如 rates）。 */
  key: string;
  label: string;
  kind: PolicyFieldKind;
  /** 未声明按 snapshot 处理：宁可少承诺，不谎称生效。 */
  effective?: PolicyFieldEffective;
  /** select 的选项。 */
  options?: { value: string; label: string }[];
  /** rate-table 的行定义：key 对应 config[field.key][row.key]。 */
  rows?: { key: string; label: string }[];
  placeholder?: string;
  help?: string;
  /** 未声明即选填。 */
  required?: boolean;
  /** number / percent 的取值范围。 */
  min?: number;
  max?: number;
  /** rate-table 各行的默认值：仅当该字段整体未配置时启用（如分润 30/30/0/40）。 */
  rowDefaults?: Record<string, string>;
  /** rate-table 合计必须等于该值（分润四项比例必须为 100）。 */
  sumTo?: number;
}

/** 库龄分档：Q3「通过经营规则版本配置库龄区间与跌价比例」的默认三档。 */
const AGE_ROWS = [
  { key: "AGE_0_90", label: "0–90 天" },
  { key: "AGE_91_180", label: "91–180 天" },
  { key: "AGE_181_PLUS", label: "180 天以上" },
];

/** 利润分配四项：与后端 policy/service.py 的 allocation_type 取值一一对应。
 *  BUY / SELL 会自动绑定对应动作执行人，OPERATION 绑定运营人员，COMPANY 为公司归属。 */
export const ALLOCATION_ROWS = [
  { key: "BUY", label: "买入动作" },
  { key: "SELL", label: "卖出动作" },
  { key: "OPERATION", label: "运营动作" },
  { key: "COMPANY", label: "公司" },
];

/** 分润默认口径：买入动作 30% / 卖出动作 30% / 公司 40%（合计 100%）。
 *  这是业务既定比例，不是猜值；规则版本存在时以版本为准。 */
export const DEFAULT_COMMISSION_SPLIT: Record<string, string> = {
  BUY: "30",
  SELL: "30",
  OPERATION: "0",
  COMPANY: "40",
};

const AMOUNT_BASE = [
  { value: "GROSS", label: "成交额" },
  { value: "PRINCIPAL", label: "本金" },
  { value: "PROFIT", label: "利润" },
];

export const POLICY_CONFIG_SCHEMA: Record<string, PolicyFieldDef[]> = {
  COMMISSION: [
    {
      key: "split",
      label: "分润分配比例",
      kind: "rate-table",
      rows: ALLOCATION_ROWS,
      sumTo: 100,
      rowDefaults: DEFAULT_COMMISSION_SPLIT,
      help: "利润按动作拆分：买入动作、卖出动作、运营动作各拿对应比例，公司拿剩余；合计必须 100%。订单利润分配弹窗当前仍手工录入，暂不取此模板",
    },
  ],
  INSTALLMENT: [
    {
      key: "service_fee_rate",
      label: "服务费率",
      kind: "percent",
      placeholder: "3",
      help: "分期服务费按计算基数计提的比例（Q9：标准利率参数化）",
    },
    { key: "base", label: "计算基数", kind: "select", options: AMOUNT_BASE },
    { key: "periods", label: "分期期数", kind: "number", placeholder: "3", required: true, min: 1, max: 60 },
    {
      key: "cycle",
      label: "还款节奏",
      kind: "select",
      required: true,
      options: [
        { value: "monthly", label: "按月" },
        { value: "weekly", label: "按周" },
        { value: "daily", label: "按日" },
      ],
    },
  ],
  WRITE_DOWN: [
    {
      key: "age_rates",
      label: "库龄跌价比例",
      kind: "rate-table",
      rows: AGE_ROWS,
      help: "按库龄区间设置跌价比例（Q3）；留空表示该区间不计提",
    },
  ],
  REFUND: [
    {
      key: "category",
      label: "退款类别",
      kind: "text",
      placeholder: "全额 / 部分",
      help: "本条规则适用的退款类别编码（Q5：类别与收退款分类可配）",
    },
    {
      key: "refund_category",
      label: "收退款分类",
      kind: "text",
      placeholder: "运营 / 客户",
      help: "该类别退款在资金侧的归类编码",
    },
  ],
  DG_MIXED: [
    {
      key: "mode",
      label: "默认处置",
      kind: "text",
      placeholder: "标准",
      required: true,
      help: "混合单的默认处置策略编码；DG 不设抽成参数与默认值",
    },
  ],
};

export const policyConfigFields = (code: string): PolicyFieldDef[] => POLICY_CONFIG_SCHEMA[code] ?? [];

/** 该规则是否有可配置参数（false 时编辑器禁用保存，避免提交空 config 被拒）。 */
export const policyHasConfig = (code: string): boolean => policyConfigFields(code).length > 0;

/** 把后端 config（JSON 对象）摊平成表单值；rate-table 摊成嵌套对象。
 *  该字段整体未配置时才用 rowDefaults 兜默认模板（分润 30/30/0/40）。 */
export function configToFields(code: string, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of policyConfigFields(code)) {
    const raw = config[f.key];
    if (f.kind === "rate-table") {
      const hasRaw = !!raw && typeof raw === "object" && !Array.isArray(raw);
      const src = hasRaw ? (raw as Record<string, unknown>) : {};
      out[f.key] = Object.fromEntries(
        (f.rows ?? []).map((row) => [
          row.key,
          src[row.key] != null ? String(src[row.key]) : hasRaw ? "" : (f.rowDefaults?.[row.key] ?? ""),
        ]),
      );
      continue;
    }
    out[f.key] = raw == null ? "" : String(raw);
  }
  return out;
}

/** rate-table 各行的合计；非数字按 0 计（输入框里允许中间态）。 */
export function rateTableTotal(
  values: Record<string, unknown> | undefined | null,
  rows: { key: string }[] | undefined,
): number {
  const src = values ?? {};
  return (rows ?? []).reduce((sum, row) => sum + Number(src[row.key] ?? 0), 0);
}

/** 把表单值收敛回后端 config（JSON 对象）；空值一律丢弃，保持与既有数据同形状。 */
export function fieldsToConfig(code: string, fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of policyConfigFields(code)) {
    const raw = fields[f.key];
    if (f.kind === "rate-table") {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entries = Object.entries(raw as Record<string, unknown>)
        .map(([key, value]) => [key, String(value ?? "").trim()] as const)
        .filter(([, value]) => value !== "");
      if (entries.length > 0) out[f.key] = Object.fromEntries(entries);
      continue;
    }
    const value = String(raw ?? "").trim();
    if (value) out[f.key] = value;
  }
  return out;
}

/** 版本历史里把 config 显示成人话：优先按 schema 翻译成中文
 *  （rate-table 行用行标签，select 值用选项标签）；传不了 code 或未知键时回落原始 key=value。 */
export function describeConfig(
  config: Record<string, unknown> | null | undefined,
  code?: string,
): string {
  if (!config) return "（无参数）";
  const fields = code ? policyConfigFields(code) : [];
  const parts: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    const field = fields.find((f) => f.key === key);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
        const rowLabel = field?.rows?.find((r) => r.key === sub)?.label;
        const left = rowLabel ?? `${field?.label ?? key}.${sub}`;
        parts.push(`${left}=${String(subValue)}`);
      }
      continue;
    }
    const optLabel = field?.options?.find((o) => o.value === String(value))?.label;
    parts.push(`${field?.label ?? key}=${optLabel ?? String(value)}`);
  }
  return parts.join(" · ") || "（无参数）";
}
