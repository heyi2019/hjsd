/**
 * 测试用建单表单字段种子：与 backend alembic/versions/0005_seed_select_options.py
 * 保持一致。前端下拉改为从 OrderFormField 配置读选项后，UI 测试需要一份可用的
 * 默认配置，否则 Select/Radio 无选项（注入逻辑 injectOptionsIfMissing 仅在配置
 * 有 options 时才注入）。各测试文件在 beforeEach 调 seedOrderFormFields 即可零改动
 * 获得与原硬编码一致的选项集（功能开启后零行为变化）。
 */
import type { OrderFormField } from "../shared/api/catalog";

type SeedDef = {
  key: string;
  label: string;
  type: "SELECT" | "MULTI_SELECT" | "TEXT" | "NUMBER" | "DATE" | "BOOLEAN";
  options: Array<{ value: string; label: string }>;
  required?: boolean;
};

const SRC: Array<{ value: string; label: string }> = [
  { value: "自营", label: "自营" },
  { value: "微博", label: "微博" },
  { value: "小红书", label: "小红书" },
  { value: "闲鱼", label: "闲鱼" },
  { value: "同行推荐", label: "同行推荐" },
  { value: "其他", label: "其他" },
];

const PLAT: Array<{ value: string; label: string }> = [
  { value: "盼之", label: "盼之" },
  { value: "千寻", label: "千寻" },
  { value: "白情", label: "白情" },
  { value: "螃蟹", label: "螃蟹" },
  { value: "私下", label: "私下" },
  { value: "其他", label: "其他" },
];

