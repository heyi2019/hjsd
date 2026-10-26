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
  /* ── 0008 补种：客户 / 订单 / 分期 / 导入 / 规则 / 质量 / 资金 / 系统 ── */
  { code: "CUSTOMER_STATUS", label: "客户状态", group: "CUSTOMER", editable: false, options: [
    { value: "ACTIVE", label: "启用中" }, { value: "DISABLED", label: "已拉黑" }, { value: "MERGED", label: "已合并" },
  ] },
  { code: "COUNTERPARTY_STATUS", label: "合作方状态", group: "CUSTOMER", editable: false, options: [
    { value: "ACTIVE", label: "进行中" }, { value: "DISABLED", label: "已拉黑" },
  ] },
  { code: "COUNTERPARTY_TYPE", label: "合作方类型", group: "CUSTOMER", editable: false, options: [
    { value: "PEER", label: "同行" }, { value: "SUPPLIER", label: "供货方" }, { value: "PLATFORM", label: "平台" },
  ] },
  { code: "LEAD_STATUS", label: "需求状态", group: "CUSTOMER", editable: false, options: [
    { value: "OPEN", label: "未结算" }, { value: "CONVERTED", label: "已转化" }, { value: "CLOSED", label: "已关闭" },
  ] },
  { code: "LEAD_TYPE", label: "需求类型", group: "CUSTOMER", editable: false, options: [
    { value: "FIND_ACCOUNT", label: "找号" }, { value: "SELL_ACCOUNT", label: "卖号" }, { value: "SPECIFIC_SEARCH", label: "指定搜索" },
  ] },
  { code: "ORDER_STATUS", label: "订单状态", group: "ORDER", editable: false, options: [
    { value: "ACTIVE", label: "进行中" }, { value: "COMPLETED", label: "已完成" }, { value: "CANCELLED", label: "已取消" },
  ] },
  { code: "ORDER_LINK_STATUS", label: "订单关联状态", group: "ORDER", editable: false, options: [
    { value: "LINKED", label: "已关联" }, { value: "UNLINKED", label: "未关联" }, { value: "ORPHAN", label: "孤儿单" }, { value: "UNLINKED_TRANSFER", label: "单边划转未关联" },
  ] },
  { code: "REFUND_RESPONSIBILITY", label: "退款责任方", group: "ORDER", editable: true, options: [
    { value: "COMPANY", label: "公司" }, { value: "CUSTOMER", label: "客户" }, { value: "CONSIGNOR", label: "寄售方" }, { value: "PLATFORM", label: "平台" }, { value: "OTHER", label: "其他" },
  ] },
  { code: "ORDER_BUSINESS", label: "订单业务类型", group: "ORDER", editable: false, options: [
    { value: "HS", label: "回收" }, { value: "TH", label: "提号" }, { value: "DG", label: "代挂" }, { value: "DFQ", label: "代分期" },
  ] },
  { code: "ORDER_BUSINESS_MODE", label: "订单业务模式", group: "ORDER", editable: false, options: [
    { value: "SELF", label: "自营" }, { value: "DISTRIBUTION", label: "分销" },
  ] },
  { code: "ORDER_RELATION_TYPE", label: "订单关联关系", group: "ORDER", editable: false, options: [
    { value: "SOURCE", label: "来源单" }, { value: "FOLLOW_UP", label: "后续单" },
  ] },
  { code: "INSTALLMENT_CONTRACT_TYPE", label: "分期合约类型", group: "INSTALLMENT", editable: false, options: [
    { value: "STOCK_SALE", label: "分期出售" }, { value: "ADVANCE_PURCHASE", label: "代分期" }, { value: "PICKUP_SALE", label: "提号分期" }, { value: "CONSIGNMENT_SALE", label: "代挂分期" },
  ] },
  { code: "INSTALLMENT_STATUS", label: "分期状态", group: "INSTALLMENT", editable: false, options: [
    { value: "PENDING", label: "待首付" }, { value: "ACTIVE", label: "收款中" }, { value: "OVERDUE", label: "逾期" }, { value: "SETTLED", label: "已结清" }, { value: "DELIVERED", label: "已交付" }, { value: "DEFAULTED", label: "违约" }, { value: "CLOSED", label: "已关闭" }, { value: "CANCELLED", label: "已取消" },
  ] },
  { code: "SCHEDULE_STATUS", label: "期次状态", group: "INSTALLMENT", editable: false, options: [
    { value: "PENDING", label: "待收" }, { value: "PARTIAL", label: "部分收款" }, { value: "PAID", label: "已收" }, { value: "OVERDUE", label: "逾期" }, { value: "WAIVED", label: "已减免" },
  ] },
  { code: "DEPOSIT_STATUS", label: "押金状态", group: "INSTALLMENT", editable: false, options: [
    { value: "PAID", label: "已付" }, { value: "PARTIALLY_RETURNED", label: "部分退还" }, { value: "RETURNED", label: "已退" }, { value: "LOST", label: "已损失" }, { value: "CANCELLED", label: "已取消" },
  ] },
  { code: "IMPORT_BATCH_STATUS", label: "导入批次状态", group: "IMPORT", editable: false, options: [
    { value: "DRAFT", label: "草稿" }, { value: "MAPPED", label: "已映射" }, { value: "COMMITTED", label: "已确认" }, { value: "REJECTED", label: "已拒绝" }, { value: "ROLLED_BACK", label: "已回滚" }, { value: "CORRECTED", label: "已更正" },
  ] },
  { code: "IMPORT_SOURCE_KIND", label: "导入数据类型", group: "IMPORT", editable: false, options: [
    { value: "STANDARD_ORDER", label: "订单" }, { value: "STANDARD_ACCOUNT", label: "账号" }, { value: "STANDARD_CASHFLOW", label: "资金流水" }, { value: "STANDARD_INSTALLMENT", label: "分期" }, { value: "STANDARD_LEAD", label: "需求" },
  ] },
  { code: "POLICY_STATUS", label: "规则版本状态", group: "POLICY", editable: false, options: [
    { value: "DRAFT", label: "草稿" }, { value: "ACTIVE", label: "已发布" }, { value: "EXPIRED", label: "已失效" }, { value: "SUPERSEDED", label: "已被取代" },
  ] },
  { code: "POLICY_SCOPE_TYPE", label: "规则适用范围", group: "POLICY", editable: false, options: [
    { value: "GLOBAL", label: "全局" }, { value: "ORDER_TYPE", label: "按业务类型" }, { value: "USER", label: "按人员" }, { value: "POOL", label: "按资金池" },
  ] },
  { code: "QUALITY_STATUS", label: "质量问题状态", group: "QUALITY", editable: false, options: [
    { value: "OPEN", label: "待处理" }, { value: "IN_PROGRESS", label: "处理中" }, { value: "CLOSED", label: "已关闭" },
  ] },
  { code: "QUALITY_SEVERITY", label: "质量问题严重程度", group: "QUALITY", editable: true, options: [
    { value: "LOW", label: "低" }, { value: "MEDIUM", label: "中" }, { value: "HIGH", label: "高" }, { value: "CRITICAL", label: "严重" },
  ] },
  { code: "RECONCILIATION_STATUS", label: "日对账状态", group: "FUND", editable: false, options: [
    { value: "OPEN", label: "未核销" }, { value: "RESOLVED", label: "已核销" },
  ] },
  { code: "REBATE_STATUS", label: "返点状态", group: "FUND", editable: false, options: [
    { value: "OPEN", label: "未结算" }, { value: "PARTIALLY_SETTLED", label: "部分结算" }, { value: "SETTLED", label: "已结清" }, { value: "VOID", label: "失效" },
  ] },
  { code: "POOL_STATUS", label: "资金池状态", group: "FUND", editable: false, options: [
    { value: "ACTIVE", label: "进行中" }, { value: "DISABLED", label: "已停用" },
  ] },
  { code: "POOL_ACCOUNT_STATUS", label: "资金池账户状态", group: "FUND", editable: false, options: [
    { value: "ACTIVE", label: "启用" }, { value: "DISABLED", label: "停用" },
  ] },
  { code: "USER_ROLE", label: "用户角色", group: "SYSTEM", editable: false, options: [
    { value: "ADMIN", label: "系统管理员" }, { value: "OPERATOR", label: "业务经办人" }, { value: "FINANCE", label: "财务" }, { value: "AUDITOR", label: "审核人" }, { value: "VIEWER", label: "查看人" },
  ] },
  { code: "OWNER_SCOPE", label: "数据可见范围", group: "SYSTEM", editable: false, options: [
    { value: "SELF", label: "本人" }, { value: "TEAM", label: "团队" }, { value: "ALL", label: "全部" },
  ] },
];

/** 桩 optionSetsApi.list 返回完整种子，供库存/资金筛选器测试拿到筛选项。 */
export function seedOptionSets(catalog: {
  optionSetsApi: { list: (params?: { group?: string; editable?: boolean }) => unknown };
}): void {
  const payload = { items: OPTION_SET_SEED.map((s) => ({ id: 1, ...s })) };
  (catalog.optionSetsApi.list as unknown as { mockResolvedValue(value: unknown): void }).mockResolvedValue(payload);
}

