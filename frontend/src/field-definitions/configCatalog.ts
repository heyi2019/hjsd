/** 设置项注册表 —— 配置中心的单一事实源。 */

export type ConfigGroupCode = "FIELD" | "MASTER" | "BUSINESS" | "ORG" | "OPS";

export const CONFIG_GROUP_LABEL: Record<ConfigGroupCode, string> = {
  FIELD: "字段配置",
  MASTER: "业务主数据",
  BUSINESS: "业务规则",
  ORG: "组织与权限",
  OPS: "作业与外观",
};

interface SettingsItemMeta {
  /** 与 SettingsPage 的 Tab key 一致，用于跳转。 */
  key: string;
  label: string;
  group: ConfigGroupCode;
  /** 需要的权限；为空表示所有进入设置页的人都能看到（与 SettingsPage 门控保持一致）。 */
  permission?: string;
  /** 只读项：后端无写入口，设置页里也不可改。 */
  readOnly?: boolean;
}

export const SETTINGS_ITEMS: SettingsItemMeta[] = [
  {
    key: "order-types",
    label: "业务类型",
    group: "MASTER",
  },
  {
    key: "form-fields",
    label: "表单字段",
    group: "FIELD",
    permission: "field-definition.manage",
  },
  {
    key: "list-columns",
    label: "列表字段",
    // 读开放（各列表页要用它决定显示哪些列），写需 field-definition.manage，故与表单字段不同不设 permission 门控。
    group: "FIELD",
  },
  {
    key: "pools",
    label: "资金池",
    group: "MASTER",
  },
  {
    key: "game-types",
    label: "游戏与渠道",
    group: "MASTER",
  },
  {
    key: "business-reminders",
    label: "业务提醒",
    group: "BUSINESS",
  },
  {
    key: "users",
    label: "人员与权限",
    group: "ORG",
    permission: "user.manage",
  },
  {
    key: "teams",
    label: "团队管理",
    group: "ORG",
    permission: "user.manage",
  },
  {
    key: "business-dictionary",
    label: "业务字典",
    group: "OPS",
  },
  {
    key: "appearance",
    label: "外观",
    group: "OPS",
  },
];

export const SETTINGS_ITEM_BY_KEY = new Map(SETTINGS_ITEMS.map((item) => [item.key, item]));
