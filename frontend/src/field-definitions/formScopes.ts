/** 表单作用域：类型 + 降级兜底清单（非单一事实源）。
 *
 * 单一事实源在后端 app/orders/form_scopes.py，经 GET /order-form-fields/scopes
 * 下发（见 useFormScopes）。此文件只保留：
 *  - 类型定义与分组中文名；
 *  - 离线/接口异常时的降级兜底（与后端注册表同步维护，漂移时以接口为准）。
 */

export type FormScopeCode =
  | "HS" | "TH" | "DG" | "DFQ"
  | "ORDERCANC" | "ORDEREDIT" | "ORDERLINK" | "ALLOCATION" | "REFUND"
  | "SALE" | "CONSIGN" | "INVREBATE"
  | "INVREFUND" | "INVOID" | "INVCANCEL" | "INVEDIT"
  | "LEAD" | "LEADCLOSE" | "LEADCONVERT"
  | "CUSTOMER" | "COUNTERPARTY"
  | "INSTPAY" | "INSTRECOVER" | "INSTRESALE" | "INSTDELIVER" | "INSTCANCEL"
  | "INSTSETTLE" | "INSTDEFAULT" | "INSTWAIVE" | "INSTEXTEND"
  | "REBATE" | "REBSETTLE" | "REBREVERSE" | "REBATEVOID"
  | "FUNDDEPOSIT" | "FUNDFLOW" | "FUNDTRANSFER" | "FUNDRECON" | "FUNDCLEAR"
  | "FUNDREJECT" | "FUNDREVERSE" | "FUNDRELEASE" | "FUNDLOSS" | "FUNDREPAIR"
  | "FUNDLOCK" | "FUNDCANCEL"
  | "STUDIOEXP" | "STUDIOREJ" | "STUDIOREV";

import { useEffect, useState } from "react";
import { orderFormFieldsApi } from "../shared/api/catalog";

/** 作用域所属模块，设置面板按此分组展示。 */
export const FORM_SCOPE_GROUP_LABEL: Record<string, string> = {
  ORDER: "建单表单",
  ORDEROP: "订单操作",
  INVENTORY: "库存",
  INVOP: "库存操作",
  CUSTOMER: "客户",
  PARTY: "客户与合作方",
  INSTALLMENT: "分期",
  REBATE: "返点",
  FUND: "资金",
  STUDIO: "工作室",
};

/** 降级兜底清单：仅在 scopes 接口不可用时使用（与后端注册表 47 项对齐）。 */
export const FORM_SCOPES_FALLBACK: { code: FormScopeCode; label: string; group: string }[] = [
  { code: "HS", label: "回收建单", group: "ORDER" },
  { code: "TH", label: "提号建单", group: "ORDER" },
  { code: "DG", label: "代挂建单", group: "ORDER" },
  { code: "DFQ", label: "代分期建单", group: "ORDER" },
  { code: "ORDERCANC", label: "售出取消交易", group: "ORDEROP" },
  { code: "ORDEREDIT", label: "编辑订单", group: "ORDEROP" },
  { code: "ORDERLINK", label: "订单关联", group: "ORDEROP" },
  { code: "ALLOCATION", label: "订单分润", group: "ORDEROP" },
  { code: "REFUND", label: "登记退款", group: "ORDEROP" },
  { code: "SALE", label: "库存售出", group: "INVENTORY" },
  { code: "CONSIGN", label: "寄售", group: "INVENTORY" },
  { code: "INVREBATE", label: "库存返点", group: "INVENTORY" },
  { code: "INVREFUND", label: "库存取消交易", group: "INVOP" },
  { code: "INVOID", label: "下架登记", group: "INVOP" },
  { code: "INVCANCEL", label: "分期取消交易", group: "INVOP" },
  { code: "INVEDIT", label: "编辑账号及执行明细", group: "INVOP" },
  { code: "LEAD", label: "客户需求池", group: "CUSTOMER" },
  { code: "LEADCLOSE", label: "关闭需求", group: "CUSTOMER" },
  { code: "LEADCONVERT", label: "需求转单", group: "CUSTOMER" },
  { code: "CUSTOMER", label: "客户建档", group: "PARTY" },
  { code: "COUNTERPARTY", label: "合作方建档", group: "PARTY" },
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
  { code: "REBATEVOID", label: "作废返点", group: "REBATE" },
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
  { code: "FUNDCANCEL", label: "取消押金", group: "FUND" },
  { code: "STUDIOEXP", label: "工作室收支登记", group: "STUDIO" },
  { code: "STUDIOREJ", label: "工作室拒绝", group: "STUDIO" },
  { code: "STUDIOREV", label: "工作室冲销", group: "STUDIO" },
];

/** 兜底标签映射（表单内可能用到的静态回退）。 */
export const FORM_SCOPE_LABEL: Record<string, string> = Object.fromEntries(
  FORM_SCOPES_FALLBACK.map((scope) => [scope.code, scope.label]),
);

export type FormScopeRow = { code: string; label: string; group: string };

/** 从后端拉取作用域注册表；失败返回 null（调用方回落 FORM_SCOPES_FALLBACK）。 */
export function useFormScopes(): { scopes: FormScopeRow[] | null; loading: boolean } {
  const [scopes, setScopes] = useState<FormScopeRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    orderFormFieldsApi
      .scopes()
      .then((rows) => { if (!cancelled) setScopes(rows); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  return { scopes, loading };
}

/** 按模块分组生成下拉选项；scopes 传接口返回值（为空时用兜底清单）。 */
export function buildGroupedScopeOptions(
  scopes: { code: string; label: string; group: string }[] | null | undefined,
): { label: string; options: { value: string; label: string }[] }[] {
  const list = scopes && scopes.length > 0 ? scopes : FORM_SCOPES_FALLBACK;
  const groups: string[] = [];
  const byGroup = new Map<string, { value: string; label: string }[]>();
  for (const scope of list) {
    if (!byGroup.has(scope.group)) {
      byGroup.set(scope.group, []);
      groups.push(scope.group);
    }
    byGroup.get(scope.group)!.push({ value: scope.code, label: scope.label });
  }
  return groups.map((group) => ({
    label: FORM_SCOPE_GROUP_LABEL[group] ?? group,
    options: byGroup.get(group)!,
  }));
}
