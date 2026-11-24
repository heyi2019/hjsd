/** OrderFormFieldsPanel 的共享常量 / 类型 / 纯函数（拆分自面板主组件）。 */
export const OPTION_FIELD_TYPES = ["SELECT", "MULTI_SELECT"];
// 这些字段的选项来自业务主数据或运行时上下文，不允许在字段配置里手工维护。
export const MANAGED_OPTION_FIELD_KEYS = [
  "game_type",
  "channel_region",
  "intermediary_platform",
  "intermediary_type",
  "compensation_type",
  "payment_pool_id",
  "customer_source",
  "dg_customer_source",
  "business_responsible_ids",
];
// 系统统一术语字段：显示名由业务口径固定，配置中心不允许改名（后端有同名校验兜底）。
export const FIXED_LABEL_FIELD_KEYS = ["payment_pool_id"];
export const CONDITION_OP_OPTIONS = [
  { value: "eq", label: "等于" },
  { value: "ne", label: "不等于" },
  { value: "filled", label: "有值" },
];
export const OP_TEXT: Record<string, string> = { eq: "等于", ne: "不等于", filled: "有值" };
export const FLOW_DIRECTION_OPTIONS = [
  { value: "BASE", label: "基础信息" },
  { value: "OUT", label: "支出" },
  { value: "IN", label: "收入" },
] as const;
export const FIELD_SECTION_OPTIONS = [
  { value: "ACCOUNT_PRODUCT", label: "账号 / 产品信息" },
  { value: "BUSINESS", label: "业务方案信息" },
  { value: "DELIVER", label: "交付信息" },
  { value: "OPERATION", label: "运营信息" },
  { value: "FINANCE", label: "费用与资金" },
  { value: "EXTRA", label: "其他补充信息" },
  { value: "PARTICIPANT", label: "客户 / 供货方信息" },
];
export const ORDER_SCOPE_OPTIONS = [
  { value: "HS", label: "回收" },
  { value: "TH", label: "提号" },
  { value: "DG", label: "代挂" },
];
export const ORDER_SCOPE_CODES = new Set(ORDER_SCOPE_OPTIONS.map((item) => item.value));
export const DEFAULT_SECTION_ORDER = FIELD_SECTION_OPTIONS.map((item) => item.value);
export type SectionManagementRow = {
  value: string;
  label: string;
  count: number;
  index: number;
};

/** 条件描述文案：如「客户来源 等于 其他」。 */
export const describeCondition = (fieldLabel: string, cond: { op: string; values?: string[] | null }): string => {
  const opText = OP_TEXT[cond.op] ?? cond.op;
  if (cond.op === "filled") return `${fieldLabel} ${opText}即可`;
  return `${fieldLabel} ${opText} ${(cond.values ?? []).join(" / ")}`;
};

/** 校验后端规范化的 options 字段。 */
export const normalizeOptionItems = (raw: unknown): Array<{ value: string; label: string }> => {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("选项必须使用 value/label 对象");
    }
    const option = item as { value?: unknown; label?: unknown };
    if (typeof option.value !== "string" || typeof option.label !== "string") {
      throw new Error("选项必须使用 value/label 对象");
    }
    const value = option.value.trim();
    const label = option.label.trim();
    if (!value || !label) {
      throw new Error("选项 value/label 不能为空");
    }
    return { value, label };
  });
};

export interface OrderFormFieldsPanelProps {
  /** 初始选中的表单作用域；缺省为 HS。 */
  initialScope?: string;
  onConfigureGameTypes?: () => void;
  onConfigureIntermediaryPlatforms?: () => void;
  onConfigurePools?: () => void;
  onConfigurePartySources?: () => void;
}
