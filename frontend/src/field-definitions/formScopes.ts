/** 表单作用域注册表：可配置字段的「表单」清单（单一事实源）。
 *
 * 后端 OrderFormField.order_type_code 是长度 2-16 的大写字母数字自由字符串，
 * 这里把它泛化为「表单作用域码」：建单表单 4 个 + 其余业务表单 29 个。
 * 设置面板与业务表单都从此处取码，避免两处各写一份清单而漂移。
 */

export type FormScopeCode =
  | "HS" | "TH" | "DG" | "DFQ"
  | "SALE" | "CONSIGN" | "INVREBATE"
  | "LEAD" | "LEADCLOSE" | "LEADCONVERT"
  | "INSTPAY" | "INSTRECOVER" | "INSTRESALE" | "INSTDELIVER" | "INSTCANCEL"
  | "INSTSETTLE" | "INSTDEFAULT" | "INSTWAIVE" | "INSTEXTEND"
  | "REBATE" | "REBSETTLE" | "REBREVERSE"
  | "FUNDDEPOSIT" | "FUNDFLOW" | "FUNDTRANSFER" | "FUNDRECON" | "FUNDCLEAR"
  | "FUNDREJECT" | "FUNDREVERSE" | "FUNDRELEASE" | "FUNDLOSS" | "FUNDREPAIR"
  | "FUNDLOCK";

/** 作用域所属模块，设置面板按此分组展示。 */
export const FORM_SCOPE_GROUP_LABEL: Record<string, string> = {
  ORDER: "建单表单",
  INVENTORY: "库存",
  CUSTOMER: "客户",
  INSTALLMENT: "分期",
  REBATE: "返点",
  FUND: "资金",
};

/** 作用域清单：code / 中文名 / 所属模块。与后端迁移种子一一对应。 */
export const FORM_SCOPES: { code: FormScopeCode; label: string; group: string }[] = [
  { code: "HS", label: "回收建单", group: "ORDER" },
  { code: "TH", label: "提号建单", group: "ORDER" },
  { code: "DG", label: "代挂建单", group: "ORDER" },
  { code: "DFQ", label: "代分期建单", group: "ORDER" },

  { code: "SALE", label: "库存售出", group: "INVENTORY" },
  { code: "CONSIGN", label: "寄售", group: "INVENTORY" },
  { code: "INVREBATE", label: "库存返点", group: "INVENTORY" },

  { code: "LEAD", label: "客户需求池", group: "CUSTOMER" },
  { code: "LEADCLOSE", label: "关闭需求", group: "CUSTOMER" },
  { code: "LEADCONVERT", label: "需求转单", group: "CUSTOMER" },

  { code: "INSTPAY", label: "分期收款", group: "INSTALLMENT" },
  { code: "INSTRECOVER", label: "分期回收", group: "INSTALLMENT" },
  { code: "INSTRESALE", label: "分期出售登记", group: "INSTALLMENT" },
  { code: "INSTDELIVER", label: "交付换绑", group: "INSTALLMENT" },
  { code: "INSTCANCEL", label: "取消退款", group: "INSTALLMENT" },
  { code: "INSTSETTLE", label: "提前结清", group: "INSTALLMENT" },
  { code: "INSTDEFAULT", label: "违约登记", group: "INSTALLMENT" },
  { code: "INSTWAIVE", label: "减免", group: "INSTALLMENT" },
  { code: "INSTEXTEND", label: "展期", group: "INSTALLMENT" },

  { code: "REBATE", label: "新建返点", group: "REBATE" },
  { code: "REBSETTLE", label: "返点结算", group: "REBATE" },
  { code: "REBREVERSE", label: "返点冲销", group: "REBATE" },

  { code: "FUNDDEPOSIT", label: "押金占用", group: "FUND" },
  { code: "FUNDFLOW", label: "录入流水", group: "FUND" },
  { code: "FUNDTRANSFER", label: "资金划转", group: "FUND" },
  { code: "FUNDRECON", label: "对账", group: "FUND" },
  { code: "FUNDCLEAR", label: "核销", group: "FUND" },
  { code: "FUNDREJECT", label: "拒绝", group: "FUND" },
  { code: "FUNDREVERSE", label: "资金冲销", group: "FUND" },
  { code: "FUNDRELEASE", label: "释放", group: "FUND" },
  { code: "FUNDLOSS", label: "损失", group: "FUND" },
  { code: "FUNDREPAIR", label: "划转修复", group: "FUND" },
  { code: "FUNDLOCK", label: "月结锁定", group: "FUND" },
];

export const FORM_SCOPE_LABEL: Record<string, string> = Object.fromEntries(
  FORM_SCOPES.map((scope) => [scope.code, scope.label]),
);

/** 设置面板下拉用的分组选项（按模块分组，可扩展到任意多个作用域）。 */
export const FORM_SCOPE_GROUPED_OPTIONS = Object.entries(FORM_SCOPE_GROUP_LABEL).map(
  ([group, groupLabel]) => ({
    label: groupLabel,
    options: FORM_SCOPES.filter((scope) => scope.group === group).map((scope) => ({
      value: scope.code,
      label: scope.label,
    })),
  }),
);
