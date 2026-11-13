import { appMessage } from "../shared/ui/appFeedback";
import { counterpartiesApi, customersApi } from "../shared/api/customers.api";
import type { Counterparty, Customer } from "../shared/api/types/customers";
import { today } from "../shared/lib/format";
import type { FieldConfigMap } from "./ConfigurableField";

/** 建单表单值。字段由后端表单配置驱动，故保持 Record 形态。 */
type Values = Record<string, unknown>;

/** 账号自定义字段（ACCOUNT_PRODUCT）归集到 account_snapshot，其余留在订单 form_extra。 */
export function splitFormExtra(values: Values, config: FieldConfigMap) {
  const formExtra = (values.form_extra as Record<string, unknown> | undefined) ?? {};
  const accountExtraKeys = new Set(
    Object.values(config)
      .filter((field) => field.is_custom && field.is_active && field.section === "ACCOUNT_PRODUCT")
      .map((field) => field.field_key),
  );
  const accountExtraValues = Object.fromEntries(
    Object.entries(formExtra).filter(([key, value]) => accountExtraKeys.has(key) && value !== undefined && value !== ""),
  );
  const orderFormExtra = Object.fromEntries(
    Object.entries(formExtra).filter(([key]) => !accountExtraKeys.has(key)),
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
  return { accountExtraValues, orderFormExtra };
}

/** 客户来源「其他」取用户填写的其他值；DG 订单字段带 dg_ 前缀。 */
export function resolveCustomerSource(values: Values, isDg: boolean): string | undefined {
  const customerSourceField = isDg ? "dg_customer_source" : "customer_source";
  const customerSourceOtherField = isDg ? "dg_customer_source_other" : "customer_source_other";
  const selected = values[customerSourceField] as string | undefined;
  return selected === "其他" ? values[customerSourceOtherField] as string : selected;
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
  return values.note as string;
}

/**
 * 客户解析/建档：仅 HS/DG 且填写了客户昵称时生效。
 * 客户列表默认脱敏，掩码联系方式不可与用户输入的明文做等值比较，故脱敏客户只在
 * 「昵称相同且未填联系方式」时本地复用；填了联系方式交给后端明文判重兜底。
 * 返回 undefined 表示不需要写 values.customer_id。
 */
export async function resolveCustomerId(args: {
  values: Values;
  customers: Customer[];
  isRecovery: boolean;
  isDg: boolean;
  resolvedCustomerSource: string | undefined;
}): Promise<number | undefined> {
  const { values, customers, isRecovery, isDg, resolvedCustomerSource } = args;
  const customerPrefix = isDg ? "dg_" : "";
  const customerNickname = values[`${customerPrefix}customer_nickname`];
  if (!(isRecovery || isDg) || !customerNickname) return undefined;
  const inputPhone = values[`${customerPrefix}customer_phone`] as string | undefined;
  const inputWechat = values[`${customerPrefix}customer_wechat`] as string | undefined;
  const existingCustomer = customers.find((customer) => {
    if (customer.display_name !== customerNickname) return false;
    if (customer.contact_masked) return !inputPhone && !inputWechat;
    return (inputPhone && customer.phone === inputPhone)
      || (inputWechat && customer.wechat === inputWechat)
      || (!inputPhone && !inputWechat);
  });
  if (existingCustomer) return existingCustomer.id;
  const created = await customersApi.create({
    display_name: customerNickname as string,
    contact_name: values[isDg ? "dg_customer_contact" : "customer_contact_name"] as string,
    phone: inputPhone,
    wechat: inputWechat,
    qq: values[`${customerPrefix}customer_qq`] as string,
    source: resolvedCustomerSource as string,
    note: (isDg ? values.dg_note : values.note) as string,
  });
  const sameContact = (created.duplicate_candidates ?? []).find(
    (candidate) => candidate.display_name === customerNickname
      || candidate.matched_on?.length,
  );
  if (sameContact) {
    // 后端用明文联系方式命中了已有客户：复用它，避免同一客户被拆成两条档案。
    appMessage.info(`已关联到同名/同联系方式的已有客户 ${sameContact.customer_no}`);
    return sameContact.customer_id;
  }
  return created.customer.id;
}

/** 供货方解析/建档：仅 TH 且填写供货方昵称时生效；TH 的参与方角色恒为 PEER。 */
export async function resolveCounterpartyId(args: {
  values: Values;
  counterparties: Counterparty[];
  isTh: boolean;
}): Promise<number | undefined> {
  const { values, counterparties, isTh } = args;
  if (!isTh || !values.supplier_nickname) return values.counterparty_id as number | undefined;
  // TH 的业务角色是同行（PEER）；页面仍以"供货方"展示业务称呼。
  // 后端按订单参与方契约校验 TH 只能使用 PEER。
  const role = "PEER";
  const existing = counterparties.find((item) =>
    item.display_name === values.supplier_nickname && item.type === role,
  );
  const counterparty = existing ?? await counterpartiesApi.create({
    display_name: values.supplier_nickname as string,
    type: role,
    contact_name: values.supplier_contact_name as string,
    phone: values.supplier_phone as string,
    wechat: values.supplier_wechat as string,
    qq: values.supplier_qq as string,
    note: [
      values.supplier_note as string,
    ].filter(Boolean).join("｜") || undefined,
  });
  return counterparty.id;
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
