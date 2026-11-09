/** 表单作用域只来自后端注册表 GET /order-form-fields/scopes。 */

import { useEffect, useState } from "react";
import { orderFormFieldsApi } from "../shared/api/catalog";

/** 作用域所属模块，设置面板按此分组展示。 */
export const FORM_SCOPE_GROUP_LABEL: Record<string, string> = {
  ORDER: "建单表单",
  ORDEROP: "订单操作",
  INVENTORY: "库存中心",
  INVOP: "库存操作",
  CUSTOMER: "客户",
  PARTY: "客户与合作伙伴",
  INSTALLMENT: "分期与回款",
  FUND: "资金",
  STUDIO: "工作室",
};

export type FormScopeRow = { code: string; label: string; group: string };

/** 从后端拉取作用域注册表；接口失败时保持空列表，不伪造本地定义。 */
export function useFormScopes(): { scopes: FormScopeRow[]; loading: boolean } {
  const [scopes, setScopes] = useState<FormScopeRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    orderFormFieldsApi
      .scopes()
      .then((rows) => { if (!cancelled) setScopes(rows); })
      .catch(() => { if (!cancelled) setScopes([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  return { scopes, loading };
}

/** 按模块分组生成下拉选项；输入即后端注册表，不额外补造作用域。 */
export function buildGroupedScopeOptions(
  scopes: { code: string; label: string; group: string }[],
): { label: string; options: { value: string; label: string }[] }[] {
  const orderedList = scopes;
  const groups: string[] = [];
  const byGroup = new Map<string, { value: string; label: string }[]>();
  for (const scope of orderedList) {
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