const SCOPE_SEED: Record<string, SeedDef[]> = {
  HS: [
    { key: "has_secondary", label: "有无二次", type: "SELECT", options: [{ value: "有", label: "有" }, { value: "无", label: "无" }] },
    { key: "customer_source", label: "客户来源", type: "SELECT", options: SRC },
    { key: "intermediary_platform", label: "经手平台", type: "SELECT", options: PLAT },
    { key: "intermediary_type", label: "中介类型", type: "SELECT", options: [{ value: "普中", label: "普中" }, { value: "包赔", label: "包赔" }] },
    { key: "compensation_type", label: "包赔类型", type: "SELECT", options: [{ value: "首保", label: "首保" }, { value: "续保", label: "续保" }] },
  ],
  DG: [
    { key: "has_secondary", label: "有无二次", type: "SELECT", options: [{ value: "有", label: "有" }, { value: "无", label: "无" }] },
    { key: "dg_customer_source", label: "客户来源", type: "SELECT", options: SRC },
  ],
  DFQ: [
    { key: "dfq_has_secondary", label: "有无二次", type: "SELECT", options: [{ value: "有", label: "有" }, { value: "无", label: "无" }] },
    { key: "dfq_customer_source", label: "客户来源", type: "SELECT", options: SRC },
    { key: "intermediary_platform", label: "经手平台", type: "SELECT", options: PLAT },
    { key: "intermediary_type", label: "中介类型", type: "SELECT", options: [{ value: "普中", label: "普中" }, { value: "包赔", label: "包赔" }] },
    { key: "compensation_type", label: "包赔类型", type: "SELECT", options: [{ value: "首保", label: "首保" }, { value: "续保", label: "续保" }] },
  ],
  TH: [
    { key: "has_secondary", label: "有无二次", type: "SELECT", options: [{ value: "有", label: "有" }, { value: "无", label: "无" }] },
    { key: "customer_source", label: "客户来源", type: "SELECT", options: SRC },
    { key: "supplier_source", label: "供货方来源", type: "SELECT", options: [{ value: "氪金联盟", label: "氪金联盟" }, { value: "同行", label: "同行" }, { value: "其他", label: "其他" }] },
    { key: "intermediary_platform", label: "经手平台", type: "SELECT", options: PLAT },
    { key: "intermediary_type", label: "中介类型", type: "SELECT", options: [{ value: "普中", label: "普中" }, { value: "包赔", label: "包赔" }] },
    { key: "compensation_type", label: "包赔类型", type: "SELECT", options: [{ value: "首保", label: "首保" }, { value: "续保", label: "续保" }] },
  ],
  LEAD: [
    { key: "request_type", label: "需求类型", type: "SELECT", options: [{ value: "FIND_ACCOUNT", label: "找号" }, { value: "SELL_ACCOUNT", label: "卖号" }, { value: "SPECIFIC_SEARCH", label: "指定搜索" }] },
  ],
  SALE: [
    { key: "payment_method", label: "付款方式", type: "SELECT", options: [{ value: "FULL", label: "全款" }, { value: "INSTALLMENT", label: "分期付款" }] },
  ],
  FUNDFLOW: [
    { key: "direction", label: "收支方向", type: "SELECT", options: [{ value: "IN", label: "收入" }, { value: "OUT", label: "支出" }] },
    { key: "fund_nature", label: "资金性质", type: "SELECT", options: [{ value: "BUSINESS", label: "本方经营" }, { value: "EXTERNAL", label: "外部/受托" }, { value: "INTERNAL", label: "内部调拨" }] },
    {
      key: "accounting_attribute",
      label: "核算属性",
      type: "SELECT",
      options: [
        { value: "SELF_REVENUE", label: "自营收入" },
        { value: "SELF_DIRECT_COST", label: "自营直接成本" },
        { value: "TH_DIRECT_COST", label: "提号/代挂直接成本" },
        { value: "TH_REVENUE", label: "提号/代挂收入" },
        { value: "DFQ_PRINCIPAL", label: "代分期借款本金" },
        { value: "SERVICE_REVENUE", label: "增值服务收入" },
        { value: "REBATE_INCOME", label: "返点收入" },
        { value: "OPERATING_EXPENSE", label: "运营费用" },
        { value: "DEPOSIT", label: "押金/保证金" },
        { value: "EXTERNAL_FUNDING", label: "外部资金" },
        { value: "INTERNAL_TRANSFER", label: "内部调拨" },
        { value: "REVERSAL", label: "冲销" },
        { value: "REFUND", label: "退款" },
      ],
    },
  ],
  REBATE: [
    { key: "rebate_type", label: "返点类型", type: "SELECT", options: [{ value: "BUY", label: "买号返点" }, { value: "SELL", label: "卖号返点" }] },
  ],
  INVREBATE: [
    { key: "rebate_type", label: "返点类型", type: "SELECT", options: [{ value: "BUY", label: "买号返点" }, { value: "SELL", label: "卖号返点" }] },
  ],
  INSTDELIVER: [
    { key: "delivery_mode", label: "交付方式", type: "SELECT", options: [{ value: "PLATFORM_OPERATOR", label: "平台/本方操作换绑" }, { value: "CUSTOMER_SELF", label: "客户自行换绑" }] },
  ],
  POOLACCOUNT: [
    { key: "account_type", label: "账户类型", type: "SELECT", options: [{ value: "BANK", label: "银行账户" }, { value: "CASH", label: "现金" }, { value: "THIRD_PARTY", label: "第三方渠道" }] },
    { key: "ownership", label: "归属", type: "SELECT", options: [{ value: "OWNED", label: "自有（计入权益）" }, { value: "CUSTODY", label: "代管（只计头寸）" }, { value: "THIRD_PART", label: "第三方（只计头寸）" }] },
  ],
};

let _id = 1;

/** 展开为全部 OrderFormField 行（按 scope 维度），供测试默认种子使用。 */
export function allFormFields(): OrderFormField[] {
  const rows: OrderFormField[] = [];
  for (const [scope, defs] of Object.entries(SCOPE_SEED)) {
    defs.forEach((def, idx) => {
      rows.push({
        id: _id++,
        order_type_code: scope,
        field_key: def.key,
        label: def.label,
        field_type: def.type,
        options: def.options,
        required: def.required ?? false,
        is_active: true,
        sort_order: idx + 1,
        locked: false,
        is_custom: false,
        note: null,
      });
    });
  }
  return rows;
}

