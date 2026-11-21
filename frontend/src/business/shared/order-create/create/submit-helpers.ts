import { today } from "../../../../shared/lib/format";
import type { FieldConfigMap } from "../../../../shared/forms/ConfigurableField";

/** 建单表单值。字段由后端表单配置驱动，故保持 Record 形态。 */
type Values = Record<string, unknown>;

/** 账号自定义字段（ACCOUNT_PRODUCT）归集到 account_snapshot，其余留在订单 form_extra。 */
export function splitFormExtra(values: Values, config: FieldConfigMap) {
  const formExtra = (values.form_extra as Record<string, unknown> | undefined) ?? {};
  const hasValue = (value: unknown) => value !== undefined
    && value !== null
    && value !== ""
    && !(Array.isArray(value) && value.length === 0);
  const accountExtraKeys = new Set(
    Object.values(config)
      .filter((field) => field.is_custom && field.is_active && field.section === "ACCOUNT_PRODUCT")
      .map((field) => field.field_key),
  );
  const accountExtraValues = Object.fromEntries(
    Object.entries(formExtra).filter(([key, value]) => accountExtraKeys.has(key) && hasValue(value)),
  );
  const orderFormExtra = Object.fromEntries(
    Object.entries(formExtra).filter(([key, value]) => !accountExtraKeys.has(key) && hasValue(value)),
  );
  for (const key of ["business_responsible_ids", "delivery_responsible_ids"]) {
    const responsibleIds = Array.isArray(values[key])
      ? values[key].filter((id): id is number => typeof id === "number")
      : [];
    if (responsibleIds.length > 0) orderFormExtra[key] = responsibleIds;
  }
  // 交付信息随订单持久化：交易平台 / 中介类型 / 包赔类型 / 手机号绑定人。
  // 与 delivery_responsible_ids 同口径写入 form_extra，供订单详情回显
  // （账号实体与 account_snapshot 均未回传 bound_phone_owner，详情改读 extra_values）。
  for (const key of ["intermediary_platform", "intermediary_type", "compensation_type", "bound_phone_owner"]) {
    const v = values[key];
    if (v !== undefined && v !== null && v !== "") orderFormExtra[key] = v;
  }
  if (values.intermediary_platform === "其他" && hasValue(values.intermediary_platform_other)) {
    orderFormExtra.intermediary_platform_other = values.intermediary_platform_other;
  } else {
    delete orderFormExtra.intermediary_platform_other;
  }
  return { accountExtraValues, orderFormExtra };
}

/** 客户来源「其他」取用户填写的其他值；DG 订单字段带 dg_ 前缀。 */
export function resolveCustomerSource(values: Values, isDg: boolean): string | undefined {
  const customerSourceField = isDg ? "dg_customer_source" : "customer_source";
  const customerSourceOtherField = isDg ? "dg_customer_source_other" : "customer_source_other";
  const selected = values[customerSourceField] as string | undefined;
  if (selected !== "其他") return selected;
  return String(values[customerSourceOtherField] ?? "").trim() || selected;
}

/** 订单备注：HS/DG 汇总客户来源，TH 汇总供货方备注，其余取原备注。 */
export function buildOrderNote(
  values: Values,
  kind: { isRecovery: boolean; isTh: boolean; isDg: boolean },
  resolvedCustomerSource: string | undefined,
): string | undefined {
  if ((kind.isRecovery || kind.isDg) && resolvedCustomerSource) {
    const tail = values[kind.isDg ? "dg_note" : "note"];
    return `客户来源：${String(resolvedCustomerSource)}${tail ? `｜${String(tail)}` : ""}`;
  }
  if (kind.isTh) {
    return [
      values.game_account_note as string,
      values.supplier_note as string,
    ].filter(Boolean).join("｜") || undefined;
  }
  return values[kind.isDg ? "dg_note" : "note"] as string;
}

