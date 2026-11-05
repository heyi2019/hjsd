/** 表单字段配置与列表列配置。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface RequiredWhen {
  /** 依赖字段键（同作用域内其它字段） */
  field: string;
  /** eq=等于任一触发值；ne=不等于任一触发值；filled=依赖字段有值 */
  op: "eq" | "ne" | "filled";
  /** 触发值（op=filled 时必须为空） */
  values?: string[] | null;
}

export interface FormScope {
  code: string;
  label: string;
  group: string;
}

export interface OrderFormField {
  id: number;
  order_type_code: string;
  field_key: string;
  label: string;
  field_type: string;
  options?: Array<{ value: string; label: string }> | null;
  flow_direction?: "IN" | "OUT" | null;
  required: boolean;
  /** 条件必填：与 required 互斥；为空即纯选填 */
  required_when?: RequiredWhen | null;
  is_active: boolean;
  sort_order: number;
  /** 核心核算字段锁定：禁止删除，但仍可改必填/停用 */
  locked: boolean;
  /** 用户自定义字段（区别于种子预置的系统字段）；自定义字段可增删停 */
  is_custom: boolean;
  section?: string;
  note?: string | null;
}

export interface ListColumnConfig {
  key: string;
  label: string;
  /** 锁定列（身份列/操作列）不可隐藏，后端二次校验 */
  locked: boolean;
  is_visible: boolean;
  sort_order: number;
  /** 列宽覆盖值（px）；null/undefined = 沿用列定义自身宽度 */
  width?: number | null;
  /** 固定列；null/undefined = 不固定 */
  fixed?: "left" | "right" | null;
  /** 管理员新增的自定义列（绑定表单自定义字段） */
  custom?: boolean;
  /** 取值键：行数据 form_extra / extra_values 里的字段键 */
  source_key?: string | null;
  /** 选项码 → 中文展示名（SELECT / MULTI_SELECT） */
  value_labels?: Record<string, string> | null;
}

export interface ListScopeConfig {
  code: string;
  label: string;
  columns: ListColumnConfig[];
}

export interface ListCustomFieldOption {
  scope: string;
  scope_label: string;
  field_key: string;
  label: string;
  field_type: string;
  options: Array<{ value: string; label: string }>;
  /** 数据中已有值的键（无字段定义，按原值展示，标注来源与行数） */
  data_only?: boolean;
  source_label?: string | null;
  row_count?: number | null;
}
