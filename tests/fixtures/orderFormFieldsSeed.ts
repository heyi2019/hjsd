/** 测试用订单表单字段种子，与当前 ORM 基线的订单字段口径一致。 */
import type { OrderFormField } from "@/shared/api/types/forms";
import { orderFormFieldsApi } from "@/shared/api/orders.api";
import { customerSourceOptions, intermediaryPlatformOptions } from "@fixtures/catalogOptions";

type SeedDef = {
  key: string;
  label: string;
  type: "SELECT" | "MULTI_SELECT" | "TEXT" | "NUMBER" | "DATE" | "BOOLEAN";
  options: Array<{ value: string; label: string }>;
  required?: boolean;
};

const SCOPE_SEED: Record<string, SeedDef[]> = {
  HS: [
    { key: "has_secondary", label: "有无二次", type: "SELECT", options: [{ value: "有", label: "有" }, { value: "无", label: "无" }] },
    { key: "customer_source", label: "客户来源", type: "SELECT", options: customerSourceOptions },
    { key: "intermediary_platform", label: "交易平台", type: "SELECT", options: intermediaryPlatformOptions },
    { key: "intermediary_type", label: "中介类型", type: "SELECT", options: [{ value: "普中", label: "普中" }, { value: "包赔", label: "包赔" }] },
    { key: "compensation_type", label: "包赔类型", type: "SELECT", options: [{ value: "首保", label: "首保" }, { value: "续保", label: "续保" }] },
  ],
  DG: [
    { key: "has_secondary", label: "有无二次", type: "SELECT", options: [{ value: "有", label: "有" }, { value: "无", label: "无" }] },
    { key: "dg_customer_source", label: "客户来源", type: "SELECT", options: customerSourceOptions },
  ],
  TH: [
    { key: "has_secondary", label: "有无二次", type: "SELECT", options: [{ value: "有", label: "有" }, { value: "无", label: "无" }] },
    { key: "customer_source", label: "客户来源", type: "SELECT", options: customerSourceOptions },
    { key: "intermediary_platform", label: "交易平台", type: "SELECT", options: intermediaryPlatformOptions },
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
        { value: "SERVICE_REVENUE", label: "增值服务收入" },
        { value: "ADDITIONAL_INCOME", label: "附加收入" },
        { value: "ADDITIONAL_EXPENSE", label: "附加支出" },
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
};

/** 展开为全部 OrderFormField 行（按 scope 维度），供测试默认种子使用。 */
export function allFormFields(): OrderFormField[] {
  const rows: OrderFormField[] = [];
  let id = 1;
  for (const [scope, defs] of Object.entries(SCOPE_SEED)) {
    defs.forEach((def, idx) => {
      rows.push({
        id: id++,
        order_type_code: scope,
        field_key: def.key,
        label: def.label,
        field_type: def.type,
        options: def.options.map((option) => ({ ...option })),
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
export function seedOrderFormFields(): void {
  const all = allFormFields();
  (orderFormFieldsApi.list as unknown as { mockResolvedValue(value: unknown): void }).mockResolvedValue(all);
}