/** 建单客户草稿：由订单接口在同一事务内复用已有客户或新建档案。 */
export function buildCustomerInput(args: {
  values: Values;
  isRecovery: boolean;
  isDg: boolean;
  resolvedCustomerSource: string | undefined;
}) {
  const { values, isRecovery, isDg, resolvedCustomerSource } = args;
  const customerPrefix = isDg ? "dg_" : "";
  const customerNickname = String(values[`${customerPrefix}customer_nickname`] ?? "").trim();
  if (!(isRecovery || isDg) || !customerNickname) return undefined;
  return {
    display_name: customerNickname,
    role: isRecovery ? "SELLER" : "CONSIGNOR",
    contact_name: values[isDg ? "dg_customer_contact" : "customer_contact_name"] as string | undefined,
    phone: values[`${customerPrefix}customer_phone`] as string | undefined,
    wechat: values[`${customerPrefix}customer_wechat`] as string | undefined,
    qq: values[`${customerPrefix}customer_qq`] as string | undefined,
    source: resolvedCustomerSource,
    note: (isDg ? values.dg_note : values.note) as string | undefined,
  };
}

/** 建单供货方草稿：由订单接口在同一事务内复用已有合作方或新建档案。 */
export function buildCounterpartyInput(args: {
  values: Values;
  isTh: boolean;
}) {
  const { values, isTh } = args;
  const nickname = String(values.supplier_nickname ?? "").trim();
  if (!isTh || !nickname) return undefined;
  return {
    display_name: nickname,
    type: "PEER",
    role: "PEER",
    contact_name: values.supplier_contact_name as string,
    phone: values.supplier_phone as string,
    wechat: values.supplier_wechat as string,
    qq: values.supplier_qq as string,
    note: [
      values.supplier_note as string,
    ].filter(Boolean).join("｜") || undefined,
  };
}

/** 建单时的随单成本（自定义支出项），仅 HS/TH 有。 */
export function buildInitialCosts(values: Values, isRecovery: boolean, isTh: boolean) {
  if (!isRecovery && !isTh) return [];
  return [
    ...((values.expense_items as Array<{ amount?: unknown; note?: unknown }> | undefined) ?? [])
      .filter((item) => Number(item.amount) > 0)
      .map((item) => ({
        amount: String(item.amount), occurred_on: today(), portion: "PRINCIPAL",
        pool_id: values.payment_pool_id as number, flow_category: "OTHER",
        note: String(item.note ?? "") || "支出",
      })),
  ];
}

/** 账号资料统一走 account_snapshot（后端据此内联建库存账号并发放 KU_ 编号）。 */
export function buildAccountSnapshot(values: Values, accountExtraValues: Record<string, unknown>) {
  return {
    game_account: values.game_account as string,
    game_type: values.game_type as string | undefined,
    game_password: values.game_password as string | undefined,
    channel_region: values.channel_region as string | undefined,
    bound_phone: values.bound_phone as string | undefined,
    bound_phone_owner: values.bound_phone_owner as string | undefined,
    has_secondary: values.has_secondary === "有" ? true : values.has_secondary === "无" ? false : undefined,
    // 二次图片只在「有二次」时随号入库；无二次时表单残留不提交。
    secondary_images: values.has_secondary === "有"
      ? ((values.secondary_images as string[] | undefined)?.length ? values.secondary_images as string[] : undefined)
      : undefined,
    wallet_realname: values.wallet_realname as string | undefined,
    // 钱包实名注销佐证图：仅「已注销」时随号入库。
    wallet_realname_images: values.wallet_realname === "已注销"
      ? ((values.wallet_realname_images as string[] | undefined)?.length ? values.wallet_realname_images as string[] : undefined)
      : undefined,
    camp_account: values.camp_account as string | undefined,
    note: values.game_account_note as string | undefined,
    extra_values: Object.keys(accountExtraValues).length ? accountExtraValues : undefined,
  };
}

/** 建单时的首笔买入流水，仅 HS/TH 有。 */
export function buildInitialBuy(values: Values, isRecovery: boolean, isTh: boolean) {
  if (!isRecovery && !isTh) return undefined;
  return {
    amount: String((isRecovery ? values.recovery_price : values.th_purchase_amount) ?? 0),
    occurred_on: today(), portion: "PRINCIPAL", pool_id: values.payment_pool_id as number,
    note: isRecovery ? "回收价" : "提号",
  };
}
