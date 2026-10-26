/** 设置项与审计实体的映射注册表 —— 单一事实源。
 *
 * 配置审计面板依此将审计流水翻译为具体的设置项名称。
 *
 * entityTypes 取自后端 audit_logs.entity_type 的**实际写入值**（dev 库实证）。
 * ⚠️ 大小写不统一且无规律：`order_form_field`/`field_definition` 是下划线小写，
 * 而 `OrderTypeDef`/`OrderTypePool`/`GameTypeOption`/`Pool`/`pool_account` 是驼峰或首字母大写。
 * 不要按模型名推断，必须照抄实际值，否则查不到改动记录。
 */

import { api } from "../shared/api/client";
import {
  fieldsApi,
  gameTypesApi,
  importsApi,
  optionSetsApi,
  orderTypesApi,
  periodLocksApi,
  policyApi,
  poolsApi,
  qualityApi,
  sequencesApi,
} from "../shared/api/catalog";
import { FORM_SCOPES } from "./formScopes";

export type ConfigGroupCode = "FIELD" | "MASTER" | "POLICY" | "GOV" | "ORG" | "OPS";

export const CONFIG_GROUP_LABEL: Record<ConfigGroupCode, string> = {
  FIELD: "字段配置",
  MASTER: "业务主数据",
  POLICY: "业务规则",
  GOV: "数据治理",
  ORG: "组织与权限",
  OPS: "作业与外观",
};

export interface SettingsItemMeta {
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
  /** 当前条目数；null 表示不适用（纯开关或静态文案）。 */
  count: () => Promise<number | null>;
}

const noCount = async (): Promise<null> => null;

export const SETTINGS_ITEMS: SettingsItemMeta[] = [
  {
    key: "form-fields",
    label: "表单字段",
    summary: `${FORM_SCOPES.length} 个业务表单的字段：选填/必填、停用/启用、增删自定义字段`,
    group: "FIELD",
    permission: "field-definition.manage",
    entityTypes: ["order_form_field"],
    // 表单数是注册表静态已知量；逐作用域的明细由总览面板按需展开时再拉。
    count: async () => FORM_SCOPES.length,
  },
  {
    key: "fields",
    label: "活字段",
    summary: "客户/账号等实体的自定义字段，独立于表单字段体系",
    group: "FIELD",
    permission: "field-definition.manage",
    entityTypes: ["field_definition"],
    count: async () => (await fieldsApi.list()).length,
  },
  {
    key: "order-types",
    label: "业务类型",
    summary: "回收/提号/代挂/代分期等定义，含资金性质与编号前缀",
    group: "MASTER",
    // 只收 OrderTypeDef：路由（OrderTypePool）归「资金池」项，
    // 否则同一批 ROUTE_UPDATE 会在两项里重复计数（与 Pool / pool_account 的处理口径一致）。
    entityTypes: ["OrderTypeDef"],
    count: async () => (await orderTypesApi.list()).length,
  },
  {
    key: "pools",
    label: "资金池",
    // 池与路由同属设置页「资金池」页签（池为视图一、路由为视图二），此处合并计数。
    summary: "资金归属池定义与过账路由：钱归谁、各业务类型按份额落到哪个池",
    group: "MASTER",
    entityTypes: ["Pool", "OrderTypePool"],
    count: async () => {
      const [poolRows, types] = await Promise.all([poolsApi.list(), orderTypesApi.list()]);
      const lists = await Promise.all(types.map((type) => orderTypesApi.routes(type.id).catch(() => [])));
      return poolRows.length + lists.reduce((sum, rows) => sum + rows.length, 0);
    },
  },
  {
    key: "game-types",
    label: "游戏类型",
    summary: "产品分类选项，建单与库存共用",
    group: "MASTER",
    entityTypes: ["GameTypeOption"],
    count: async () => (await gameTypesApi.list({ include_inactive: true })).length,
  },
  {
    key: "policies",
    label: "经营规则",
    summary: "返点/提成/分期/折让/退款规则版本与参数，写进订单快照参与计算",
    group: "POLICY",
    entityTypes: ["policy_definition", "policy_version"],
    count: async () => (await policyApi.list()).total,
  },
  {
    key: "quality-issues",
    label: "质量异常议题",
    summary: "数据一致性异常工单：生成、分派、关闭留痕",
    group: "GOV",
    permission: "report.read",
    entityTypes: ["quality_issue"],
    count: async () => (await qualityApi.list()).items.length,
  },
  {
    key: "users",
    label: "人员与权限",
    summary: "用户账号、角色权限与资金可见范围",
    group: "ORG",
    permission: "user.manage",
    entityTypes: ["user"],
    count: async () => (await api.get<unknown[]>("/users")).data.length,
  },
  {
    key: "teams",
    label: "团队管理",
    summary: "团队划分，用于业绩归属与提成分摊",
    group: "ORG",
    permission: "user.manage",
    entityTypes: [],
    count: async () => (await api.get<unknown[]>("/teams")).data.length,
  },
  {
    key: "imports",
    label: "标准导入",
    summary: "批量导入作业：映射、提交、回滚",
    group: "OPS",
    permission: "import.manage",
    entityTypes: ["import_batch"],
    count: async () => (await importsApi.batches()).total,
  },
  {
    key: "period-locks",
    label: "月结账期锁",
    summary: "封账后该账期禁止登记/修改现金流",
    group: "OPS",
    permission: "finance.period.lock",
    entityTypes: ["period_lock"],
    count: async () => (await periodLocksApi.list()).length,
  },
  {
    key: "sequences",
    label: "编号序列",
    summary: "单号生成现状排查；后端只读，不能在此修改",
    group: "OPS",
    permission: "order-type.manage",
    readOnly: true,
    entityTypes: [],
    count: async () => (await sequencesApi.list()).length,
  },
  {
    key: "business-dictionary",
    label: "业务字典",
    summary: "术语口径说明，纯静态文案",
    group: "OPS",
    readOnly: true,
    entityTypes: [],
    count: noCount,
  },
  {
    key: "option-sets",
    label: "选项词典",
    summary: "库存/资金等筛选项的单一来源：纯字典可编辑，后端死枚举只读",
    group: "OPS",
    permission: "option-set.manage",
    entityTypes: ["option_set"],
    count: async () => (await optionSetsApi.list()).items.length,
  },
  {
    key: "config-audit",
    label: "改动追溯",
    summary: "配置改动流水：按配置项 / 动作 / 操作人 / 时间筛选，只读",
    group: "GOV",
    permission: "audit.read",
    readOnly: true,
    entityTypes: [],
    count: noCount,
  },
  {
    key: "appearance",
    label: "外观",
    summary: "浅色/深色主题，仅本地偏好，不入库",
    group: "OPS",
    entityTypes: [],
    count: noCount,
  },
];

/** 全部涉及的 entity_type 扁平集合，供「最近配置改动」流水过滤。 */
export const CONFIG_ENTITY_TYPES: string[] = [
  ...new Set(SETTINGS_ITEMS.flatMap((item) => item.entityTypes)),
];

/** entity_type → 配置项标签，流水中把「order_form_field」翻成人话。 */
export const ENTITY_TYPE_TO_ITEM: Record<string, string> = Object.fromEntries(
  SETTINGS_ITEMS.flatMap((item) => item.entityTypes.map((type) => [type, item.label])),
);
