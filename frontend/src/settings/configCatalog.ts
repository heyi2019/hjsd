/** 设置项与审计实体的映射注册表 —— 单一事实源。
 *
 * 配置审计面板依此将审计流水翻译为具体的设置项名称。
 *
 * entityTypes 取自后端 audit_logs.entity_type 的**实际写入值**（dev 库实证）。
 * ⚠️ 大小写不统一且无规律：`order_form_field`/`field_definition` 是下划线小写，
 * 而 `OrderTypeDef`/`GameTypeOption`/`Pool` 是驼峰或首字母大写。
 * 不要按模型名推断，必须照抄实际值，否则查不到改动记录。
 */

export type ConfigGroupCode = "FIELD" | "MASTER" | "BUSINESS" | "SEQUENCE" | "POLICY" | "GOV" | "ORG" | "OPS";

export const CONFIG_GROUP_LABEL: Record<ConfigGroupCode, string> = {
  FIELD: "字段配置",
  MASTER: "业务主数据",
  BUSINESS: "业务规则",
  SEQUENCE: "编号管理",
  POLICY: "业务规则",
  GOV: "数据治理",
  ORG: "组织与权限",
  OPS: "作业与外观",
};

interface SettingsItemMeta {
  /** 与 SettingsPage 的 Tab key 一致，用于跳转。 */
  key: string;
  label: string;
  summary: string;
  group: ConfigGroupCode;
  /** 需要的权限；为空表示所有进入设置页的人都能看到（与 SettingsPage 门控保持一致）。 */
  permission?: string;
  /** 只读项：后端无写入口，设置页里也不可改。 */
  readOnly?: boolean;
  /** 审计 entity_type（可多个，统计时取并集）。 */
  entityTypes: string[];
  /** 共用 option_set 对象类型时，用词典编号区分具体配置。 */
  optionSetCodes?: string[];
}

/** 设置页独立页签顺序，配置中心内部顺序也从本文件维护。 */
export const SETTINGS_TAB_ORDER = [
  "business-dictionary",
  "organization",
  "audit",
  "appearance",
] as const;

export const CONFIG_CENTER_GROUP_ORDER: ConfigGroupCode[] = [
  "FIELD",
  "MASTER",
  "BUSINESS",
  "SEQUENCE",
];

export const SETTINGS_ITEMS: SettingsItemMeta[] = [
  {
    key: "order-types",
    label: "业务类型",
    summary: "回收/提号/代挂等定义，含零本金规则与编号前缀",
    group: "MASTER",
    entityTypes: ["OrderTypeDef"],
  },
  {
    key: "form-fields",
    label: "表单字段",
    summary: "业务表单的字段：选填/必填、停用/启用、增删自定义字段",
    group: "FIELD",
    permission: "field-definition.manage",
    entityTypes: ["order_form_field"],
  },
  {
    key: "list-columns",
    label: "列表字段",
    // 读开放（各列表页要用它决定显示哪些列），写需 field-definition.manage，故与表单字段不同不设 permission 门控。
    summary: "台账 / 库存 / 分期 / 客户 / 返点 / 资金流水 / 报表 / 审计的列显示、顺序与固定列，可新增自定义列，改动即时生效",
    group: "FIELD",
    entityTypes: ["list_column_config"],
  },
  {
    key: "pools",
    label: "资金账户",
    summary: "资金账户定义与默认落账账户：钱归谁、未指定账户时统一落账到哪里",
    group: "MASTER",
    entityTypes: ["Pool"],
  },
  {
    key: "game-types",
    label: "游戏与渠道",
    summary: "产品分类选项，建单与库存共用",
    group: "MASTER",
    entityTypes: ["GameTypeOption"],
  },
  {
    key: "intermediary-platforms",
    label: "中介业务配置",
    summary: "维护经手平台、中介类型和包赔类型",
    group: "MASTER",
    entityTypes: [],
    optionSetCodes: ["INTERMEDIARY_PLATFORM", "INTERMEDIARY_TYPE", "COMPENSATION_TYPE"],
  },
  {
    key: "party-sources",
    label: "参与方来源",
    summary: "维护客户来源选项",
    group: "MASTER",
    entityTypes: [],
    optionSetCodes: ["CUSTOMER_SOURCE"],
  },
  {
    key: "business-reminders",
    label: "业务提醒",
    summary: "工作台库存、分润与逾期合约提醒规则",
    group: "BUSINESS",
    entityTypes: [],
    optionSetCodes: ["BUSINESS_OVERVIEW_REMINDERS"],
  },
  {
    key: "business-period",
    label: "当期设置",
    summary: "设置工作台和经营中心共用的每月周期起始日",
    group: "BUSINESS",
    permission: "option-set.manage",
    entityTypes: [],
    optionSetCodes: ["BUSINESS_PERIOD"],
  },
  {
    key: "company-profit",
    label: "公司分润",
    summary: "设置盈利及亏损时公司的分润比例",
    group: "BUSINESS",
    permission: "policy.manage",
    entityTypes: ["company_profit_settings"],
  },
  {
    key: "organization",
    label: "人员与团队",
    summary: "用户账号、角色权限、团队与资金可见范围",
    group: "ORG",
    permission: "user.manage",
    entityTypes: ["user"],
  },
  {
    key: "sequences",
    label: "编号序列",
    summary: "单号生成现状排查；后端只读，不能在此修改",
    group: "SEQUENCE",
    permission: "order-type.manage",
    readOnly: true,
    entityTypes: [],
  },
  {
    key: "business-dictionary",
    label: "业务字典",
    summary: "术语口径说明，纯静态文案",
    group: "OPS",
    readOnly: true,
    entityTypes: [],
  },
  {
    key: "audit",
    label: "审计记录",
    summary: "完整操作流水：按对象 / 动作 / 操作人 / 时间筛选，只读",
    group: "GOV",
    permission: "audit.read",
    readOnly: true,
    entityTypes: [],
  },
  {
    key: "appearance",
    label: "外观",
    summary: "浅色/深色主题，仅本地偏好，不入库",
    group: "OPS",
    entityTypes: [],
  },
];

/** 配置审计中的 entity_type 展示名；接口值保留原样，仅在页面上翻译。 */
export const CONFIG_ENTITY_TYPE_LABEL: Record<string, string> = {
  OrderTypeDef: "业务类型",
  order_form_field: "表单字段",
  list_column_config: "列表字段",
  Pool: "资金账户",
  GameTypeOption: "游戏与渠道",
  option_set: "选项词典",
  user: "用户",
};

/** entity_type → 配置项标签，流水中把「order_form_field」翻成人话。 */
const ENTITY_TYPE_TO_ITEM: Record<string, string> = Object.fromEntries(
  SETTINGS_ITEMS.flatMap((item) => item.entityTypes.map((type) => [type, item.label])),
);

const OPTION_SET_TO_ITEM: Record<string, string> = Object.fromEntries(
  SETTINGS_ITEMS.flatMap((item) => (item.optionSetCodes ?? []).map((code) => [code, item.label])),
);

export function configItemLabel(entityType?: string | null, entityId?: string | null): string {
  if (entityType === "option_set") return OPTION_SET_TO_ITEM[entityId ?? ""] ?? CONFIG_ENTITY_TYPE_LABEL.option_set;
  return ENTITY_TYPE_TO_ITEM[entityType ?? ""] ?? "—";
}