/**
 * 把 orderFormFieldsApi.list 桩成返回完整种子（按 scope 过滤），让任意测试打开任意
 * 业务弹窗都能拿到与原硬编码一致的选项。includeInactive 在测试种子里忽略。
 */
export function seedOrderFormFields(catalog: {
  orderFormFieldsApi: { list: (scope: string, includeInactive?: boolean) => unknown };
}): void {
  const all = allFormFields();
  (catalog.orderFormFieldsApi.list as unknown as { mockResolvedValue(value: unknown): void }).mockResolvedValue(all);
}

/** T20：选项词典种子，与 backend alembic/versions/0007_create_option_sets.py 一致。 */
export interface SeedOptionSet {
  code: string;
  label: string;
  group: string;
  editable: boolean;
  options: Array<{ value: string; label: string }>;
}

export const OPTION_SET_SEED: SeedOptionSet[] = [
  { code: "INVENTORY_STATUS", label: "库存状态", group: "INVENTORY", editable: false, options: [
    { value: "IN_STOCK", label: "在库" }, { value: "INSTALLMENT", label: "分期中" }, { value: "SOLD", label: "已售" }, { value: "VOID", label: "下架" },
  ] },
  { code: "INVENTORY_BUSINESS", label: "库存业务", group: "INVENTORY", editable: false, options: [
    { value: "SELF", label: "自营" }, { value: "DISTRIBUTION", label: "分销" },
  ] },
  { code: "INVENTORY_TYPE", label: "库存类型", group: "INVENTORY", editable: false, options: [
    { value: "RECOVERY", label: "回收" }, { value: "PICKUP", label: "提号" }, { value: "CONSIGNMENT", label: "代挂" },
  ] },
  { code: "FUND_FLOW_DIRECTION", label: "流水方向", group: "FUND", editable: false, options: [
    { value: "IN", label: "收入" }, { value: "OUT", label: "支出" },
  ] },
  { code: "FUND_FLOW_STATUS", label: "流水状态", group: "FUND", editable: false, options: [
    { value: "PENDING", label: "待审核" }, { value: "APPROVED", label: "已审核" }, { value: "REJECTED", label: "已拒绝" },
  ] },
  { code: "FUND_FLOW_FUND_NATURE", label: "流水资金性质", group: "FUND", editable: false, options: [
    { value: "BUSINESS", label: "本方经营" }, { value: "EXTERNAL", label: "外部/受托" }, { value: "INTERNAL", label: "内部调拨" },
  ] },
  { code: "FUND_FLOW_ACCOUNTING_ATTRIBUTE", label: "流水核算属性", group: "FUND", editable: false, options: [
    { value: "SELF_REVENUE", label: "自营收入" }, { value: "SELF_DIRECT_COST", label: "自营直接成本" }, { value: "TH_DIRECT_COST", label: "提号/代挂直接成本" }, { value: "TH_REVENUE", label: "提号/代挂收入" }, { value: "DFQ_PRINCIPAL", label: "代分期借款本金" }, { value: "SERVICE_REVENUE", label: "增值服务收入" }, { value: "REBATE_INCOME", label: "返点收入" }, { value: "OPERATING_EXPENSE", label: "运营费用" }, { value: "DEPOSIT", label: "押金/保证金" }, { value: "EXTERNAL_FUNDING", label: "外部资金" }, { value: "INTERNAL_TRANSFER", label: "内部调拨" }, { value: "REVERSAL", label: "冲销" }, { value: "REFUND", label: "退款" },
  ] },
];

/** 桩 optionSetsApi.list 返回完整种子，供库存/资金筛选器测试拿到筛选项。 */
export function seedOptionSets(catalog: {
  optionSetsApi: { list: (params?: { group?: string; editable?: boolean }) => unknown };
}): void {
  const payload = { items: OPTION_SET_SEED.map((s) => ({ id: 1, ...s })) };
  (catalog.optionSetsApi.list as unknown as { mockResolvedValue(value: unknown): void }).mockResolvedValue(payload);
}

